import { OGMError } from '../errors';
import { isReadRestrictive } from '../policy/types';
import type { PolicyContextBundle } from '../policy/types';
import {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../schema/types';
import {
  buildRelPattern,
  getTargetLabelString,
  resolveTargetDef,
} from '../schema/utils';
import { CypherFieldScope } from '../utils/cypher-field-projection';
import {
  assertSafeIdentifier,
  assertSafeKey,
  escapeIdentifier,
  isPlainObject,
  mergeParams,
} from '../utils/validation';

export interface WhereResult {
  cypher: string;
  params: Record<string, unknown>;
  /**
   * Pre-WHERE lines (`CALL { ... }` + `WITH ...` pairs) needed to resolve
   * any `@cypher` scalar fields referenced at the TOP level of this where
   * input. The caller MUST emit these between the MATCH and the WHERE
   * clause; otherwise the compiled body references aliases that are not
   * in scope and Neo4j will fail.
   *
   * Preludes for nested scopes (e.g. `r0` inside a `_SOME` quantifier)
   * are stitched directly into the EXISTS body inside `cypher` — the
   * caller never has to handle those.
   */
  preludes?: string[];
}

const MAX_DEPTH = 10;

/**
 * Hard cap on the length of an `AND` / `OR` clause array. Prevents an
 * attacker (or a buggy caller) from inducing pathological Cypher
 * emission by passing thousands of nested clauses — every entry costs
 * a recursion frame, a parameter slot, and a Cypher AST node, so
 * unbounded arrays are a practical DoS vector. 256 is well above any
 * legitimate use; if you need more, you almost certainly want a
 * different filter shape (`_IN`, a relationship traversal, etc.).
 */
const MAX_LOGICAL_ARRAY_LENGTH = 256;

/**
 * Declarative operator definition. Use `%f` for (possibly case-insensitive) field
 * reference, `%rf` for raw field reference, `%p` for (possibly case-insensitive)
 * parameter reference, and `%rp` for raw parameter reference.
 */
interface OperatorDef {
  template: string;
  /** Whether this operator supports case-insensitive mode (toLower wrapping). */
  ciAware: boolean;
}

/**
 * Operator registry — adding a new scalar operator is a single entry here.
 * Ordered longest-suffix-first so greedy matching works.
 */
const OPERATOR_REGISTRY: ReadonlyArray<[string, OperatorDef]> = [
  ['_NOT_STARTS_WITH', { template: 'NOT %f STARTS WITH %p', ciAware: true }],
  ['_NOT_ENDS_WITH', { template: 'NOT %f ENDS WITH %p', ciAware: true }],
  ['_NOT_CONTAINS', { template: 'NOT %f CONTAINS %p', ciAware: true }],
  ['_NOT_IN', { template: 'NOT %rf IN %rp', ciAware: false }],
  ['_STARTS_WITH', { template: '%f STARTS WITH %p', ciAware: true }],
  ['_ENDS_WITH', { template: '%f ENDS WITH %p', ciAware: true }],
  ['_CONTAINS', { template: '%f CONTAINS %p', ciAware: true }],
  ['_MATCHES', { template: '%rf =~ %rp', ciAware: false }],
  ['_GTE', { template: '%rf >= %rp', ciAware: false }],
  ['_LTE', { template: '%rf <= %rp', ciAware: false }],
  ['_NOT', { template: '%f <> %p', ciAware: true }],
  ['_GT', { template: '%rf > %rp', ciAware: false }],
  ['_LT', { template: '%rf < %rp', ciAware: false }],
  ['_IN', { template: '%rf IN %rp', ciAware: false }],
];

/** Fast lookup by suffix */
const OPERATOR_MAP = new Map<string, OperatorDef>(OPERATOR_REGISTRY);

/** Ordered list of suffixes for greedy matching */
const OPERATOR_SUFFIXES = OPERATOR_REGISTRY.map(([s]) => s);

type OperatorSuffix = string;

// Order matters for greedy suffix matching: `_NOT` must come AFTER any
// scalar operator suffix that contains `_NOT` (e.g. `_NOT_IN`,
// `_NOT_CONTAINS`). Those are not in this list — they belong to the
// scalar OPERATOR_REGISTRY — but iteration order here is still safe
// because we only return a match when `fieldName` resolves to an actual
// relationship in `nodeDef.relationships` (see `tryCompileRelationship`).
const RELATIONSHIP_SUFFIXES = [
  '_SOME',
  '_NONE',
  '_ALL',
  '_SINGLE',
  '_NOT',
] as const;
type RelationshipSuffix = (typeof RELATIONSHIP_SUFFIXES)[number];

const CONNECTION_SUFFIXES = [
  'Connection_SOME',
  'Connection_NONE',
  'Connection_ALL',
  'Connection_SINGLE',
  'Connection_NOT',
  'Connection',
] as const;

type ConnectionSuffix = (typeof CONNECTION_SUFFIXES)[number];

export interface WhereCompilerOptions {
  /** Set of operator suffixes to reject at runtime (e.g. `new Set(['_MATCHES'])`) */
  disabledOperators?: Set<OperatorSuffix>;
  /**
   * When `true`, the compiler throws `OGMError` if a `where` clause
   * references a field name that is not declared on the target type.
   * Default: `false` — preserves pre-1.7.5 behaviour where typo'd
   * field names compiled to `n.<typo> = $param` and silently produced
   * empty results. Opt in via `OGMConfig.features.strictWhere = true`.
   */
  strictWhere?: boolean;
}

/**
 * Compiles a Where input object into a Cypher WHERE clause fragment + params.
 */
export class WhereCompiler {
  private disabledOperators: Set<OperatorSuffix>;
  private strictWhere: boolean;

  constructor(
    private schema: SchemaMetadata,
    options?: WhereCompilerOptions,
  ) {
    this.disabledOperators = options?.disabledOperators ?? new Set();
    this.strictWhere = options?.strictWhere ?? false;
  }

  compile(
    where: Record<string, unknown> | undefined | null,
    nodeVar: string,
    nodeDef: NodeDefinition,
    paramCounter: { count: number } = { count: 0 },
    options?: {
      /**
       * Vars already in the surrounding pipeline that every emitted `WITH`
       * must carry forward (e.g. `score` for vector search, `__typename`
       * for `InterfaceModel`). Without this, the WITH inside the prelude
       * would drop those vars and downstream RETURN/ORDER BY breaks.
       */
      preserveVars?: ReadonlyArray<string>;
      /**
       * Policy context for this query. When present, the resolved
       * permissive/restrictive set is AND-stitched into the compiled
       * body sharing the same `paramCounter` and prelude scope.
       *
       * If `resolved.overridden` is true, this is a no-op (byte-
       * identical to no-policy emission). When `resolved` is empty
       * AND `defaults.onDeny === 'empty'`, the policy clause becomes
       * `false` (default-deny). When `'throw'`, the call site is
       * responsible for rejecting BEFORE compile — see `Model`.
       */
      policyContext?: PolicyContextBundle;
    },
  ): WhereResult {
    const hasUserWhere = where != null && Object.keys(where).length > 0;
    const policyContext = options?.policyContext;
    const policyActive =
      policyContext !== undefined && !policyContext.resolved.overridden;

    if (!hasUserWhere && !policyActive) return { cypher: '', params: {} };

    // Top-level scope — preludes here are returned to the caller for stitching
    // BEFORE the WHERE clause. Nested scopes (relationship quantifiers) build
    // their own scopes and stitch their preludes into the EXISTS body inline.
    const scope = new CypherFieldScope(
      nodeVar,
      options?.preserveVars ?? [],
      '__where',
    );
    const userBody = hasUserWhere
      ? this.compileConditions(where, nodeVar, nodeDef, paramCounter, 0, scope)
      : { cypher: '', params: {} as Record<string, unknown> };

    let cypher = userBody.cypher;
    const params = { ...userBody.params };

    if (policyActive) {
      const policyClause = this.compilePolicyClause(
        policyContext!,
        nodeVar,
        nodeDef,
        paramCounter,
        scope,
        params,
      );
      cypher = stitchUserAndPolicy(cypher, policyClause);
    }

    const result: WhereResult = {
      cypher,
      params,
    };
    if (scope.hasAny()) result.preludes = scope.emit();
    return result;
  }

  /**
   * Compile the policy clause for a single (typeName, op) frame. AND-
   * stitches into the user's body via `stitchUserAndPolicy`. Shares the
   * same `paramCounter` and `scope` as the user where so that nothing
   * collides downstream.
   *
   * Permissive `cypher.params` keys are namespaced with `policy_p<n>_`
   * to guarantee no collision with `param0..N`.
   */
  private compilePolicyClause(
    bundle: PolicyContextBundle,
    nodeVar: string,
    nodeDef: NodeDefinition,
    paramCounter: { count: number },
    scope: CypherFieldScope,
    paramsTarget: Record<string, unknown>,
  ): string {
    const { ctx, resolved, defaults, operation } = bundle;

    const permFrags: string[] = [];
    let policyParamIdx = 0;

    for (const p of resolved.permissives) {
      // `when` returns a where-partial — compile it through the same
      // pipeline so every existing operator/quantifier just works.
      if (p.when) {
        const partial = p.when(ctx);
        if (partial && Object.keys(partial).length > 0) {
          const compiled = this.compileConditions(
            partial,
            nodeVar,
            nodeDef,
            paramCounter,
            0,
            scope,
          );
          if (compiled.cypher) {
            permFrags.push(`(${compiled.cypher})`);
            mergeParams(paramsTarget, compiled.params);
          }
        } else if (partial && Object.keys(partial).length === 0)
          // Empty partial means "match everything" — equivalent to true.
          permFrags.push('true');
      }

      // `cypher` escape hatch — raw fragment + parameterized params
      // namespaced with `policy_p<idx>_`.
      if (p.cypher) {
        const fragment = p.cypher.fragment(ctx, { node: nodeVar });
        if (typeof fragment !== 'string')
          throw new OGMError(
            `permissive cypher.fragment must return a string (policy "${p.name ?? 'permissive'}").`,
          );
        if (fragment.length > 0) {
          const rawParams = p.cypher.params(ctx) ?? {};
          const namespaced = namespacePolicyParams(
            rawParams,
            `policy_p${policyParamIdx++}_`,
          );
          mergeParams(paramsTarget, namespaced.values);
          permFrags.push(
            `(${rewritePolicyFragment(fragment, namespaced.map)})`,
          );
        }
      }
    }

    const restFrags: string[] = [];
    for (const p of resolved.restrictives) {
      // Only ReadRestrictive policies participate in the WHERE clause.
      // WriteRestrictive policies (create/update) are evaluated at the
      // application layer in Model.* — calling their `(ctx, input)`
      // `when` here with no input would silently mis-evaluate.
      if (!isReadRestrictive(p)) continue;
      // Compile-time gate. If `appliesWhen(ctx)` is false, the policy
      // contributes nothing to this query — same semantics as a
      // dropped permissive.
      if (p.appliesWhen && !p.appliesWhen(ctx)) continue;

      if (p.when) {
        // ReadRestrictive `when` may return a where-partial OR boolean.
        const partial = p.when(ctx);
        if (partial === false)
          // Hard deny — compiles to `false` and short-circuits the
          // restrictive AND chain.
          restFrags.push('false');
        else if (partial && typeof partial === 'object') {
          const obj = partial as Record<string, unknown>;
          if (Object.keys(obj).length > 0) {
            const compiled = this.compileConditions(
              obj,
              nodeVar,
              nodeDef,
              paramCounter,
              0,
              scope,
            );
            if (compiled.cypher) {
              restFrags.push(`(${compiled.cypher})`);
              mergeParams(paramsTarget, compiled.params);
            }
          }
        }
      }
      if (p.cypher) {
        const fragment = p.cypher.fragment(ctx, { node: nodeVar });
        if (typeof fragment !== 'string')
          throw new OGMError(
            `restrictive cypher.fragment must return a string (policy "${p.name ?? 'restrictive'}").`,
          );
        if (fragment.length > 0) {
          const rawParams = p.cypher.params(ctx) ?? {};
          const namespaced = namespacePolicyParams(
            rawParams,
            `policy_p${policyParamIdx++}_`,
          );
          mergeParams(paramsTarget, namespaced.values);
          restFrags.push(
            `(${rewritePolicyFragment(fragment, namespaced.map)})`,
          );
        }
      }
    }

    // Default-deny: no permissives matched. The Model call site is
    // responsible for raising `PolicyDeniedError` BEFORE compile when
    // `defaults.onDeny === 'throw'`. At compile time we always fall
    // back to `false` so the query is safe even if the call-site
    // throw is bypassed (defense in depth, not the primary path).
    if (resolved.permissives.length === 0) {
      void defaults;
      void operation;
      return 'false';
    }

    // At least one permissive matched. Compose `(perm) AND (rest)`.
    const permClause =
      permFrags.length === 0
        ? // Permissives existed but every one returned an empty partial.
          // Each empty partial is "match anything" — `true`.
          'true'
        : permFrags.length === 1
          ? permFrags[0]
          : `(${permFrags.join(' OR ')})`;

    const restClause =
      restFrags.length === 0
        ? 'true'
        : restFrags.length === 1
          ? restFrags[0]
          : restFrags.join(' AND ');

    // Avoid the trivial `(... AND true)` formulation when there are no
    // restrictives — keeps emitted Cypher tighter and the byte-
    // identical regression cleaner.
    return restClause === 'true'
      ? permClause
      : `(${permClause} AND ${restClause})`;
  }

  private compileConditions(
    where: Record<string, unknown>,
    nodeVar: string,
    nodeDef: NodeDefinition,
    counter: { count: number },
    depth: number,
    scope: CypherFieldScope,
    /**
     * Optional shared params accumulator. When provided, every leaf
     * write goes directly into this object instead of allocating a
     * fresh `{}` per recursion frame and merging via `Object.assign`.
     * Pre-1.8.0 every AND/OR/NOT branch allocated its own params Map,
     * we then `mergeParams`'d it into the parent — for a 5-frame deep
     * recursion that's 5 fresh objects + 5 Object.assign walks. Now
     * deep recursions write into a single owner object. Public callers
     * keep the old contract (no arg → fresh Map allocated locally).
     */
    paramsTarget?: Record<string, unknown>,
  ): WhereResult {
    if (depth > MAX_DEPTH)
      throw new OGMError(
        `WHERE clause nesting depth exceeds maximum (${MAX_DEPTH})`,
      );
    if (where == null) return { cypher: '', params: paramsTarget ?? {} };

    const caseInsensitive = where.mode === 'insensitive';

    const clauses: string[] = [];
    // Reuse the caller's params accumulator when provided. Otherwise
    // own a fresh Map (the top-level entry point case).
    const params: Record<string, unknown> = paramsTarget ?? {};

    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (key === 'mode') continue;
      assertSafeKey(key, 'where input');

      // Logical operators (check before null handling so NOT with null value is handled correctly)
      if (key === 'AND' || key === 'OR') {
        const items = value as Record<string, unknown>[];
        if (items.length > MAX_LOGICAL_ARRAY_LENGTH)
          throw new OGMError(
            `${key} array length ${items.length} exceeds the maximum of ${MAX_LOGICAL_ARRAY_LENGTH}. ` +
              `Restructure the predicate (e.g. use _IN for value lists, or split the query) instead of ` +
              `passing a large logical array.`,
          );
        // Pass `params` as the shared target so leaf writes go straight
        // into our accumulator. The mergeParams call below becomes a
        // no-op because every sub.params IS our params, but we keep
        // the loop for legacy callers that might one day call this
        // method with paramsTarget undefined at intermediate levels.
        const subClauses: string[] = [];
        for (const item of items) {
          const sub = this.compileConditions(
            item,
            nodeVar,
            nodeDef,
            counter,
            depth + 1,
            scope,
            params,
          );
          if (sub.cypher) subClauses.push(sub.cypher);
        }
        if (subClauses.length > 0)
          clauses.push(`(${subClauses.join(` ${key} `)})`);
        continue;
      }

      if (key === 'NOT') {
        if (value === null)
          // NOT: null inside a relationship context is a no-op (handled by bare relationship _SOME)
          continue;

        if (!isPlainObject(value))
          throw new OGMError(`NOT operator requires an object value.`);

        const sub = this.compileConditions(
          value,
          nodeVar,
          nodeDef,
          counter,
          depth + 1,
          scope,
          params,
        );
        if (sub.cypher) clauses.push(`NOT (${sub.cypher})`);
        continue;
      }

      // Handle null values: relationship null → NOT EXISTS, scalar null → IS NULL
      if (value === null) {
        const relDef = nodeDef.relationships.get(key);
        if (relDef) {
          // Relationship null means "no such relationship exists"
          const targetNodeDef = resolveTargetDef(relDef.target, this.schema);
          if (targetNodeDef) {
            const relVar = `r${counter.count}`;
            counter.count++;
            const pattern = buildRelPattern({
              sourceVar: nodeVar,
              relDef,
              targetVar: relVar,
              targetLabel: 'auto',
              // Pass schema so that union/interface targets resolve to a
              // labelless target (relationship-type-only filter). Without
              // this, the literal abstract type name is escaped as a label
              // that no concrete node carries → NOT EXISTS is true for
              // every row → ALL rows match.
              schema: this.schema,
            });
            clauses.push(`NOT EXISTS { MATCH ${pattern} }`);
          }
        } else {
          // Scalar null means "property IS NULL". `@cypher` scalars need
          // to project through the scope first (NULL check on the alias).
          assertSafeIdentifier(key, 'where clause');
          const fieldRef = this.resolveFieldRef(key, nodeVar, nodeDef, scope);
          clauses.push(`${fieldRef} IS NULL`);
        }
        continue;
      }

      // Connection operators (e.g. hasStatusConnection_SOME)
      const connResult = this.tryCompileConnection(
        key,
        value as Record<string, unknown>,
        nodeVar,
        nodeDef,
        counter,
        depth,
      );
      if (connResult) {
        clauses.push(connResult.cypher);
        mergeParams(params, connResult.params);
        continue;
      }

      // Relationship operators (e.g. drugs_SOME, drugs_NONE)
      const relResult = this.tryCompileRelationship(
        key,
        value as Record<string, unknown>,
        nodeVar,
        nodeDef,
        counter,
        depth,
      );
      if (relResult) {
        clauses.push(relResult.cypher);
        mergeParams(params, relResult.params);
        continue;
      }

      // Codegen emits `<rel>Aggregate` keys for every relationship, but
      // runtime support is not yet implemented. Without this guard the
      // key falls into `compileScalarCondition` and emits
      // `n.<rel>Aggregate = $param` against a non-existent property
      // (NULL → row silently dropped). Throw loudly so the developer
      // knows to refactor to `_SOME` / `_NONE` / `_ALL`.
      if (key.endsWith('Aggregate')) {
        const aggField = key.slice(0, -'Aggregate'.length);
        if (nodeDef.relationships.has(aggField))
          throw new OGMError(
            `Relationship aggregate filter "${key}" is not yet supported at runtime. ` +
              `Use _SOME / _NONE / _ALL with a target Where clause instead.`,
          );
      }

      // Scalar property operators
      const scalarResult = this.compileScalarCondition(
        key,
        value,
        nodeVar,
        nodeDef,
        scope,
        counter,
        caseInsensitive,
      );
      clauses.push(scalarResult.cypher);
      mergeParams(params, scalarResult.params);
    }

    return {
      cypher: clauses.join(' AND '),
      params,
    };
  }

  /**
   * Resolve the Cypher reference for a where-clause field. For stored
   * properties this is `<nodeVar>.<field>`. For `@cypher` scalar fields,
   * the field is registered in the scope (creating a CALL prelude on the
   * first reference) and the alias is returned.
   */
  private resolveFieldRef(
    fieldName: string,
    nodeVar: string,
    propsHolder: { properties: Map<string, PropertyDefinition> } | undefined,
    scope: CypherFieldScope | null,
  ): string {
    const propDef = propsHolder?.properties.get(fieldName);
    if (scope && propDef?.isCypher && propDef.cypherStatement)
      return scope.register(fieldName, propDef);

    return `${nodeVar}.${escapeIdentifier(fieldName)}`;
  }

  private tryCompileConnection(
    key: string,
    value: Record<string, unknown>,
    nodeVar: string,
    nodeDef: NodeDefinition,
    counter: { count: number },
    depth: number,
  ): WhereResult | null {
    let connSuffix: ConnectionSuffix | null = null;
    let fieldName = '';

    for (const suffix of CONNECTION_SUFFIXES)
      if (key.endsWith(suffix)) {
        connSuffix = suffix;
        fieldName = key.slice(0, -suffix.length);
        break;
      }

    if (!connSuffix) return null;

    assertSafeIdentifier(fieldName, 'connection field');
    const relDef = nodeDef.relationships.get(fieldName);
    if (!relDef) return null;

    const targetNodeDef = resolveTargetDef(relDef.target, this.schema);
    if (!targetNodeDef)
      throw new OGMError(
        `Invalid connection filter: target type for "${fieldName}" is not defined in the schema.`,
      );

    const relVar = `r${counter.count}`;
    const edgeVar = `e${counter.count}`;
    counter.count++;

    const pattern = buildRelPattern({
      sourceVar: nodeVar,
      relDef,
      targetVar: relVar,
      edgeVar,
      targetLabel: 'auto',
      // Abstract targets (unions/interfaces) → labelless target node, so
      // the relationship-type filter is authoritative. Without `schema`,
      // the abstract type name would be escaped as a literal label and
      // never match.
      schema: this.schema,
    });

    // Inner scopes for any `@cypher` projections referenced inside the
    // EXISTS body. Node-side and edge-side get separate scopes so their
    // alias namespaces are distinct (and so that no edge variable carries
    // node aliases or vice-versa).
    const nodeScope = new CypherFieldScope(relVar, [], '__where');
    const edgeScope = new CypherFieldScope(edgeVar, [], '__where');

    const propsDef = relDef.properties
      ? (this.schema.relationshipProperties.get(relDef.properties) ?? null)
      : null;

    const inner = this.compileConnectionWhereInput(
      value,
      relVar,
      edgeVar,
      targetNodeDef,
      propsDef,
      nodeScope,
      edgeScope,
      counter,
      depth,
    );
    const innerClauses = inner.cypher ? [inner.cypher] : [];
    const innerParams = inner.params;

    // Stitch the inner preludes (CALL { ... } + WITH ...) INSIDE the
    // EXISTS body, between the MATCH pattern and the inner WHERE.
    const innerPreludes: string[] = [];
    if (nodeScope.hasAny()) innerPreludes.push(...nodeScope.emit());
    if (edgeScope.hasAny()) innerPreludes.push(...edgeScope.emit());
    const preludeFragment = innerPreludes.length
      ? ` ${innerPreludes.join(' ')}`
      : '';

    const whereClause =
      innerClauses.length > 0 ? ` WHERE ${innerClauses.join(' AND ')}` : '';

    switch (connSuffix) {
      case 'Connection':
      case 'Connection_SOME':
        return {
          cypher: `EXISTS { MATCH ${pattern}${preludeFragment}${whereClause} }`,
          params: innerParams,
        };
      case 'Connection_NOT':
      case 'Connection_NONE':
        return {
          cypher: `NOT EXISTS { MATCH ${pattern}${preludeFragment}${whereClause} }`,
          params: innerParams,
        };
      case 'Connection_ALL':
        if (innerClauses.length > 0)
          return {
            cypher: `NOT EXISTS { MATCH ${pattern}${preludeFragment} WHERE NOT (${innerClauses.join(' AND ')}) }`,
            params: innerParams,
          };

        return { cypher: '', params: {} };
      case 'Connection_SINGLE':
        if (innerPreludes.length > 0)
          throw new OGMError(
            `Connection_SINGLE filters do not support @cypher fields. ` +
              `Refactor to Connection_SOME + Connection_NONE, or remove the @cypher reference.`,
          );

        return {
          cypher: `size([(${pattern}${whereClause} | 1)]) = 1`,
          params: innerParams,
        };
      default:
        return null;
    }
  }

  /**
   * Compile a connection-where-input — the value at
   * `where.<rel>Connection*: { ... }`. Recognises:
   *   - `node` / `node_NOT` — target node Where filter (negation wraps in `NOT (...)`)
   *   - `edge` / `edge_NOT` — edge property Where filter (only when relationship has properties)
   *   - `AND` / `OR` — array of nested connection-where-inputs joined with the operator
   *   - `NOT` — single nested connection-where-input wrapped in `NOT (...)`
   *
   * All nested clauses live inside the SAME EXISTS body — i.e. they
   * constrain the same `(relVar, edgeVar)` pair. This matches the codegen
   * shape declared in `connection-emitter.ts`.
   */
  private compileConnectionWhereInput(
    value: Record<string, unknown>,
    relVar: string,
    edgeVar: string,
    targetNodeDef: NodeDefinition,
    propsDef: { properties: Map<string, PropertyDefinition> } | null,
    nodeScope: CypherFieldScope,
    edgeScope: CypherFieldScope,
    counter: { count: number },
    depth: number,
  ): WhereResult {
    const innerClauses: string[] = [];
    const innerParams: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(value)) {
      if (val === undefined) continue;

      if (key === 'node' || key === 'node_NOT') {
        const nodeResult = this.compileConditions(
          val as Record<string, unknown>,
          relVar,
          targetNodeDef,
          counter,
          depth + 1,
          nodeScope,
        );
        if (nodeResult.cypher) {
          innerClauses.push(
            key === 'node_NOT'
              ? `NOT (${nodeResult.cypher})`
              : nodeResult.cypher,
          );
          mergeParams(innerParams, nodeResult.params);
        }
        continue;
      }

      if ((key === 'edge' || key === 'edge_NOT') && propsDef) {
        const edgeResult = this.compileEdgeConditions(
          val as Record<string, unknown>,
          edgeVar,
          propsDef,
          edgeScope,
          counter,
        );
        if (edgeResult.cypher) {
          innerClauses.push(
            key === 'edge_NOT'
              ? `NOT (${edgeResult.cypher})`
              : edgeResult.cypher,
          );
          mergeParams(innerParams, edgeResult.params);
        }
        continue;
      }

      if (key === 'AND' || key === 'OR') {
        const items = val as Record<string, unknown>[];
        if (items.length > MAX_LOGICAL_ARRAY_LENGTH)
          throw new OGMError(
            `${key} array length ${items.length} exceeds the maximum of ${MAX_LOGICAL_ARRAY_LENGTH}. ` +
              `Restructure the predicate instead of passing a large logical array inside a connection where.`,
          );
        const subResults = items.map((item) =>
          this.compileConnectionWhereInput(
            item,
            relVar,
            edgeVar,
            targetNodeDef,
            propsDef,
            nodeScope,
            edgeScope,
            counter,
            depth + 1,
          ),
        );
        const subClauses = subResults.map((r) => r.cypher).filter(Boolean);
        if (subClauses.length > 0) {
          innerClauses.push(`(${subClauses.join(` ${key} `)})`);
          for (const r of subResults) mergeParams(innerParams, r.params);
        }
        continue;
      }

      if (key === 'NOT') {
        if (!isPlainObject(val))
          throw new OGMError(
            `NOT operator inside a connection where requires an object value.`,
          );
        const sub = this.compileConnectionWhereInput(
          val as Record<string, unknown>,
          relVar,
          edgeVar,
          targetNodeDef,
          propsDef,
          nodeScope,
          edgeScope,
          counter,
          depth + 1,
        );
        if (sub.cypher) {
          innerClauses.push(`NOT (${sub.cypher})`);
          mergeParams(innerParams, sub.params);
        }
        continue;
      }

      // Unknown key — silently ignore to remain forward-compatible with
      // future codegen additions.
    }

    return {
      cypher: innerClauses.join(' AND '),
      params: innerParams,
    };
  }

  private tryCompileRelationship(
    key: string,
    value: Record<string, unknown>,
    nodeVar: string,
    nodeDef: NodeDefinition,
    counter: { count: number },
    depth: number,
  ): WhereResult | null {
    let suffix: RelationshipSuffix | null = null;
    let fieldName = key;

    for (const s of RELATIONSHIP_SUFFIXES)
      if (key.endsWith(s)) {
        suffix = s;
        fieldName = key.slice(0, -s.length);
        break;
      }

    // Bare relationship key (no suffix) — treat as _SOME
    if (!suffix) {
      const bareRelDef = nodeDef.relationships.get(key);
      if (bareRelDef) {
        suffix = '_SOME';
        fieldName = key;
      } else return null;
    }

    assertSafeIdentifier(fieldName, 'relationship field');

    const relDef = nodeDef.relationships.get(fieldName);
    if (!relDef) return null;

    // Check if the relationship target is a union type
    const isUnionTarget =
      !this.schema.nodes.has(relDef.target) &&
      this.schema.unions?.has(relDef.target);

    if (isUnionTarget)
      return this.compileUnionRelationship(
        suffix,
        value,
        nodeVar,
        relDef,
        counter,
        depth,
      );

    const targetNodeDef = resolveTargetDef(relDef.target, this.schema);
    if (!targetNodeDef)
      throw new OGMError(
        `Invalid relationship filter: target type for "${fieldName}" is not defined in the schema.`,
      );

    const relVar = `r${counter.count}`;
    counter.count++;

    const pattern = buildRelPattern({
      sourceVar: nodeVar,
      relDef,
      targetVar: relVar,
      targetLabel: 'auto',
      // Interface targets need the same labelless-target treatment as
      // unions (which are dispatched earlier to compileUnionRelationship).
      // Without `schema`, an interface name is escaped as a label and
      // EXISTS never matches concrete-typed nodes.
      schema: this.schema,
    });

    // Inner scope for any `@cypher` fields referenced inside the inner
    // WHERE — preludes are stitched into the EXISTS body.
    const innerScope = new CypherFieldScope(relVar, [], '__where');
    const innerResult = this.compileConditions(
      value,
      relVar,
      targetNodeDef,
      counter,
      depth + 1,
      innerScope,
    );

    const innerPreludeFragment = innerScope.hasAny()
      ? ` ${innerScope.emit().join(' ')}`
      : '';

    const whereClause = innerResult.cypher
      ? ` WHERE ${innerResult.cypher}`
      : '';

    switch (suffix) {
      case '_SOME':
        return {
          cypher: `EXISTS { MATCH ${pattern}${innerPreludeFragment}${whereClause} }`,
          params: innerResult.params,
        };
      case '_NONE':
      case '_NOT':
        // `_NOT` is the codegen-emitted negation of a relationship filter
        // (e.g. `drugs_NOT: { name: 'X' }`). Semantically identical to
        // `_NONE`. Without this case, the suffix used to fall into the
        // scalar OPERATOR_REGISTRY and emit `n.drugs <> $param` against a
        // Map → NULL → silent wrong rows.
        return {
          cypher: `NOT EXISTS { MATCH ${pattern}${innerPreludeFragment}${whereClause} }`,
          params: innerResult.params,
        };
      case '_ALL':
        // All matching rels must satisfy: NOT EXISTS { MATCH pattern WHERE NOT (inner) }
        if (innerResult.cypher)
          return {
            cypher: `NOT EXISTS { MATCH ${pattern}${innerPreludeFragment} WHERE NOT (${innerResult.cypher}) }`,
            params: innerResult.params,
          };

        return { cypher: '', params: {} };
      case '_SINGLE': {
        // Exactly one relationship satisfies. Pattern comprehensions cannot
        // contain CALL { ... } subqueries, so reject `@cypher` fields here.
        if (innerScope.hasAny())
          throw new OGMError(
            `_SINGLE quantifiers do not support filtering by @cypher fields. ` +
              `Refactor the predicate to use _SOME + _NONE, or remove the @cypher reference.`,
          );

        // Pre-1.7.5 we incremented `counter.count` here a second time
        // even though no new variable was bound — this branch already
        // claimed `r${counter.count}` at the top of the function and
        // bumped the counter once. The extra increment was dead and
        // skipped a slot in the param/var namespace, masking real
        // collisions if/when a future compiler shared this counter.
        return {
          cypher: `size([${relVar} IN [(${pattern}${whereClause} | ${relVar})] | ${relVar}]) = 1`,
          params: innerResult.params,
        };
      }
      default:
        return null;
    }
  }

  /**
   * Compiles a relationship WHERE clause targeting a union type.
   * Union WHERE inputs use member names as keys (e.g., `{ StandardDose: {} }`).
   * Each member generates a separate EXISTS pattern using the member's labels.
   * Multiple members are combined with OR.
   */
  private compileUnionRelationship(
    suffix: RelationshipSuffix,
    value: Record<string, unknown>,
    nodeVar: string,
    relDef: RelationshipDefinition,
    counter: { count: number },
    depth: number,
  ): WhereResult | null {
    const unionMembers = this.schema.unions!.get(relDef.target)!;
    const memberClauses: string[] = [];
    const allParams: Record<string, unknown> = {};

    for (const [memberKey, memberValue] of Object.entries(value)) {
      if (!unionMembers.includes(memberKey))
        throw new OGMError(
          `Invalid union member key "${memberKey}" in WHERE filter. Expected one of: ${unionMembers.join(', ')}.`,
        );

      const memberDef = this.schema.nodes.get(memberKey);
      if (!memberDef) continue;

      const relVar = `r${counter.count}`;
      counter.count++;

      const labelStr = getTargetLabelString(memberDef);
      const pattern = buildRelPattern({
        sourceVar: nodeVar,
        relDef,
        targetVar: relVar,
        targetLabelRaw: labelStr,
      });

      // Compile inner WHERE conditions for this member (if any properties specified)
      const memberWhere = memberValue as Record<string, unknown> | null;
      let whereClause = '';
      let preludeFragment = '';
      if (memberWhere && Object.keys(memberWhere).length > 0) {
        const innerScope = new CypherFieldScope(relVar, [], '__where');
        const innerResult = this.compileConditions(
          memberWhere,
          relVar,
          memberDef,
          counter,
          depth + 1,
          innerScope,
        );
        if (innerResult.cypher) {
          whereClause = ` WHERE ${innerResult.cypher}`;
          mergeParams(allParams, innerResult.params);
        }
        if (innerScope.hasAny())
          preludeFragment = ` ${innerScope.emit().join(' ')}`;
      }

      memberClauses.push(
        `EXISTS { MATCH ${pattern}${preludeFragment}${whereClause} }`,
      );
    }

    if (memberClauses.length === 0) return { cypher: '', params: {} };

    // Combine member clauses — for _SOME/_ALL, any member match counts
    const combined =
      memberClauses.length === 1
        ? memberClauses[0]
        : `(${memberClauses.join(' OR ')})`;

    switch (suffix) {
      case '_SOME':
        return { cypher: combined, params: allParams };
      case '_NONE':
      case '_NOT':
        // `_NOT` is the codegen-emitted negation of a union relationship
        // filter — equivalent to `_NONE`.
        return {
          cypher: `NOT ${combined}`,
          params: allParams,
        };
      case '_ALL':
        return { cypher: combined, params: allParams };
      case '_SINGLE': {
        // For union _SINGLE, exactly one member should have exactly one match
        return { cypher: combined, params: allParams };
      }
      default:
        return null;
    }
  }

  private compileEdgeConditions(
    edgeWhere: Record<string, unknown>,
    edgeVar: string,
    propsDef: { properties: Map<string, PropertyDefinition> } | undefined,
    edgeScope: CypherFieldScope,
    counter: { count: number },
  ): WhereResult {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(edgeWhere)) {
      assertSafeKey(key, 'edge where input');
      const result = this.compileScalarCondition(
        key,
        value,
        edgeVar,
        propsDef,
        edgeScope,
        counter,
      );
      clauses.push(result.cypher);
      mergeParams(params, result.params);
    }

    return {
      cypher: clauses.join(' AND '),
      params,
    };
  }

  /**
   * Compile a scalar where-condition. If `fieldName` resolves to a
   * `@cypher` scalar property and `scope` is provided, the field is
   * registered in the scope (producing a CALL prelude on first use) and
   * the alias is used in the predicate. Otherwise the predicate is
   * compiled against `<nodeVar>.<field>` as before.
   */
  private compileScalarCondition(
    key: string,
    value: unknown,
    nodeVar: string,
    propsHolder: { properties: Map<string, PropertyDefinition> } | undefined,
    scope: CypherFieldScope | null,
    counter: { count: number },
    caseInsensitive = false,
  ): WhereResult {
    // Detect operator suffix
    let operator: OperatorSuffix | null = null;
    let fieldName = key;

    for (const suffix of OPERATOR_SUFFIXES)
      if (key.endsWith(suffix)) {
        operator = suffix;
        fieldName = key.slice(0, -suffix.length);
        break;
      }

    assertSafeIdentifier(fieldName, 'where clause');

    if (operator && this.disabledOperators.has(operator))
      throw new OGMError(
        `Operator "${operator}" is disabled. To enable it, set features.filters.String.MATCHES = true in your OGM config.`,
      );

    // Strict-mode opt-in: reject typo'd field names instead of compiling
    // `n.<typo> = $param` against a non-existent property (which Neo4j
    // evaluates to NULL and silently drops the row). Skipped when no
    // `propsHolder` is available (the caller couldn't resolve the
    // type — happens for synthetic/edge contexts).
    if (
      this.strictWhere &&
      propsHolder !== undefined &&
      !propsHolder.properties.has(fieldName)
    )
      throw new OGMError(
        `Unknown field "${fieldName}" in where clause. ` +
          `Field is not declared on the target type — check for typos. ` +
          `(strictWhere is enabled via OGMConfig.features.strictWhere = true.)`,
      );

    const paramName = `param${counter.count}`;
    counter.count++;

    const rawFieldRef = this.resolveFieldRef(
      fieldName,
      nodeVar,
      propsHolder,
      scope,
    );
    const rawParamRef = `$${paramName}`;

    if (operator === null) {
      // Exact match — always CI-aware
      const fieldRef = caseInsensitive
        ? `toLower(${rawFieldRef})`
        : rawFieldRef;
      const paramRef = caseInsensitive
        ? `toLower(${rawParamRef})`
        : rawParamRef;
      return {
        cypher: `${fieldRef} = ${paramRef}`,
        params: { [paramName]: value },
      };
    }

    const opDef = OPERATOR_MAP.get(operator);
    if (!opDef) throw new OGMError(`Unknown operator: ${operator}`);

    const ci = caseInsensitive && opDef.ciAware;
    const fieldRef = ci ? `toLower(${rawFieldRef})` : rawFieldRef;
    const paramRef = ci ? `toLower(${rawParamRef})` : rawParamRef;

    const cypher = opDef.template
      .replace(/%rf/g, rawFieldRef)
      .replace(/%rp/g, rawParamRef)
      .replace(/%f/g, fieldRef)
      .replace(/%p/g, paramRef);

    return { cypher, params: { [paramName]: value } };
  }
}

