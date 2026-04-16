import {
  Kind,
  parse,
  type DocumentNode,
  type FieldNode,
  type InlineFragmentNode,
  type SelectionSetNode,
} from 'graphql';

import { OGMError } from '../errors';
import type { NodeDefinition, SchemaMetadata } from '../schema/types';
import { buildRelPattern, resolveTargetDef } from '../schema/utils';
import {
  assertSafeIdentifier,
  escapeIdentifier,
  isPlainObject,
  mergeParams,
} from '../utils/validation';
import type { WhereCompiler } from './where.compiler';

/**
 * Represents a single node in the parsed selection tree.
 */
export interface SelectionNode {
  fieldName: string;
  alias?: string;
  isScalar: boolean;
  isRelationship: boolean;
  isConnection: boolean;
  children?: SelectionNode[];
  /** WHERE filter for relationship pattern comprehensions (Prisma-like select) */
  relationshipWhere?: Record<string, unknown>;
  connectionWhere?: Record<string, unknown>;
  edgeChildren?: SelectionNode[];
  /** Sort spec for array relationship pattern comprehensions (Prisma-like select) */
  orderBy?: Array<{ field: string; direction: 'ASC' | 'DESC' }>;
  /**
   * Sort spec for connection edges. Each entry targets either the related node
   * scalars (`scope: 'node'`) or @relationshipProperties scalars (`scope: 'edge'`).
   */
  connectionOrderBy?: Array<{
    field: string;
    direction: 'ASC' | 'DESC';
    scope: 'node' | 'edge';
  }>;
}

/**
 * Compiles a selection set (parsed SelectionNode[]) into a Cypher RETURN map projection.
 *
 * Handles scalar fields, relationship pattern comprehensions (array and singular),
 * connection fields with edge properties, and nested traversals with depth limiting.
 */
export class SelectionCompiler {
  private static readonly DEFAULT_MAX_DEPTH = 5;
  /**
   * Cache of parsed selection sets capped at 200 entries.
   * No eviction — assumes bounded selection set variety (fixed set of
   * selectionSet strings used across resolvers). Stops adding after 200.
   */
  private parseCache = new Map<string, SelectionNode[]>();
  private whereCompiler?: WhereCompiler;

  constructor(
    private schema: SchemaMetadata,
    whereCompiler?: WhereCompiler,
  ) {
    this.whereCompiler = whereCompiler;
  }

  /** Clear the parse cache. Useful in tests to prevent cross-test pollution. */
  clearCache(): void {
    this.parseCache.clear();
  }

