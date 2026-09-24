import { OGMError } from '../errors';
import type { OGMLogger } from '../execution/executor';
import { isReadRestrictive, NO_ROOT_POLICY } from '../policy/types';
import type {
  Operation,
  PermissivePolicy,
  PolicyContextBundle,
  RestrictivePolicy,
} from '../policy/types';
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
  assertSafeRegexPattern,
  escapeIdentifier,
  isPlainObject,
  mergeParams,
} from '../utils/validation';
import { wrapWhereParam } from '../utils/write-coercion';

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

/**
 * One resolved policy's compiled contribution to the policy clause.
 * `parts` are its boolean fragments in emission order (the `when` part,
 * then the `cypher` part) — exactly what `composePolicyClause` joins.
 * Empty `parts` → the policy emitted no predicate: it abstained, or (for
 * restrictives) it is write-side or gated off by `appliesWhen`.
 */
export interface CompiledPolicy {
  readonly policy: PermissivePolicy | RestrictivePolicy;
  readonly parts: ReadonlyArray<string>;
}

/**
 * Per-policy compilation of one (typeName, op) frame. Positionally
 * aligned with the bundle's `resolved.permissives` /
 * `resolved.restrictives` — one entry per policy, in order.
 */
export interface CompiledPolicyFragments {
  readonly permissives: ReadonlyArray<CompiledPolicy>;
  readonly restrictives: ReadonlyArray<CompiledPolicy>;
}

/** Result of `WhereCompiler.compileForExplain` (explain path). */
export interface ExplainWhereResult {
  /** User where body only — the candidate filter. `''` when absent. */
  userCypher: string;
  /** User-where params followed by policy params (same as `compile()`). */
  params: Record<string, unknown>;
  /** Top-level `@cypher` preludes for BOTH the user where and policies. */
  preludes: string[];
  /**
   * Root policy clause, or `null` when none applies (override fired).
   * `clause` is byte-identical to what `compile()` AND-stitches.
   */
  policy: { fragments: CompiledPolicyFragments; clause: string } | null;
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
  /**
   * Logger used to surface a `warn` when a logical operator (`AND`/`OR`)
   * compiles with zero effective conditions — almost always a
   * dynamically-built filter that received an empty list. The OGM
   * passes its `config.logger` here.
   */
  logger?: OGMLogger;
}

/**
 * Compiles a Where input object into a Cypher WHERE clause fragment + params.
 */
export class WhereCompiler {
  private disabledOperators: Set<OperatorSuffix>;
  private strictWhere: boolean;
  private logger?: OGMLogger;

  constructor(
    private schema: SchemaMetadata,
    options?: WhereCompilerOptions,
  ) {
    this.disabledOperators = options?.disabledOperators ?? new Set();
    this.strictWhere = options?.strictWhere ?? false;
    this.logger = options?.logger;
  }