/**
 * Stitch a user where-body and a policy clause into a single Cypher
 * fragment. Both come from `compileConditions` so each is already a
 * valid boolean expression. Empty user bodies skip the AND wrap.
 */
function stitchUserAndPolicy(userBody: string, policyClause: string): string {
  if (!userBody) return policyClause;
  if (!policyClause) return userBody;
  return `(${userBody}) AND ${policyClause}`;
}

/**
 * Namespace raw `cypher.params` keys with the given prefix and produce a
 * lookup map old-name → new-name. The fragment text is rewritten with
 * the new names so users of the escape hatch never have to coordinate.
 */
function namespacePolicyParams(
  rawParams: Record<string, unknown>,
  prefix: string,
): { values: Record<string, unknown>; map: Map<string, string> } {
  const values: Record<string, unknown> = {};
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(rawParams)) {
    assertSafeKey(key, 'policy cypher params key');
    assertSafeIdentifier(key, 'policy cypher params key');
    const next = `${prefix}${key}`;
    values[next] = value;
    map.set(key, next);
  }
  return { values, map };
}

/**
 * Rewrite `$<name>` placeholders in a raw policy fragment to point at
 * the namespaced versions. Anything not in the rename map is left alone
 * — users may reference Neo4j-builtin params that we don't own.
 */
function rewritePolicyFragment(
  fragment: string,
  rename: Map<string, string>,
): string {
  return fragment.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
    const renamed = rename.get(name);
    return renamed ? `$${renamed}` : match;
  });
}