  /**
   * Compile selection nodes into a Cypher map projection string.
   *
   * @param selection - Parsed selection nodes
   * @param nodeVar - Cypher variable for the matched node (e.g., 'n')
   * @param nodeDef - Node definition from schema metadata
   * @param maxDepth - Maximum traversal depth (default 5)
   * @param currentDepth - Current depth (used internally for recursion)
   * @returns Cypher map projection string, e.g. "n { .id, .name, drugs: [...] }"
   */
  compile(
    selection: SelectionNode[],
    nodeVar: string,
    nodeDef: NodeDefinition,
    maxDepth: number = SelectionCompiler.DEFAULT_MAX_DEPTH,
    currentDepth: number = 0,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
  ): string {
    if (selection.length === 0) return `${nodeVar} { .id }`;

    // Check if this nodeDef is a resolved union type — if so, relationship
    // fields need CASE WHEN branches since different union members may have
    // the same field name but different underlying relationship types.
    const unionMembers = this.schema.unions?.get(nodeDef.typeName);
    const interfaceDef = this.schema.interfaces?.get(nodeDef.typeName);
    const isAbstract =
      (unionMembers && unionMembers.length > 0) ||
      (interfaceDef &&
        interfaceDef.implementedBy &&
        interfaceDef.implementedBy.length > 0);

    const parts: string[] = [];

    // Auto-emit __typename for abstract targets (unions/interfaces). Callers
    // of a discriminated type cannot narrow the returned object without
    // __typename, and requiring them to remember a boilerplate
    // `__typename: true` is a footgun — type guards silently return false
    // with no signal. Skip if the caller already asked for it explicitly.
    if (isAbstract) {
      const alreadyRequested = selection.some(
        (node) => node.isScalar && node.fieldName === '__typename',
      );
      if (!alreadyRequested) {
        const typenameExpr = this.compileTypename(nodeVar, nodeDef);
        if (typenameExpr) parts.push(`__typename: ${typenameExpr}`);
      }
    }

    for (const node of selection) {
      if (node.isScalar) {
        // __typename is a GraphQL concept — Neo4j nodes don't have this property.
        // Synthesize it from node labels for union targets, or emit a constant.
        if (node.fieldName === '__typename') {
          const typenameExpr = this.compileTypename(nodeVar, nodeDef);
          if (typenameExpr) parts.push(`__typename: ${typenameExpr}`);
          continue;
        }

        assertSafeIdentifier(node.fieldName, 'selection field');
        parts.push(`.${escapeIdentifier(node.fieldName)}`);
        continue;
      }

      if (node.isConnection) {
        const connectionCypher = this.compileConnection(
          node,
          nodeVar,
          nodeDef,
          maxDepth,
          currentDepth,
          params,
          paramCounter,
        );
        if (connectionCypher)
          parts.push(`${node.fieldName}: ${connectionCypher}`);

        continue;
      }

      if (node.isRelationship) {
        // For union targets, relationship fields may have different relationship
        // types across members. Generate CASE WHEN branches per member.
        if (unionMembers && unionMembers.length > 0) {
          const caseCypher = this.compileUnionRelationshipField(
            node,
            nodeVar,
            unionMembers,
            maxDepth,
            currentDepth,
            params,
            paramCounter,
          );
          if (caseCypher) parts.push(`${node.fieldName}: ${caseCypher}`);
          continue;
        }

        const relCypher = this.compileRelationship(
          node,
          nodeVar,
          nodeDef,
          maxDepth,
          currentDepth,
          params,
          paramCounter,
        );
        if (relCypher) parts.push(`${node.fieldName}: ${relCypher}`);

        continue;
      }
    }

    return `${nodeVar} { ${parts.join(', ')} }`;
  }

