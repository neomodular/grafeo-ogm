import { OGMError } from '../errors';
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

const RELATIONSHIP_SUFFIXES = ['_SOME', '_NONE', '_ALL', '_SINGLE'] as const;
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
}

/**
 * Compiles a Where input object into a Cypher WHERE clause fragment + params.
 */
export class WhereCompiler {
  private disabledOperators: Set<OperatorSuffix>;

  constructor(
    private schema: SchemaMetadata,
    options?: WhereCompilerOptions,
  ) {
    this.disabledOperators = options?.disabledOperators ?? new Set();
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
    },
  ): WhereResult {
    if (where == null || Object.keys(where).length === 0)
      return { cypher: '', params: {} };

    // Top-level scope — preludes here are returned to the caller for stitching
    // BEFORE the WHERE clause. Nested scopes (relationship quantifiers) build
    // their own scopes and stitch their preludes into the EXISTS body inline.
    const scope = new CypherFieldScope(
      nodeVar,
      options?.preserveVars ?? [],
      '__where',
    );
    const inner = this.compileConditions(
      where,
      nodeVar,
      nodeDef,
      paramCounter,
      0,
      scope,
    );

    const result: WhereResult = {
      cypher: inner.cypher,
      params: inner.params,
    };
    if (scope.hasAny()) result.preludes = scope.emit();
    return result;
  }

  private compileConditions(
    where: Record<string, unknown>,
    nodeVar: string,
    nodeDef: NodeDefinition,
    counter: { count: number },
    depth: number,
    scope: CypherFieldScope,
  ): WhereResult {
    if (depth > MAX_DEPTH)
      throw new OGMError(
        `WHERE clause nesting depth exceeds maximum (${MAX_DEPTH})`,
      );
    if (where == null) return { cypher: '', params: {} };

    const caseInsensitive = where.mode === 'insensitive';

    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (key === 'mode') continue;
      assertSafeKey(key, 'where input');

      // Logical operators (check before null handling so NOT with null value is handled correctly)
      if (key === 'AND' || key === 'OR') {
        const items = value as Record<string, unknown>[];
        const subResults = items.map((item) =>
          this.compileConditions(
            item,
            nodeVar,
            nodeDef,
            counter,
            depth + 1,
            scope,
          ),
        );
        const subClauses = subResults.map((r) => r.cypher).filter(Boolean);
        if (subClauses.length > 0) {
          clauses.push(`(${subClauses.join(` ${key} `)})`);
          for (const r of subResults) mergeParams(params, r.params);
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
        );
        if (sub.cypher) {
          clauses.push(`NOT (${sub.cypher})`);
          mergeParams(params, sub.params);
        }
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
    });

    const innerClauses: string[] = [];
    const innerParams: Record<string, unknown> = {};

    // Inner scopes for any `@cypher` projections referenced inside the
    // EXISTS body. Node-side and edge-side get separate scopes so their
    // alias namespaces are distinct (and so that no edge variable carries
    // node aliases or vice-versa).
    const nodeScope = new CypherFieldScope(relVar, [], '__where');
    const edgeScope = new CypherFieldScope(edgeVar, [], '__where');

    // node conditions
    if (value.node) {
      const nodeResult = this.compileConditions(
        value.node as Record<string, unknown>,
        relVar,
        targetNodeDef,
        counter,
        depth + 1,
        nodeScope,
      );
      if (nodeResult.cypher) {
        innerClauses.push(nodeResult.cypher);
        mergeParams(innerParams, nodeResult.params);
      }
    }

    // edge conditions
    if (value.edge && relDef.properties) {
      const propsDef = this.schema.relationshipProperties.get(
        relDef.properties,
      );
      if (propsDef) {
        const edgeResult = this.compileEdgeConditions(
          value.edge as Record<string, unknown>,
          edgeVar,
          propsDef,
          edgeScope,
          counter,
        );
        if (edgeResult.cypher) {
          innerClauses.push(edgeResult.cypher);
          mergeParams(innerParams, edgeResult.params);
        }
      }
    }

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

        counter.count++;
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