  /**
   * Surface a logical operator that contributed zero effective conditions.
   * Fires only on the anomalous branch, so the hot path pays nothing.
   */
  private warnEmptyLogical(op: 'AND' | 'OR', context: string): void {
    this.logger?.warn?.(
      op === 'OR'
        ? `[OGM] ${context}.OR has zero effective conditions — compiled to \`false\` (matches nothing, per Prisma semantics). Omit the OR key to match everything.`
        : `[OGM] ${context}.AND has zero effective conditions — no filter emitted (matches everything).`,
    );
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
      /**
       * Caller-owned `@cypher` prelude scope (v2.3.0). When given, preludes
       * register into it and are NOT returned — the caller emits the scope
       * once, so several compiles against the same variable (a connection's
       * node filter and its target policy) share one `CALL`/`WITH` chain.
       * `preserveVars` is ignored (the scope already carries its own).
       */
      scope?: CypherFieldScope;
    },
  ): WhereResult {
    const split = this.compileUserAndPolicy(
      where,
      nodeVar,
      nodeDef,
      paramCounter,
      options,
    );
    if (!split) return { cypher: '', params: {} };

    const cypher = split.policy
      ? stitchUserAndPolicy(split.userCypher, split.policy.clause)
      : split.userCypher;
    const result: WhereResult = {
      cypher,
      params: split.params,
    };
    if (split.preludes) result.preludes = split.preludes;
    return result;
  }

  /**
   * Explain-path twin of `compile()`, used by `Model.explainPolicies`.
   * Compiles the user `where` EXACTLY as `compile()` does — same order,
   * same `paramCounter`, same `@cypher` prelude scope, same policy-aware
   * relationship traversal — but returns the root policy clause
   * separately instead of AND-stitching it: as per-policy fragments AND
   * as the composed string `compile()` would have stitched. Both come
   * from one compilation, so an explanation cannot drift from
   * enforcement.
   *
   * `policy` is `null` when no root policy clause applies (an override
   * fired).
   *
   * @internal
   */
  compileForExplain(
    where: Record<string, unknown> | undefined | null,
    nodeVar: string,
    nodeDef: NodeDefinition,
    paramCounter: { count: number },
    policyContext: PolicyContextBundle,
  ): ExplainWhereResult {
    const split = this.compileUserAndPolicy(
      where,
      nodeVar,
      nodeDef,
      paramCounter,
      { policyContext },
    );
    return {
      userCypher: split?.userCypher ?? '',
      params: split?.params ?? {},
      preludes: split?.preludes ?? [],
      policy: split?.policy ?? null,
    };
  }

  /**
   * The policy clause guarding a node of a possibly ABSTRACT type for one
   * operation (v2.3.0) — the single construction behind every target-
   * policy consumer (nested selection, traversal filters, nested writes)
   * and `InterfaceModel`'s root clause:
   *
   *   - concrete type → its own composed clause for `op` (byte-identical
   *     to compiling it directly); `null` when it has no policy for `op`
   *     or an override fires.
   *   - interface / union →
   *       `(CASE WHEN v:M1 THEN <M1 clause> WHEN v:M2 THEN … ELSE false END)`
   *     over the concrete members, each branch being exactly that member's
   *     own clause (`resolveForType(M, op)` already folds in M's interface
   *     policies). A member without a policy for `op`, or whose override
   *     fires, is `true`; when EVERY member is `true` the result is `null`
   *     (unconstrained, like a concrete type without policies). `ELSE false`
   *     excludes a node carrying no known member label (defense in depth).
   *
   * Pre-2.3.0 abstract targets resolved the ABSTRACT type's name, so the
   * implementers' own policies were never applied through relationships.
   *
   * `fallbackOp`: resolve it for a type with NO policy for `op` — the
   * `aggregate` → `read` fallback `Model.aggregate` applies at the root.
   *
   * `preludes` (for `@cypher` fields referenced by a policy) are returned
   * to the caller; nested contexts reject them.
   *
   * @internal
   */
  compileTargetPolicyClause(
    typeName: string,
    varName: string,
    op: Operation,
    policyContext: PolicyContextBundle,
    paramCounter: { count: number },
    fallbackOp?: Operation,
  ): {
    cypher: string | null;
    params: Record<string, unknown>;
    preludes: string[];
  } {
    const members = this.abstractMembers(typeName);
    if (members === null)
      return this.compileConcreteTargetClause(
        typeName,
        varName,
        op,
        policyContext,
        paramCounter,
        fallbackOp,
      );

    const params: Record<string, unknown> = {};
    const preludes: string[] = [];
    const branches: string[] = [];
    let constrained = false;
    for (const member of members) {
      if (!this.schema.nodes.has(member)) continue;
      const clause = this.compileConcreteTargetClause(
        member,
        varName,
        op,
        policyContext,
        paramCounter,
        fallbackOp,
      );
      mergeParams(params, clause.params);
      // Each member compiles in its own `@cypher` scope; chaining two
      // scopes would drop the first one's aliases at the second's `WITH`.
      if (preludes.length > 0 && clause.preludes.length > 0)
        throw new OGMError(
          `Policies on more than one member of "${typeName}" project @cypher ` +
            `fields, which cannot be combined in one query. Refactor all but ` +
            `one to stored properties.`,
        );
      preludes.push(...clause.preludes);
      if (clause.cypher !== null) constrained = true;
      branches.push(
        `WHEN ${varName}:${escapeIdentifier(member)} THEN ${clause.cypher ?? 'true'}`,
      );
    }
    if (!constrained) return { cypher: null, params: {}, preludes: [] };
    return {
      cypher: `(CASE ${branches.join(' ')} ELSE false END)`,
      params,
      preludes,
    };
  }

  private compileConcreteTargetClause(
    typeName: string,
    varName: string,
    op: Operation,
    policyContext: PolicyContextBundle,
    paramCounter: { count: number },
    fallbackOp?: Operation,
  ): {
    cypher: string | null;
    params: Record<string, unknown>;
    preludes: string[];
  } {
    const nodeDef = this.schema.nodes.get(typeName);
    let resolvedOp = op;
    let resolved = policyContext.resolveForType(typeName, op);
    if (!resolved && fallbackOp) {
      resolvedOp = fallbackOp;
      resolved = policyContext.resolveForType(typeName, fallbackOp);
    }
    if (!nodeDef || !resolved || resolved.overridden)
      return { cypher: null, params: {}, preludes: [] };
    const compiled = this.compile(undefined, varName, nodeDef, paramCounter, {
      policyContext: {
        ctx: policyContext.ctx,
        operation: resolvedOp,
        resolved,
        resolveForType: policyContext.resolveForType,
        defaults: policyContext.defaults,
      },
    });
    return {
      cypher: compiled.cypher || null,
      params: compiled.params,
      preludes: compiled.preludes ?? [],
    };
  }

  /** Concrete members of an interface / union; `null` for any other type. */
  private abstractMembers(typeName: string): string[] | null {
    if (this.schema.nodes.has(typeName)) return null;
    const iface = this.schema.interfaces?.get(typeName);
    if (iface) return [...iface.implementedBy];
    const union = this.schema.unions?.get(typeName);
    if (union) return [...union];
    return null;
  }

  /**
   * Shared body of `compile()` / `compileForExplain()`: compiles the user
   * where, then the policy fragments, sharing one `paramCounter` and one
   * top-level `@cypher` scope. Returns `null` when there is nothing to
   * compile (no user where and no active policy).
   */
  private compileUserAndPolicy(
    where: Record<string, unknown> | undefined | null,
    nodeVar: string,
    nodeDef: NodeDefinition,
    paramCounter: { count: number },
    options?: {
      preserveVars?: ReadonlyArray<string>;
      policyContext?: PolicyContextBundle;
      scope?: CypherFieldScope;
    },
  ): {
    userCypher: string;
    params: Record<string, unknown>;
    preludes?: string[];
    policy: { fragments: CompiledPolicyFragments; clause: string } | null;
  } | null {
    const hasUserWhere = where != null && Object.keys(where).length > 0;
    const policyContext = options?.policyContext;
    const policyActive =
      policyContext !== undefined && !policyContext.resolved.overridden;

    if (!hasUserWhere && !policyActive) return null;

    // Top-level scope — preludes here are returned to the caller for stitching
    // BEFORE the WHERE clause. Nested scopes (relationship quantifiers) build
    // their own scopes and stitch their preludes into the EXISTS body inline.
    const ownsScope = options?.scope === undefined;
    const scope =
      options?.scope ??
      new CypherFieldScope(nodeVar, options?.preserveVars ?? [], '__where');
    const userBody = hasUserWhere
      ? this.compileConditions(
          where,
          nodeVar,
          nodeDef,
          paramCounter,
          0,
          scope,
          undefined,
          policyContext,
        )
      : { cypher: '', params: {} as Record<string, unknown> };

    const params = { ...userBody.params };

    let policy: {
      fragments: CompiledPolicyFragments;
      clause: string;
    } | null = null;
    if (policyActive) {
      const fragments = this.compilePolicyFragments(
        policyContext!,
        nodeVar,
        nodeDef,
        paramCounter,
        scope,
        params,
      );
      policy = { fragments, clause: composePolicyClause(fragments) };
    }

    return {
      userCypher: userBody.cypher,
      params,
      preludes: ownsScope && scope.hasAny() ? scope.emit() : undefined,
      policy,
    };
  }

  /**
   * Compile each resolved policy of a single (typeName, op) frame into
   * its boolean fragments ("parts"), WITHOUT combining them —
   * `composePolicyClause` does that. Shares the same `paramCounter` and
   * `scope` as the user where so that nothing collides downstream.
   *
   * The result is positionally aligned with `resolved.permissives` /
   * `resolved.restrictives`: one entry per policy, in order, even when a
   * policy contributes no part.
   *
   * Permissive `cypher.params` keys are namespaced with `policy_p<n>_`
   * to guarantee no collision with `param0..N`.
   */
  private compilePolicyFragments(
    bundle: PolicyContextBundle,
    nodeVar: string,
    nodeDef: NodeDefinition,
    paramCounter: { count: number },
    scope: CypherFieldScope,
    paramsTarget: Record<string, unknown>,
  ): CompiledPolicyFragments {
    const { ctx, resolved } = bundle;

    const permissives: CompiledPolicy[] = [];
    let policyParamIdx = 0;

    for (const p of resolved.permissives) {
      const parts: string[] = [];
      permissives.push({ policy: p, parts });

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
            parts.push(`(${compiled.cypher})`);
            mergeParams(paramsTarget, compiled.params);
          }
        } else if (partial && Object.keys(partial).length === 0)
          // Empty partial means "match everything" — equivalent to true.
          parts.push('true');
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
          parts.push(`(${rewritePolicyFragment(fragment, namespaced.map)})`);
        }
      }
    }

    const restrictives: CompiledPolicy[] = [];
    for (const p of resolved.restrictives) {
      const parts: string[] = [];
      restrictives.push({ policy: p, parts });

      // Only ReadRestrictive policies participate in the WHERE clause.
      // WriteRestrictive policies (create/update) are evaluated at the
      // application layer in Model.* — calling their `(ctx, input)`
      // `when` here with no input would silently mis-evaluate.
      if (!isReadRestrictive(p)) continue;
      // Compile-time gate. If `appliesWhen(ctx)` is false, the policy
      // contributes nothing to this query — same semantics as a
      // dropped permissive. (The resolver evaluates this gate too; this
      // check stays as defense in depth for hand-built bundles.)
      if (p.appliesWhen && !p.appliesWhen(ctx)) continue;

      if (p.when) {
        // ReadRestrictive `when` may return a where-partial OR boolean.
        const partial = p.when(ctx);
        if (partial === false)
          // Hard deny — compiles to `false` and short-circuits the
          // restrictive AND chain.
          parts.push('false');
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
              parts.push(`(${compiled.cypher})`);
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
          parts.push(`(${rewritePolicyFragment(fragment, namespaced.map)})`);
        }
      }
    }

    return { permissives, restrictives };
  }

  /**
   * Build a `PolicyContextBundle` for a target type when crossing a
   * node-type boundary inside a relationship traversal (`_SOME` /
   * `_NONE` / `_ALL` / `_SINGLE` / connection-where `node`). Mirrors the
   * canonical pattern at `selection.compiler.ts:826-847`.
   *
   * Returns `undefined` when:
   *   - the input `policyContext` is `undefined` (caller has no policy state), OR
   *   - `resolveForType(typeName, 'read')` returns `null` (no policy
   *     registered for the target type).
   *
   * The synthesized bundle reuses the same `resolveForType` so further
   * nesting (target → target's relationship → ...) keeps cascading.
   */
  private buildTargetBundle(
    typeName: string,
    policyContext: PolicyContextBundle | undefined,
  ): PolicyContextBundle | undefined {
    if (!policyContext) return undefined;
    // v2.3.0 — a target WITHOUT a read policy still gets a bundle
    // (`NO_ROOT_POLICY`: no clause of its own) so enforcement keeps
    // cascading into deeper traversals. Pre-2.3.0 this returned
    // `undefined`, making every policy-free type on a traversal path a
    // gateway around the types beyond it (A → B(no policy) → C skipped C).
    const targetPolicy =
      policyContext.resolveForType(typeName, 'read') ?? NO_ROOT_POLICY;
    return {
      ctx: policyContext.ctx,
      operation: 'read',
      resolved: targetPolicy,
      resolveForType: policyContext.resolveForType,
      defaults: policyContext.defaults,
    };
  }

  /**
   * Compile a traversal's filter against its target node with the
   * caller's filter (`user`) and the target's `read` policy (`policy`)
   * kept SEPARATE, so each quantifier composes them correctly — the
   * policy must never sit inside a negation (v2.3.0). Pre-2.3.0 the policy
   * was compiled INTO the filter, so `_ALL` (`NOT (user AND policy)`) was
   * falsified by hidden related nodes (an existence oracle), and a
   * connection `node_NOT` was SATISFIED by them.
   *
   *   - no policy context → plain compile.
   *   - concrete target → one `compileUserAndPolicy` pass (shared `@cypher`
   *     prelude scope); the bundle cascades as `NO_ROOT_POLICY` at any depth.
   *   - interface target → filter via a `NO_ROOT_POLICY` traversal bundle,
   *     policy via `compileTargetPolicyClause` (CASE over the members'
   *     own clauses — pre-2.3.0 only the interface's own policies ran).
   *
   * `''` for an absent part. With `scope`, concrete-target preludes
   * register into it (caller emits); otherwise they are returned.
   * Shared with `SelectionCompiler`'s nested-projection filters.
   *
   * @internal
   */
  compileTargetBody(
    where: Record<string, unknown> | undefined | null,
    targetVar: string,
    targetDef: NodeDefinition,
    counter: { count: number },
    policyContext: PolicyContextBundle | undefined,
    scope?: CypherFieldScope,
  ): {
    user: string;
    policy: string;
    params: Record<string, unknown>;
    preludes: string[];
  } {
    if (!policyContext) {
      const plain = this.compile(where, targetVar, targetDef, counter, {
        scope,
      });
      return {
        user: plain.cypher,
        policy: '',
        params: plain.params,
        preludes: plain.preludes ?? [],
      };
    }

    if (this.abstractMembers(targetDef.typeName) === null) {
      const split = this.compileUserAndPolicy(
        where,
        targetVar,
        targetDef,
        counter,
        {
          policyContext: this.buildTargetBundle(
            targetDef.typeName,
            policyContext,
          ),
          scope,
        },
      );
      if (!split) return { user: '', policy: '', params: {}, preludes: [] };
      return {
        user: split.userCypher,
        policy: split.policy?.clause ?? '',
        params: split.params,
        preludes: split.preludes ?? [],
      };
    }

    const userPart = this.compile(where, targetVar, targetDef, counter, {
      policyContext: traversalBundle(policyContext),
      scope,
    });
    const policyPart = this.compileTargetPolicyClause(
      targetDef.typeName,
      targetVar,
      'read',
      policyContext,
      counter,
    );
    const userHasPreludes =
      (userPart.preludes?.length ?? 0) > 0 || (scope?.hasAny() ?? false);
    if (userHasPreludes && policyPart.preludes.length > 0)
      throw new OGMError(
        `Filtering "${targetDef.typeName}" by @cypher fields is not supported ` +
          `when a member type's policy also projects @cypher fields. Filter on ` +
          `stored properties, or refactor the member policy.`,
      );
    const params = { ...userPart.params };
    mergeParams(params, policyPart.params);
    return {
      user: userPart.cypher,
      policy: policyPart.cypher ?? '',
      params,
      preludes: [...(userPart.preludes ?? []), ...policyPart.preludes],
    };
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
    /**
     * Policy context to thread through relationship / connection
     * recursions so target-type `'read'` policies AND-stitch into the
     * EXISTS body when crossing a node-type boundary. NOT used for
     * leaf scalar predicates or for AND/OR/NOT logical recursions
     * within the same node-type scope (those simply forward through).
     *
     * v1.8.5 — fixes CRIT-3 (target-policy bypass via `_SOME`/`_NONE`/
     * `_ALL`/`_SINGLE` and `Connection_*` user-where filters).
     */
    policyContext?: PolicyContextBundle,
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
            policyContext,
          );
          if (sub.cypher) subClauses.push(sub.cypher);
        }
        if (subClauses.length > 0)
          clauses.push(`(${subClauses.join(` ${key} `)})`);
        else {
          this.warnEmptyLogical(key, 'where');
          // Prisma semantics: an OR with zero effective disjuncts matches
          // NOTHING (empty disjunction = false). Previously the operator
          // silently vanished, so `deleteMany({ where: { OR: [] } })`
          // compiled to an unfiltered DETACH DELETE — a full-label wipe.
          // `AND: []` stays a no-op (empty conjunction = true), also per
          // Prisma. Intentional divergence from @neo4j/graphql-ogm, which
          // treats `OR: []` as match-all.
          if (key === 'OR') clauses.push('false');
        }
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
          policyContext,
        );
        if (sub.cypher) clauses.push(`NOT (${sub.cypher})`);
        continue;
      }

      // Null values — the operator suffix is split off FIRST (v2.3.0); see
      // `compileNullCondition`.
      if (value === null) {
        clauses.push(
          this.compileNullCondition(key, nodeVar, nodeDef, counter, scope),
        );
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
        policyContext,
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
        policyContext,
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
    /**
     * Policy context for target-type enforcement inside the connection's
     * `node` filter. v1.8.5 — fixes CRIT-3: the target type's `'read'`
     * policy MUST AND-stitch into the EXISTS body when crossing a node-
     * type boundary via a connection-where filter. Edges have no NLS by
     * design, so this never threads into `compileEdgeConditions`.
     */
    policyContext?: PolicyContextBundle,
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
      policyContext,
    );
    const innerParams = { ...inner.params };

    // v2.3.0 — the target's `'read'` policy, composed ONCE over the whole
    // connection body (node, node_NOT, edge and logical groups alike) and
    // kept outside every negation. Compiled after the caller's filter so
    // parameter numbering matches the pre-2.3.0 single-`node` shape.
    const target = policyContext
      ? this.compileTargetBody(
          undefined,
          relVar,
          targetNodeDef,
          counter,
          policyContext,
          nodeScope,
        )
      : null;
    const policy = target?.policy ?? '';
    if (target) mergeParams(innerParams, target.params);

    // Stitch the inner preludes (CALL { ... } + WITH ...) INSIDE the
    // EXISTS body, between the MATCH pattern and the inner WHERE.
    //   - `nodeScope.emit()` — node-side `@cypher` projections: the
    //     caller's `node` filters and (concrete target) the target policy.
    //   - `edgeScope.emit()` — same, but edge-side.
    //   - `inner.preludes` / `target.preludes` — scopes owned elsewhere
    //     (an abstract target's member policies).
    const innerPreludes: string[] = [];
    if (nodeScope.hasAny()) innerPreludes.push(...nodeScope.emit());
    if (edgeScope.hasAny()) innerPreludes.push(...edgeScope.emit());
    if (inner.preludes && inner.preludes.length > 0)
      innerPreludes.push(...inner.preludes);
    if (target && target.preludes.length > 0)
      innerPreludes.push(...target.preludes);
    const preludeFragment = innerPreludes.length
      ? ` ${innerPreludes.join(' ')}`
      : '';

    const matched = stitchUserAndPolicy(inner.cypher, policy);
    const whereClause = matched ? ` WHERE ${matched}` : '';

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
        if (inner.cypher)
          return {
            cypher: `NOT EXISTS { MATCH ${pattern}${preludeFragment} WHERE ${stitchAllCounterexample(inner.cypher, policy)} }`,
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
    /**
     * Policy context to thread into target-side `node` / `node_NOT`
     * filters AND through nested AND/OR/NOT logical groups. Edge-side
     * compilation never receives this — edges have no NLS by design.
     * v1.8.5 — fixes CRIT-3.
     */
    policyContext?: PolicyContextBundle,
  ): WhereResult {
    const innerClauses: string[] = [];
    const innerParams: Record<string, unknown> = {};
    /**
     * Preludes returned by recursive `compile()` calls on the node side.
     * Pre-1.8.5 the node-side scope was shared via `nodeScope`; now the
     * inner `compile()` owns its own scope and we hoist its preludes back
     * out so the caller (`tryCompileConnection`) can stitch them between
     * `MATCH ${pattern}` and `WHERE ...` inside the EXISTS body.
     */
    const extraPreludes: string[] = [];

    for (const [key, val] of Object.entries(value)) {
      if (val === undefined) continue;

      if (key === 'node' || key === 'node_NOT') {
        // v2.3.0 — the caller's node filter only. The target's `'read'`
        // policy is composed ONCE by `tryCompileConnection` over the whole
        // connection body, never here: stitched in here it sat inside the
        // `node_NOT` negation (satisfied by hidden nodes) and was absent
        // from edge-only filters. The traversal bundle keeps deeper
        // traversals enforcing; `nodeScope` shares the `@cypher` chain
        // with that policy.
        const nodeResult = this.compile(
          val as Record<string, unknown>,
          relVar,
          targetNodeDef,
          counter,
          {
            policyContext: policyContext
              ? traversalBundle(policyContext)
              : undefined,
            scope: nodeScope,
          },
        );
        if (nodeResult.preludes && nodeResult.preludes.length > 0)
          extraPreludes.push(...nodeResult.preludes);
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
        // Thread `policyContext` through so deeply-nested connection-
        // where keeps target-policy enforcement.
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
            policyContext,
          ),
        );
        const subClauses = subResults.map((r) => r.cypher).filter(Boolean);
        if (subClauses.length > 0) {
          innerClauses.push(`(${subClauses.join(` ${key} `)})`);
          for (const r of subResults) {
            mergeParams(innerParams, r.params);
            if (r.preludes && r.preludes.length > 0)
              extraPreludes.push(...r.preludes);
          }
        } else {
          this.warnEmptyLogical(key, 'connection where');
          // Prisma semantics: OR with zero effective disjuncts matches
          // NOTHING — see the same rule in compileConditions.
          if (key === 'OR') innerClauses.push('false');
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
          policyContext,
        );
        if (sub.cypher) {
          innerClauses.push(`NOT (${sub.cypher})`);
          mergeParams(innerParams, sub.params);
        }
        if (sub.preludes && sub.preludes.length > 0)
          extraPreludes.push(...sub.preludes);
        continue;
      }

      // Unknown key — silently ignore to remain forward-compatible with
      // future codegen additions.
    }

    const result: WhereResult = {
      cypher: innerClauses.join(' AND '),
      params: innerParams,
    };
    if (extraPreludes.length > 0) result.preludes = extraPreludes;
    return result;
  }

  private tryCompileRelationship(
    key: string,
    value: Record<string, unknown>,
    nodeVar: string,
    nodeDef: NodeDefinition,
    counter: { count: number },
    depth: number,
    /**
     * Policy context to thread into the target type when crossing the
     * relationship boundary. v1.8.5 — fixes CRIT-3 (target-policy bypass
     * via `_SOME`/`_NONE`/`_ALL`/`_SINGLE` user-where filters).
     */
    policyContext?: PolicyContextBundle,
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
        policyContext,
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

    // v1.8.5 — the TARGET type's `'read'` policy applies when crossing the
    // relationship boundary (CRIT-3). v2.3.0 — the caller's filter and the
    // target's policy compile SEPARATELY and compose per quantifier with
    // the policy OUTSIDE every negation (see `compileTargetBody`).
    const body = this.compileTargetBody(
      value,
      relVar,
      targetNodeDef,
      counter,
      policyContext,
    );
    const matched = stitchUserAndPolicy(body.user, body.policy);

    const innerPreludes = body.preludes;
    const innerPreludeFragment = innerPreludes.length
      ? ` ${innerPreludes.join(' ')}`
      : '';

    const whereClause = matched ? ` WHERE ${matched}` : '';

    switch (suffix) {
      case '_SOME':
        return {
          cypher: `EXISTS { MATCH ${pattern}${innerPreludeFragment}${whereClause} }`,
          params: body.params,
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
          params: body.params,
        };
      case '_ALL':
        // No VISIBLE related node fails the filter. Without a caller filter
        // the quantifier is vacuous — hidden nodes must not falsify it
        // (pre-2.3.0 `_ALL: {}` leaked their existence).
        if (body.user)
          return {
            cypher: `NOT EXISTS { MATCH ${pattern}${innerPreludeFragment} WHERE ${stitchAllCounterexample(body.user, body.policy)} }`,
            params: body.params,
          };

        return { cypher: '', params: {} };
      case '_SINGLE': {
        // Exactly one relationship satisfies. Pattern comprehensions cannot
        // contain CALL { ... } subqueries, so reject `@cypher` fields here.
        // v1.8.5: a `@cypher`-projecting policy on the TARGET type also
        // produces preludes — distinguish that case so the error message
        // points at the right cause.
        if (innerPreludes.length > 0) {
          if (body.policy)
            throw new OGMError(
              `Policy on "${targetNodeDef.typeName}" requires @cypher field projection, ` +
                `which is not supported inside _SINGLE quantifiers. Refactor the policy ` +
                `to use stored properties, or refactor the predicate to _SOME + _NONE.`,
            );
          throw new OGMError(
            `_SINGLE quantifiers do not support filtering by @cypher fields. ` +
              `Refactor the predicate to use _SOME + _NONE, or remove the @cypher reference.`,
          );
        }

        // Pre-1.7.5 we incremented `counter.count` here a second time
        // even though no new variable was bound — this branch already
        // claimed `r${counter.count}` at the top of the function and
        // bumped the counter once. The extra increment was dead and
        // skipped a slot in the param/var namespace, masking real
        // collisions if/when a future compiler shared this counter.
        return {
          cypher: `size([${relVar} IN [(${pattern}${whereClause} | ${relVar})] | ${relVar}]) = 1`,
          params: body.params,
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
    /**
     * Policy context to thread per-member: each union member receives its
     * OWN target-bundle resolved via `policyContext.resolveForType(memberKey,
     * 'read')`. Members without a registered policy compile as before (no
     * extra clause). v1.8.5 — fixes CRIT-3 in the union path.
     */
    policyContext?: PolicyContextBundle,
  ): WhereResult | null {
    const unionMembers = this.schema.unions!.get(relDef.target)!;
    // Per-member compilation artifacts. `_SOME`/`_NONE` only need the
    // EXISTS-wrapped clause, but `_ALL`/`_SINGLE` (v1.8.7) build their
    // own quantifier shapes from the raw pattern + inner predicate, so
    // the pieces stay structured instead of pre-wrapped in EXISTS.
    const members: {
      memberKey: string;
      pattern: string;
      relVar: string;
      /** Caller filter AND member policy ('' when neither applies). */
      inner: string;
      /** Caller filter alone ('' when none) — drives `_ALL` (v2.3.0). */
      user: string;
      /** Member `'read'` policy clause alone ('' when none). */
      policy: string;
      /** ' CALL {...}' fragment from @cypher projections ('' when none). */
      preludeFragment: string;
    }[] = [];
    const allParams: Record<string, unknown> = {};

    // depth-only suppression for unused-when-no-policy lint passes; keep
    // for symmetry with `tryCompileRelationship`.
    void depth;

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

      // Caller filter and the member's own `'read'` policy, compiled
      // separately (v2.3.0) so `_ALL` can keep the policy outside its
      // negation. `_SOME`/`_NONE`/`_SINGLE` use the stitched form, which
      // is byte-identical to the pre-2.3.0 single compile.
      const memberWhere = memberValue as Record<string, unknown> | null;
      const body = this.compileTargetBody(
        memberWhere,
        relVar,
        memberDef,
        counter,
        policyContext,
      );
      const inner = stitchUserAndPolicy(body.user, body.policy);
      if (inner) mergeParams(allParams, body.params);
      const preludeFragment = body.preludes.length
        ? ` ${body.preludes.join(' ')}`
        : '';

      members.push({
        memberKey,
        pattern,
        relVar,
        inner,
        user: body.user,
        policy: body.policy,
        preludeFragment,
      });
    }

    if (members.length === 0) return { cypher: '', params: {} };

    switch (suffix) {
      case '_SOME':
      case '_NONE':
      case '_NOT': {
        const memberClauses = members.map(
          (m) =>
            `EXISTS { MATCH ${m.pattern}${m.preludeFragment}${
              m.inner ? ` WHERE ${m.inner}` : ''
            } }`,
        );
        const combined =
          memberClauses.length === 1
            ? memberClauses[0]
            : `(${memberClauses.join(' OR ')})`;
        // `_NOT` is the codegen-emitted negation of a union relationship
        // filter — equivalent to `_NONE`.
        return suffix === '_SOME'
          ? { cypher: combined, params: allParams }
          : { cypher: `NOT ${combined}`, params: allParams };
      }
      case '_ALL': {
        // v1.8.7 — pre-1.8.7 `_ALL` returned the same OR-of-EXISTS as
        // `_SOME`, silently widening the filter. `_ALL` on a union
        // mirrors the non-union double negation per MENTIONED member: no
        // related node of that member's type may fail the member's
        // predicate. Members with an empty predicate are vacuously
        // satisfied (same as the non-union empty-inner short-circuit),
        // and union members absent from the input are unconstrained —
        // consistent with `_SOME`, where only mentioned members count.
        // v2.3.0 — only a VISIBLE member node (its policy holds) can fail
        // the predicate; a member with no caller filter is vacuous even
        // when it has a policy (pre-2.3.0 its hidden nodes falsified it).
        const failClauses = members
          .filter((m) => m.user)
          .map(
            (m) =>
              `NOT EXISTS { MATCH ${m.pattern}${m.preludeFragment} WHERE ${stitchAllCounterexample(m.user, m.policy)} }`,
          );
        if (failClauses.length === 0) return { cypher: '', params: {} };
        return {
          cypher:
            failClauses.length === 1
              ? failClauses[0]
              : `(${failClauses.join(' AND ')})`,
          params: allParams,
        };
      }
      case '_SINGLE': {
        // v1.8.7 — pre-1.8.7 `_SINGLE` also returned the `_SOME` shape.
        // Now: exactly ONE related node across all mentioned members
        // matches its member's predicate. Pattern comprehensions cannot
        // contain CALL { ... } subqueries, so @cypher-projecting members
        // (user fields or target policies) are rejected — mirroring the
        // non-union `_SINGLE` contract.
        for (const m of members)
          if (m.preludeFragment)
            throw new OGMError(
              `_SINGLE quantifiers do not support filtering by @cypher ` +
                `fields (union member "${m.memberKey}" of "${relDef.target}"). ` +
                `Refactor the predicate to _SOME + _NONE, or remove the ` +
                `@cypher reference.`,
            );
        const sizeExprs = members.map(
          (m) =>
            `size([${m.relVar} IN [(${m.pattern}${
              m.inner ? ` WHERE ${m.inner}` : ''
            } | ${m.relVar})] | ${m.relVar}])`,
        );
        return {
          cypher: `${
            sizeExprs.length === 1 ? sizeExprs[0] : `(${sizeExprs.join(' + ')})`
          } = 1`,
          params: allParams,
        };
      }
      default:
        return null;
    }
  }

  /**
   * Compile `<key>: null` on a node (v2.3.0). The operator suffix is split
   * off FIRST: pre-2.3.0 the whole key was treated as a property name, so
   * the common "is not null" idiom `{ deletedAt_NOT: null }` compiled to
   * `n.deletedAt_NOT IS NULL` — always true, silently matching every row
   * (and silently restricting nothing when used in a restrictive policy).
   *
   *   field: null          → field IS NULL
   *   field_NOT: null      → field IS NOT NULL
   *   rel: null            → NOT EXISTS { MATCH (n)-[:REL]->(…) }
   *   rel_NOT: null        → EXISTS { MATCH (n)-[:REL]->(…) }
   *   any other operator   → OGMError (null has no meaning there)
   *   undeclared field     → OGMError regardless of `strictWhere` — a null
   *                          filter on an undeclared field matches every
   *                          row (fail OPEN), unlike a non-null one
   *
   * A field literally named `key` always wins over suffix parsing.
   */
  private compileNullCondition(
    key: string,
    nodeVar: string,
    nodeDef: NodeDefinition,
    counter: { count: number },
    scope: CypherFieldScope,
  ): string {
    if (nodeDef.relationships.has(key))
      return this.compileRelationshipExistence(
        key,
        nodeVar,
        nodeDef,
        counter,
        false,
      );
    if (!nodeDef.properties.has(key))
      for (const suffix of RELATIONSHIP_SUFFIXES) {
        if (!key.endsWith(suffix)) continue;
        const field = key.slice(0, -suffix.length);
        if (!nodeDef.relationships.has(field)) continue;
        if (suffix === '_NOT')
          return this.compileRelationshipExistence(
            field,
            nodeVar,
            nodeDef,
            counter,
            true,
          );
        throw new OGMError(
          `Relationship filter "${key}" cannot be null. Use "${field}: null" ` +
            `(no related node) or "${field}_NOT: null" (at least one related node).`,
        );
      }
    return this.compileNullScalar(key, nodeVar, nodeDef, scope);
  }

  /**
   * Scalar half of the null semantics above, shared by node properties and
   * relationship-edge properties: `IS NULL` / `IS NOT NULL`, or an
   * `OGMError` for any other operator and for undeclared fields.
   */
  private compileNullScalar(
    key: string,
    varName: string,
    propsHolder: { properties: Map<string, PropertyDefinition> } | undefined,
    scope: CypherFieldScope | null,
  ): string {
    if (propsHolder?.properties.has(key)) {
      assertSafeIdentifier(key, 'where clause');
      // `@cypher` scalars project through the scope (NULL check on the alias).
      return `${this.resolveFieldRef(key, varName, propsHolder, scope)} IS NULL`;
    }

    for (const suffix of OPERATOR_SUFFIXES) {
      if (!key.endsWith(suffix)) continue;
      const field = key.slice(0, -suffix.length);
      if (!propsHolder?.properties.has(field)) continue;
      if (suffix !== '_NOT')
        throw new OGMError(
          `Operator "${suffix}" cannot be used with null ("${key}"). Use ` +
            `"${field}: null" (IS NULL) or "${field}_NOT: null" (IS NOT NULL) to test for null.`,
        );
      assertSafeIdentifier(field, 'where clause');
      return `${this.resolveFieldRef(field, varName, propsHolder, scope)} IS NOT NULL`;
    }

    throw new OGMError(
      `Unknown field "${key}" in where clause with a null value. A null ` +
        `filter on a field the type does not declare would match every row, ` +
        `so it is rejected (regardless of strictWhere). Check for typos.`,
    );
  }

  /**
   * `NOT EXISTS` (no related node) / `EXISTS` (at least one) for a
   * relationship null filter. Byte-identical to the pre-2.3.0 `rel: null`
   * emission for the `NOT EXISTS` case.
   */
  private compileRelationshipExistence(
    field: string,
    nodeVar: string,
    nodeDef: NodeDefinition,
    counter: { count: number },
    exists: boolean,
  ): string {
    const relDef = nodeDef.relationships.get(field)!;
    if (!resolveTargetDef(relDef.target, this.schema))
      throw new OGMError(
        `Cannot resolve the target type "${relDef.target}" of relationship "${field}".`,
      );
    const relVar = `r${counter.count}`;
    counter.count++;
    const pattern = buildRelPattern({
      sourceVar: nodeVar,
      relDef,
      targetVar: relVar,
      targetLabel: 'auto',
      // Pass schema so that union/interface targets resolve to a
      // labelless target (relationship-type-only filter). Without this,
      // the literal abstract type name is escaped as a label that no
      // concrete node carries → NOT EXISTS is true for every row → ALL
      // rows match.
      schema: this.schema,
    });
    return exists
      ? `EXISTS { MATCH ${pattern} }`
      : `NOT EXISTS { MATCH ${pattern} }`;
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
      // Same null semantics as node properties (v2.3.0).
      if (value === null) {
        clauses.push(this.compileNullScalar(key, edgeVar, propsDef, edgeScope));
        continue;
      }
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
    // Temporal fields: with properties stored as native temporals (the
    // mutation compiler wraps ISO-string writes in datetime()/date()/...),
    // comparing them against a raw string param is a cross-type
    // comparison — Neo4j evaluates it to NULL and silently drops the row.
    // Wrap the param in the field's temporal constructor for
    // comparison-shaped operators. A wrapped param is no longer a string,
    // so case-insensitive toLower() must not apply to either side.
    const rawParamRef = wrapWhereParam(
      `$${paramName}`,
      value,
      propsHolder?.properties.get(fieldName),
      operator ?? '',
    );
    const temporalWrapped = rawParamRef !== `$${paramName}`;

    if (operator === null) {
      // Exact match — always CI-aware
      const fieldRef =
        caseInsensitive && !temporalWrapped
          ? `toLower(${rawFieldRef})`
          : rawFieldRef;
      const paramRef =
        caseInsensitive && !temporalWrapped
          ? `toLower(${rawParamRef})`
          : rawParamRef;
      return {
        cypher: `${fieldRef} = ${paramRef}`,
        params: { [paramName]: value },
      };
    }

    const opDef = OPERATOR_MAP.get(operator);
    if (!opDef) throw new OGMError(`Unknown operator: ${operator}`);

    // ReDoS guard: `_MATCHES` forwards its value into Neo4j's backtracking
    // `=~` engine. Refuse any pattern not provably free of catastrophic
    // backtracking before it can reach the server. The value is already
    // parameterized — this is a semantic guard on the operator, not
    // injection defense. Non-string values fall through untouched.
    if (operator === '_MATCHES' && typeof value === 'string')
      assertSafeRegexPattern(value, 'where clause');

    const ci = caseInsensitive && opDef.ciAware && !temporalWrapped;
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
export function stitchUserAndPolicy(
  userBody: string,
  policyClause: string,
): string {
  if (!userBody) return policyClause;
  if (!policyClause) return userBody;
  return `(${userBody}) AND ${policyClause}`;
}

/**
 * `_ALL` body (v2.3.0): a related node the caller may SEE (`policy`) that
 * fails the caller's filter. The policy sits OUTSIDE the negation, so
 * hidden related nodes neither satisfy nor falsify the quantifier.
 */
function stitchAllCounterexample(
  userBody: string,
  policyClause: string,
): string {
  return policyClause
    ? `${policyClause} AND NOT (${userBody})`
    : `NOT (${userBody})`;
}

/**
 * The bundle a traversal's USER filter compiles under (v2.3.0): no clause
 * for the target itself (its policy is composed separately by the caller),
 * but `resolveForType` stays live so deeper traversals keep enforcing.
 *
 * @internal
 */
export function traversalBundle(
  policyContext: PolicyContextBundle,
): PolicyContextBundle {
  return { ...policyContext, operation: 'read', resolved: NO_ROOT_POLICY };
}

/**
 * Compose compiled policy fragments into the single boolean clause
 * `(P1 OR P2 …) AND R1 AND R2 …` that `compile()` AND-stitches into the
 * WHERE. This is the ONLY place that composition happens: `compile()`
 * stitches its output, and `Model.explainPolicies` projects the very
 * same string as its enforcement verdict — so the two cannot disagree.
 */
function composePolicyClause(fragments: CompiledPolicyFragments): string {
  // Default-deny: no permissives matched. The Model call site is
  // responsible for raising `PolicyDeniedError` BEFORE compile when
  // `defaults.onDeny === 'throw'`. At compile time we always fall
  // back to `false` so the query is safe even if the call-site
  // throw is bypassed (defense in depth, not the primary path).
  if (fragments.permissives.length === 0) return 'false';

  const permFrags = fragments.permissives.flatMap((c) => c.parts);
  const restFrags = fragments.restrictives.flatMap((c) => c.parts);

  // At least one permissive matched. Compose `(perm) AND (rest)`.
  //
  // SECURITY FIX (v1.8.2 — CRITICAL): Pre-1.8.2 emitted `'true'` here
  // when `permFrags.length === 0`, on the assumption that an empty
  // permFrags meant "every permissive returned an empty partial,
  // which is match-anything". That assumption was WRONG and silently
  // inverted the deny default in three documented patterns:
  //
  //   permissive: [{ when: (ctx) => ctx.userId ? {...} : null }]
  //                                              ^^^ abstain
  //   permissive: [{ when: (ctx) => undefined }]
  //   permissive: [{ cypher: { fragment: () => '', params: ... } }]
  //
  // In every case, `permFrags` ended up empty and the compiler emitted
  // `WHERE true`, dumping unrestricted data. The bug survived TS
  // checks, code review, and the v1.7.0 NLS audit because "abstain"
  // and "match-anything" looked indistinguishable at this layer.
  //
  // Permissives are an ALLOW-LIST. If no rule fires, access is DENIED.
  // The explicit "match-anything" path is preserved: when a developer
  // writes `when: () => ({})`, `compilePolicyFragments` still pushes
  // `'true'` as that permissive's part, so permFrags.length > 0 and we
  // take the else branch. The migration path for users relying on the
  // old abstain-as-allow behaviour is to write `when: () => ({})`
  // instead of `when: () => null`.
  const permClause =
    permFrags.length === 0
      ? 'false'
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

/**
 * The boolean value ONE compiled policy contributes to
 * `composePolicyClause`, as a standalone expression (explain path): a
 * permissive's parts are OR-ed — they join the permissive disjunction —
 * and a restrictive's parts are AND-ed — they join the restrictive
 * conjunction. OR/AND are associative in Cypher's three-valued logic,
 * so grouping per policy preserves the composed clause's truth value.
 *
 * Returns `null` when the policy has no parts (it abstained).
 */
export function policyValueExpression(
  kind: 'permissive' | 'restrictive',
  parts: ReadonlyArray<string>,
): string | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `(${parts.join(kind === 'permissive' ? ' OR ' : ' AND ')})`;
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