  /**
   * Parse a GraphQL selection set string into SelectionNode[].
   *
   * @param selectionSet - Raw string like "\{ id name drugs \{ id \} \}"
   * @returns Parsed SelectionNode array
   */
  parseSelectionSet(selectionSet: string): SelectionNode[] {
    const cached = this.parseCache.get(selectionSet);
    if (cached) return cached;

    const trimmed = selectionSet.trim();
    // Wrap in a dummy query so graphql parser can handle it
    const query = `query { dummy ${trimmed} }`;

    let doc: DocumentNode;
    try {
      doc = parse(query);
    } catch (err) {
      throw new OGMError(
        `Failed to parse selectionSet: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const opDef = doc.definitions[0];
    if (opDef.kind !== Kind.OPERATION_DEFINITION) return [];

    const dummyField = opDef.selectionSet.selections[0];
    if (dummyField.kind !== Kind.FIELD || !dummyField.selectionSet) return [];

    const result = this.convertSelectionSet(dummyField.selectionSet);

    if (this.parseCache.size < 200) this.parseCache.set(selectionSet, result);

    return result;
  }

  /**
   * Convert a GraphQL SelectionSetNode into SelectionNode[].
   */
  private convertSelectionSet(selectionSet: SelectionSetNode): SelectionNode[] {
    const nodes: SelectionNode[] = [];
    const seen = new Set<string>();

    for (const sel of selectionSet.selections) {
      // Handle inline fragments (... on Type { fields }) by merging their fields
      if (sel.kind === Kind.INLINE_FRAGMENT) {
        const fragment = sel as InlineFragmentNode;
        if (fragment.selectionSet)
          for (const merged of this.convertSelectionSet(fragment.selectionSet))
            if (!seen.has(merged.fieldName)) {
              seen.add(merged.fieldName);
              nodes.push(merged);
            }

        continue;
      }

      if (sel.kind !== Kind.FIELD) continue;
      const field = sel as FieldNode;
      const fieldName = field.name.value;

      if (seen.has(fieldName)) continue;
      seen.add(fieldName);

      const hasChildren = !!field.selectionSet;
      const isConnection = fieldName.endsWith('Connection');

      const node: SelectionNode = {
        fieldName,
        alias: field.alias?.value,
        isScalar: !hasChildren,
        isRelationship: hasChildren && !isConnection,
        isConnection,
      };

      if (hasChildren && field.selectionSet)
        if (isConnection)
          // For connections, parse edges -> node and edges -> properties
          this.parseConnectionChildren(field.selectionSet, node);
        else node.children = this.convertSelectionSet(field.selectionSet);

      nodes.push(node);
    }

    return nodes;
  }

  /**
   * Parse the children of a connection field, extracting node and edge children.
   */
  private parseConnectionChildren(
    selectionSet: SelectionSetNode,
    parentNode: SelectionNode,
  ): void {
    for (const sel of selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) continue;
      const field = sel as FieldNode;

      if (field.name.value === 'edges' && field.selectionSet)
        for (const edgeSel of field.selectionSet.selections) {
          if (edgeSel.kind !== Kind.FIELD) continue;
          const edgeField = edgeSel as FieldNode;

          if (edgeField.name.value === 'node' && edgeField.selectionSet)
            parentNode.children = this.convertSelectionSet(
              edgeField.selectionSet,
            );

          if (edgeField.name.value === 'properties' && edgeField.selectionSet)
            parentNode.edgeChildren = this.convertSelectionSet(
              edgeField.selectionSet,
            );
        }
    }
  }

  /**
   * Compile a relationship field into a Cypher pattern comprehension.
   */
  private compileRelationship(
    node: SelectionNode,
    parentVar: string,
    parentDef: NodeDefinition,
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
  ): string | null {
    if (currentDepth >= maxDepth) return null;

    const relDef = parentDef.relationships.get(node.fieldName);
    if (!relDef) return null;

    const targetDef = resolveTargetDef(relDef.target, this.schema);
    if (!targetDef) return null;

    const childVar = `n${currentDepth}`;
    const pattern = buildRelPattern({
      sourceVar: parentVar,
      relDef,
      targetVar: childVar,
      targetLabel: 'auto',
      schema: this.schema,
    });

    const children = node.children ?? [];
    const innerProjection = this.compile(
      children,
      childVar,
      targetDef,
      maxDepth,
      currentDepth + 1,
      params,
      paramCounter,
    );

    // Compile WHERE clause for relationship filtering (Prisma-like select)
    let whereClause = '';
    if (
      node.relationshipWhere &&
      Object.keys(node.relationshipWhere).length > 0 &&
      this.whereCompiler &&
      params &&
      paramCounter
    ) {
      const whereResult = this.whereCompiler.compile(
        node.relationshipWhere,
        childVar,
        targetDef,
        paramCounter,
      );
      if (whereResult.cypher) {
        mergeParams(params, whereResult.params);
        whereClause = ` WHERE ${whereResult.cypher}`;
      }
    }

    const comprehension = `[${pattern}${whereClause} | ${innerProjection}]`;

    // Wrap singular relationships with head()
    if (!relDef.isArray) return `head(${comprehension})`;

    // Wrap with apoc.coll.sortMulti() if orderBy is present.
    // Requires the APOC plugin installed on the Neo4j instance.
    if (node.orderBy && node.orderBy.length > 0) {
      const sortKeys = node.orderBy
        .map(({ field, direction }) => {
          assertSafeIdentifier(field, 'orderBy sort key');
          // apoc.coll.sortMulti convention: ^ prefix = ASC, no prefix = DESC
          return direction === 'ASC' ? `'^${field}'` : `'${field}'`;
        })
        .join(', ');
      return `apoc.coll.sortMulti(${comprehension}, [${sortKeys}])`;
    }

    return comprehension;
  }

  /**
   * Compile a relationship field within a union-target context.
   *
   * Different union members can have the same field name (e.g., "populations")
   * but different underlying Neo4j relationship types. This generates a
   * CASE WHEN expression that checks the node's labels and uses the correct
   * relationship type for each member.
   *
   * Example output:
   *   CASE
   *     WHEN n0:FormPresentationIcon THEN [(n0)-[:FP_POP]->(p:Population) | p { .id }]
   *     WHEN n0:AdministrationRateIcon THEN [(n0)-[:AR_POP]->(p:Population) | p { .id }]
   *     ELSE []
   *   END
   */
  private compileUnionRelationshipField(
    node: SelectionNode,
    nodeVar: string,
    unionMembers: string[],
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
  ): string | null {
    if (currentDepth >= maxDepth) return null;

    const branches: string[] = [];
    let isSingular = false;

    for (const memberName of unionMembers) {
      const memberDef = this.schema.nodes.get(memberName);
      if (!memberDef) continue;

      const relDef = memberDef.relationships.get(node.fieldName);
      if (!relDef) continue;

      const targetDef = resolveTargetDef(relDef.target, this.schema);
      if (!targetDef) continue;

      // Track whether this is a singular (non-array) relationship
      if (!relDef.isArray) isSingular = true;

      const childVar = `n${currentDepth}`;
      const children = node.children ?? [];
      const innerProjection = this.compile(
        children,
        childVar,
        targetDef,
        maxDepth,
        currentDepth + 1,
        params,
        paramCounter,
      );

      const pattern = buildRelPattern({
        sourceVar: nodeVar,
        relDef,
        targetVar: childVar,
        targetLabel: 'auto',
        schema: this.schema,
      });

      // Wrap singular relationships with head() to return object instead of array
      const comprehension = isSingular
        ? `head([${pattern} | ${innerProjection}])`
        : `[${pattern} | ${innerProjection}]`;
      const memberLabel = escapeIdentifier(memberName);
      branches.push(`WHEN ${nodeVar}:${memberLabel} THEN ${comprehension}`);
    }

    if (branches.length === 0) return null;

    const elseClause = isSingular ? 'null' : '[]';
    return `CASE ${branches.join(' ')} ELSE ${elseClause} END`;
  }

  /**
   * Compile a connection field into a Cypher pattern comprehension with edge properties.
   */
  private compileConnection(
    node: SelectionNode,
    parentVar: string,
    parentDef: NodeDefinition,
    maxDepth: number,
    currentDepth: number,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
  ): string | null {
    if (currentDepth >= maxDepth) return null;

    // Strip 'Connection' suffix to find the relationship field
    const baseFieldName = node.fieldName.replace(/Connection$/, '');
    const relDef = parentDef.relationships.get(baseFieldName);
    if (!relDef) return null;

    const targetDef = resolveTargetDef(relDef.target, this.schema);
    if (!targetDef) return null;

    const childVar = `n${currentDepth}`;
    const edgeVar = `e${currentDepth}`;
    const pattern = buildRelPattern({
      sourceVar: parentVar,
      relDef,
      targetVar: childVar,
      edgeVar,
      targetLabel: 'auto',
      schema: this.schema,
    });

    const mapParts: string[] = [];
    const projectionKeys: string[] = [];

    // Compile node projection
    if (node.children && node.children.length > 0) {
      const nodeProjection = this.compile(
        node.children,
        childVar,
        targetDef,
        maxDepth,
        currentDepth + 1,
        params,
        paramCounter,
      );
      mapParts.push(`node: ${nodeProjection}`);
      projectionKeys.push('node');
    }

    // Compile edge properties projection
    if (node.edgeChildren && node.edgeChildren.length > 0) {
      const edgeFields = node.edgeChildren
        .filter((c) => c.isScalar)
        .map((c) => `.${escapeIdentifier(c.fieldName)}`)
        .join(', ');
      mapParts.push(`properties: ${edgeVar} { ${edgeFields} }`);
      projectionKeys.push('properties');
    }

    // Inject synthetic sort scalars at the top level of the edge map so
    // apoc.coll.sortMulti (which only accepts top-level keys) can order the
    // collection. The outer list comprehension strips them on the way out.
    const sortKeyTokens: string[] = [];
    if (node.connectionOrderBy && node.connectionOrderBy.length > 0)
      node.connectionOrderBy.forEach(({ field, direction, scope }, i) => {
        assertSafeIdentifier(field, 'connection orderBy field');
        const sourceVar = scope === 'edge' ? edgeVar : childVar;
        const syntheticKey = `__sk${i}`;
        mapParts.push(
          `${syntheticKey}: ${sourceVar}.${escapeIdentifier(field)}`,
        );
        // apoc.coll.sortMulti convention: ^ prefix = ASC, no prefix = DESC
        sortKeyTokens.push(
          direction === 'ASC' ? `'^${syntheticKey}'` : `'${syntheticKey}'`,
        );
      });

    const innerMap = `{ ${mapParts.join(', ')} }`;

    // Add WHERE clause if connectionWhere is present
    let whereClause = '';
    if (node.connectionWhere && Object.keys(node.connectionWhere).length > 0) {
      // Reject unsupported edge WHERE filters with a descriptive error
      if (node.connectionWhere.edge !== undefined)
        throw new OGMError(
          `Connection WHERE with "edge" filters is not supported. ` +
            `Only "node" filters are supported for connection "${node.fieldName}".`,
        );

      // Unwrap { node: { ... } } wrapper if present
      const nodeWhere = isPlainObject(node.connectionWhere.node)
        ? node.connectionWhere.node
        : node.connectionWhere;

      // If we have a full WhereCompiler, delegate to it for complete operator support
      if (this.whereCompiler && targetDef) {
        const whereResult = this.whereCompiler.compile(
          nodeWhere,
          childVar,
          targetDef,
          paramCounter,
        );
        if (whereResult.cypher) {
          if (params) mergeParams(params, whereResult.params);
          whereClause = ` WHERE ${whereResult.cypher}`;
        }
      } else {
        const simpleWhere = this.compileSimpleWhere(
          node.connectionWhere,
          childVar,
          params,
          paramCounter,
        );
        if (simpleWhere) whereClause = ` WHERE ${simpleWhere}`;
      }
    }

    if (sortKeyTokens.length === 0)
      return `{ edges: [${pattern}${whereClause} | ${innerMap}] }`;

    // Re-project only the user-facing keys so synthetic __skN scalars don't
    // leak out of the projection.
    const outerProjection =
      projectionKeys.length > 0
        ? `{ ${projectionKeys.map((k) => `${k}: x.${k}`).join(', ')} }`
        : `{}`;
    return `{ edges: [x IN apoc.coll.sortMulti([${pattern}${whereClause} | ${innerMap}], [${sortKeyTokens.join(
      ', ',
    )}]) | ${outerProjection}] }`;
  }

  /**
   * Compile a __typename expression for a node.
   * For union targets: picks the label matching a union member name.
   * For concrete types: returns a string constant.
   */
  private compileTypename(nodeVar: string, nodeDef: NodeDefinition): string {
    const unionMembers = this.schema.unions?.get(nodeDef.typeName);
    if (unionMembers && unionMembers.length > 0) {
      const memberList = unionMembers.map((m) => `'${m}'`).join(', ');
      return `head([__label IN labels(${nodeVar}) WHERE __label IN [${memberList}]])`;
    }
    const interfaceDef = this.schema.interfaces?.get(nodeDef.typeName);
    if (
      interfaceDef &&
      interfaceDef.implementedBy &&
      interfaceDef.implementedBy.length > 0
    ) {
      const memberList = interfaceDef.implementedBy
        .map((m) => `'${m}'`)
        .join(', ');
      return `head([__label IN labels(${nodeVar}) WHERE __label IN [${memberList}]])`;
    }
    return `'${nodeDef.typeName}'`;
  }

  /**
   * Compile a simple where object into a Cypher WHERE clause fragment.
   * This is a minimal implementation for connection where filters.
   */
  private compileSimpleWhere(
    where: Record<string, unknown>,
    nodeVar: string,
    params?: Record<string, unknown>,
    paramCounter?: { count: number },
  ): string {
    if (!params || !paramCounter)
      throw new OGMError(
        'compileSimpleWhere requires params and paramCounter for safe parameterization',
      );

    const conditions: string[] = [];
    for (const [key, value] of Object.entries(where)) {
      // Handle nested { node: { ... } } pattern
      if (key === 'node' && isPlainObject(value))
        return this.compileSimpleWhere(value, nodeVar, params, paramCounter);

      if (key.endsWith('_IN') && Array.isArray(value)) {
        const fieldName = key.slice(0, -3);
        assertSafeIdentifier(fieldName, 'connection where');
        const paramName = `sel_param${paramCounter.count++}`;
        params[paramName] = value;
        conditions.push(
          `${nodeVar}.${escapeIdentifier(fieldName)} IN $${paramName}`,
        );
      } else if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        assertSafeIdentifier(key, 'connection where');
        const paramName = `sel_param${paramCounter.count++}`;
        params[paramName] = value;
        conditions.push(`${nodeVar}.${escapeIdentifier(key)} = $${paramName}`);
      }
    }
    return conditions.join(' AND ');
  }
}
