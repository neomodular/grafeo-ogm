import { OGMError } from '../errors';
import {
  NodeDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../schema/types';
import { getTargetLabelString, resolveTargetDef } from '../schema/utils';
import {
  assertSafeIdentifier,
  assertSafeKey,
  escapeIdentifier,
} from '../utils/validation';

export interface WhereResult {
  cypher: string;
  params: Record<string, unknown>;
}

const MAX_DEPTH = 10;

/** Ordered longest-first so greedy matching works */
const OPERATOR_SUFFIXES = [
  '_NOT_STARTS_WITH',
  '_NOT_ENDS_WITH',
  '_NOT_CONTAINS',
  '_NOT_IN',
  '_STARTS_WITH',
  '_ENDS_WITH',
  '_CONTAINS',
  '_MATCHES',
  '_GTE',
  '_LTE',
  '_NOT',
  '_GT',
  '_LT',
  '_IN',
] as const;

type OperatorSuffix = (typeof OPERATOR_SUFFIXES)[number];

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
  ): WhereResult {
    if (where == null || Object.keys(where).length === 0)
      return { cypher: '', params: {} };

    return this.compileConditions(where, nodeVar, nodeDef, paramCounter, 0);
  }

  private compileConditions(
    where: Record<string, unknown>,
    nodeVar: string,
    nodeDef: NodeDefinition,
    counter: { count: number },
    depth: number,
  ): WhereResult {
    if (depth > MAX_DEPTH)
      throw new OGMError(
        `WHERE clause nesting depth exceeds maximum (${MAX_DEPTH})`,
      );
    if (where == null) return { cypher: '', params: {} };

    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      assertSafeKey(key, 'where input');

      // Logical operators (check before null handling so NOT with null value is handled correctly)
      if (key === 'AND' || key === 'OR') {
        const items = value as Record<string, unknown>[];
        const subResults = items.map((item) =>
          this.compileConditions(item, nodeVar, nodeDef, counter, depth + 1),
        );
        const subClauses = subResults.map((r) => r.cypher).filter(Boolean);
        if (subClauses.length > 0) {
          clauses.push(`(${subClauses.join(` ${key} `)})`);
          for (const r of subResults) Object.assign(params, r.params);
        }
        continue;
      }

      if (key === 'NOT') {
        if (value === null)
          // NOT: null inside a relationship context is a no-op (handled by bare relationship _SOME)
          continue;

        const sub = this.compileConditions(
          value as Record<string, unknown>,
          nodeVar,
          nodeDef,
          counter,
          depth + 1,
        );
        if (sub.cypher) {
          clauses.push(`NOT (${sub.cypher})`);
          Object.assign(params, sub.params);
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
            const pattern = this.buildRelPattern(nodeVar, relDef, relVar);
            clauses.push(`NOT EXISTS { MATCH ${pattern} }`);
          }
        } else {
          // Scalar null means "property IS NULL"
          assertSafeIdentifier(key, 'where clause');
          clauses.push(`${nodeVar}.${escapeIdentifier(key)} IS NULL`);
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
        Object.assign(params, connResult.params);
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
        Object.assign(params, relResult.params);
        continue;
      }

      // Scalar property operators
      const scalarResult = this.compileScalarCondition(
        key,
        value,
        nodeVar,
        counter,
      );
      clauses.push(scalarResult.cypher);
      Object.assign(params, scalarResult.params);
    }

    return {
      cypher: clauses.join(' AND '),
      params,
    };
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
        `Target node "${relDef.target}" not found in schema for connection "${key}"`,
      );

    const relVar = `r${counter.count}`;
    const edgeVar = `e${counter.count}`;
    counter.count++;

    const pattern = this.buildRelPattern(nodeVar, relDef, relVar, edgeVar);

    const innerClauses: string[] = [];
    const innerParams: Record<string, unknown> = {};

    // node conditions
    if (value.node) {
      const nodeResult = this.compileConditions(
        value.node as Record<string, unknown>,
        relVar,
        targetNodeDef,
        counter,
        depth + 1,
      );
      if (nodeResult.cypher) {
        innerClauses.push(nodeResult.cypher);
        Object.assign(innerParams, nodeResult.params);
      }
    }

    // edge conditions
    if (value.edge && relDef.properties) {
      const propsDef = this.schema.relationshipProperties.get(
        relDef.properties,
      );
      if (propsDef) {
        // Build a pseudo NodeDefinition for edge property compilation
        const edgeResult = this.compileEdgeConditions(
          value.edge as Record<string, unknown>,
          edgeVar,
          counter,
        );
        if (edgeResult.cypher) {
          innerClauses.push(edgeResult.cypher);
          Object.assign(innerParams, edgeResult.params);
        }
      }
    }

    const whereClause =
      innerClauses.length > 0 ? ` WHERE ${innerClauses.join(' AND ')}` : '';

    switch (connSuffix) {
      case 'Connection':
      case 'Connection_SOME':
        return {
          cypher: `EXISTS { MATCH ${pattern}${whereClause} }`,
          params: innerParams,
        };
      case 'Connection_NOT':
      case 'Connection_NONE':
        return {
          cypher: `NOT EXISTS { MATCH ${pattern}${whereClause} }`,
          params: innerParams,
        };
      case 'Connection_ALL':
        if (innerClauses.length > 0)
          return {
            cypher: `NOT EXISTS { MATCH ${pattern} WHERE NOT (${innerClauses.join(' AND ')}) }`,
            params: innerParams,
          };

        return { cypher: '', params: {} };
      case 'Connection_SINGLE':
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
        `Target node "${relDef.target}" not found in schema for relationship "${key}"`,
      );

    const relVar = `r${counter.count}`;
    counter.count++;

    const pattern = this.buildRelPattern(nodeVar, relDef, relVar);

    const innerResult = this.compileConditions(
      value,
      relVar,
      targetNodeDef,
      counter,
      depth + 1,
    );

    const whereClause = innerResult.cypher
      ? ` WHERE ${innerResult.cypher}`
      : '';

    switch (suffix) {
      case '_SOME':
        return {
          cypher: `EXISTS { MATCH ${pattern}${whereClause} }`,
          params: innerResult.params,
        };
      case '_NONE':
        return {
          cypher: `NOT EXISTS { MATCH ${pattern}${whereClause} }`,
          params: innerResult.params,
        };
      case '_ALL':
        // All matching rels must satisfy: NOT EXISTS { MATCH pattern WHERE NOT (inner) }
        if (innerResult.cypher)
          return {
            cypher: `NOT EXISTS { MATCH ${pattern} WHERE NOT (${innerResult.cypher}) }`,
            params: innerResult.params,
          };

        return { cypher: '', params: {} };
      case '_SINGLE': {
        // Exactly one relationship satisfies
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
      if (!unionMembers.includes(memberKey)) continue;

      const memberDef = this.schema.nodes.get(memberKey);
      if (!memberDef) continue;

      const relVar = `r${counter.count}`;
      counter.count++;

      const labelStr = getTargetLabelString(memberDef);
      const pattern = this.buildRelPatternWithLabel(
        nodeVar,
        relDef,
        relVar,
        labelStr,
      );

      // Compile inner WHERE conditions for this member (if any properties specified)
      const memberWhere = memberValue as Record<string, unknown> | null;
      let whereClause = '';
      if (memberWhere && Object.keys(memberWhere).length > 0) {
        const innerResult = this.compileConditions(
          memberWhere,
          relVar,
          memberDef,
          counter,
          depth + 1,
        );
        if (innerResult.cypher) {
          whereClause = ` WHERE ${innerResult.cypher}`;
          Object.assign(allParams, innerResult.params);
        }
      }

      memberClauses.push(`EXISTS { MATCH ${pattern}${whereClause} }`);
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

  private buildRelPattern(
    nodeVar: string,
    relDef: RelationshipDefinition,
    targetVar: string,
    edgeVar?: string,
  ): string {
    const escapedType = escapeIdentifier(relDef.type);
    const edgePart = edgeVar
      ? `[${edgeVar}:${escapedType}]`
      : `[:${escapedType}]`;

    const escapedTarget = escapeIdentifier(relDef.target);
    if (relDef.direction === 'OUT')
      return `(${nodeVar})-${edgePart}->(${targetVar}:${escapedTarget})`;

    return `(${nodeVar})<-${edgePart}-(${targetVar}:${escapedTarget})`;
  }

  private buildRelPatternWithLabel(
    nodeVar: string,
    relDef: RelationshipDefinition,
    targetVar: string,
    labelStr: string,
    edgeVar?: string,
  ): string {
    const escapedType = escapeIdentifier(relDef.type);
    const edgePart = edgeVar
      ? `[${edgeVar}:${escapedType}]`
      : `[:${escapedType}]`;

    if (relDef.direction === 'OUT')
      return `(${nodeVar})-${edgePart}->(${targetVar}:${labelStr})`;

    return `(${nodeVar})<-${edgePart}-(${targetVar}:${labelStr})`;
  }

  private compileEdgeConditions(
    edgeWhere: Record<string, unknown>,
    edgeVar: string,
    counter: { count: number },
  ): WhereResult {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(edgeWhere)) {
      assertSafeKey(key, 'edge where input');
      const result = this.compileScalarCondition(key, value, edgeVar, counter);
      clauses.push(result.cypher);
      Object.assign(params, result.params);
    }

    return {
      cypher: clauses.join(' AND '),
      params,
    };
  }

  private compileScalarCondition(
    key: string,
    value: unknown,
    nodeVar: string,
    counter: { count: number },
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

    const fieldRef = `${nodeVar}.${escapeIdentifier(fieldName)}`;

    if (operator === null)
      // Exact match
      return {
        cypher: `${fieldRef} = $${paramName}`,
        params: { [paramName]: value },
      };

    switch (operator) {
      case '_IN':
        return {
          cypher: `${fieldRef} IN $${paramName}`,
          params: { [paramName]: value },
        };
      case '_NOT':
        return {
          cypher: `${fieldRef} <> $${paramName}`,
          params: { [paramName]: value },
        };
      case '_NOT_IN':
        return {
          cypher: `NOT ${fieldRef} IN $${paramName}`,
          params: { [paramName]: value },
        };
      case '_CONTAINS':
        return {
          cypher: `${fieldRef} CONTAINS $${paramName}`,
          params: { [paramName]: value },
        };
      case '_GTE':
        return {
          cypher: `${fieldRef} >= $${paramName}`,
          params: { [paramName]: value },
        };
      case '_LTE':
        return {
          cypher: `${fieldRef} <= $${paramName}`,
          params: { [paramName]: value },
        };
      case '_GT':
        return {
          cypher: `${fieldRef} > $${paramName}`,
          params: { [paramName]: value },
        };
      case '_LT':
        return {
          cypher: `${fieldRef} < $${paramName}`,
          params: { [paramName]: value },
        };
      case '_MATCHES':
        return {
          cypher: `${fieldRef} =~ $${paramName}`,
          params: { [paramName]: value },
        };
      case '_STARTS_WITH':
        return {
          cypher: `${fieldRef} STARTS WITH $${paramName}`,
          params: { [paramName]: value },
        };
      case '_ENDS_WITH':
        return {
          cypher: `${fieldRef} ENDS WITH $${paramName}`,
          params: { [paramName]: value },
        };
      case '_NOT_CONTAINS':
        return {
          cypher: `NOT ${fieldRef} CONTAINS $${paramName}`,
          params: { [paramName]: value },
        };
      case '_NOT_STARTS_WITH':
        return {
          cypher: `NOT ${fieldRef} STARTS WITH $${paramName}`,
          params: { [paramName]: value },
        };
      case '_NOT_ENDS_WITH':
        return {
          cypher: `NOT ${fieldRef} ENDS WITH $${paramName}`,
          params: { [paramName]: value },
        };
      default:
        throw new OGMError(`Unknown operator: ${operator}`);
    }
  }
}
