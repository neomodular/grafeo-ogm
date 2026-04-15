import { OGMError } from '../errors';
import type {
  NodeDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../schema/types';
import { resolveTargetDef } from '../schema/utils';
import {
  assertSafeIdentifier,
  assertSafeKey,
  assertSortDirection,
} from '../utils/validation';
import type { SelectionNode } from './selection.compiler';

/**
 * Converts a `select` object (used in the programmatic API) into the internal
 * SelectionNode[] AST that the SelectionCompiler operates on.
 *
 * Normalization rules:
 * - `{ field: true }` for a scalar → SelectionNode with isScalar: true
 * - `{ field: true }` for a relationship → all scalar properties of the target node
 * - `{ field: { select: { ... } } }` for a relationship → nested selection
 * - `{ fieldConnection: { where: {...}, select: { edges: { node: { select: {...} }, properties: { select: {...} } } } } }` → connection node
 * - `{ field: false }` or missing → omitted
 */
export class SelectNormalizer {
  /**
   * Cache of all-scalar-fields selections per type name.
   * Bounded by the number of node types in the schema (~50-100 entries).
   */
  private scalarFieldsCache = new Map<string, SelectionNode[]>();

  constructor(private schema: SchemaMetadata) {}

  /** Clear the scalar fields cache. Useful in tests to prevent cross-test pollution. */
  clearCache(): void {
    this.scalarFieldsCache.clear();
  }

  /**
   * Normalize a select object into SelectionNode[].
   *
   * @param select - Object like \{ id: true, name: true, drugs: \{ select: \{ id: true \} \} \}
   * @param nodeDef - Node definition from schema metadata
   * @returns Normalized SelectionNode array
   */
  normalize(
    select: Record<string, unknown>,
    nodeDef: NodeDefinition,
  ): SelectionNode[] {
    const nodes: SelectionNode[] = [];

    for (const [fieldName, value] of Object.entries(select)) {
      if (!value) continue; // false, null, undefined → skip

      assertSafeKey(fieldName, 'select input');

      const isConnection = fieldName.endsWith('Connection');

      if (isConnection) {
        const connectionNode = this.normalizeConnection(
          fieldName,
          value,
          nodeDef,
        );
        if (connectionNode) nodes.push(connectionNode);

        continue;
      }

      const relDef = nodeDef.relationships.get(fieldName);

      if (relDef) {
        // It's a relationship field
        const relNode = this.normalizeRelationship(fieldName, value, relDef);
        if (relNode) nodes.push(relNode);

        continue;
      }

      // It's a scalar field (property)
      if (value === true)
        nodes.push({
          fieldName,
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        });
    }

    return nodes;
  }

  /**
   * Normalize a relationship field value into a SelectionNode.
   */
  private normalizeRelationship(
    fieldName: string,
    value: unknown,
    relDef: { target: string; isArray: boolean },
  ): SelectionNode | null {
    // Use resolveTargetDef to handle union/interface targets (not just schema.nodes.get)
    const targetDef = resolveTargetDef(relDef.target, this.schema);
    if (!targetDef) return null;

    // `{ drugs: true }` → select all scalar fields from target
    if (value === true) {
      const children = [...this.allScalarFields(targetDef)];
      return {
        fieldName,
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children,
      };
    }

    // `{ drugs: { where: {...}, select: { id: true, drugName: true }, orderBy: {...} } }`
    if (typeof value === 'object' && value !== null) {
      const obj = value as Record<string, unknown>;
      if (obj.select && typeof obj.select === 'object') {
        let children = this.normalize(
          obj.select as Record<string, unknown>,
          targetDef,
        );
        // Empty select fallback: at minimum return the id field
        if (children.length === 0)
          children = [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ];

        const node: SelectionNode = {
          fieldName,
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children,
        };

        // Extract where clause for relationship filtering
        if (obj.where && typeof obj.where === 'object')
          node.relationshipWhere = obj.where as Record<string, unknown>;

        // Extract orderBy for nested sorting
        if (obj.orderBy !== undefined)
          node.orderBy = this.normalizeOrderBy(
            obj.orderBy,
            targetDef,
            fieldName,
            relDef.isArray,
          );

        return node;
      }

      // `{ drugs: { where: {...}, orderBy: {...} } }` → where with optional orderBy (select all scalars)
      if (obj.where && typeof obj.where === 'object') {
        const children = [...this.allScalarFields(targetDef)];
        const node: SelectionNode = {
          fieldName,
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children,
          relationshipWhere: obj.where as Record<string, unknown>,
        };

        if (obj.orderBy !== undefined)
          node.orderBy = this.normalizeOrderBy(
            obj.orderBy,
            targetDef,
            fieldName,
            relDef.isArray,
          );

        return node;
      }

      // `{ drugs: { orderBy: {...} } }` → orderBy-only (select all scalars)
      if (obj.orderBy !== undefined) {
        const children = [...this.allScalarFields(targetDef)];
        return {
          fieldName,
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children,
          orderBy: this.normalizeOrderBy(
            obj.orderBy,
            targetDef,
            fieldName,
            relDef.isArray,
          ),
        };
      }
    }

    return null;
  }

  /**
   * Normalize and validate an orderBy input into the internal format.
   * Accepts a single object `{ field: 'ASC' }` or an array `[{ field: 'ASC' }, ...]`.
   */
  private normalizeOrderBy(
    orderByInput: unknown,
    targetDef: NodeDefinition,
    fieldName: string,
    isArray: boolean,
  ): Array<{ field: string; direction: 'ASC' | 'DESC' }> {
    if (!isArray)
      throw new OGMError(
        `orderBy is not supported on singular relationship "${fieldName}". ` +
          `Sorting is only valid for array relationships.`,
      );

    const items = Array.isArray(orderByInput) ? orderByInput : [orderByInput];
    const result: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];

    for (const item of items) {
      if (typeof item !== 'object' || item === null)
        throw new OGMError(
          `Invalid orderBy entry on relationship "${fieldName}". ` +
            `Each entry must be an object like { field: 'ASC' }.`,
        );
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length === 0) continue;

      for (const [sortField, rawDirection] of entries) {
        assertSafeKey(sortField, 'orderBy field');
        assertSafeIdentifier(sortField, 'orderBy field');

        if (!targetDef.properties.has(sortField))
          throw new OGMError(
            `Invalid orderBy field "${sortField}" on relationship "${fieldName}". ` +
              `Field must be a scalar property of ${targetDef.typeName}.`,
          );

        const direction = assertSortDirection(String(rawDirection));
        result.push({ field: sortField, direction });
      }
    }

    return result;
  }

  /**
   * Normalize a connection field value into a SelectionNode.
   */
  private normalizeConnection(
    fieldName: string,
    value: unknown,
    nodeDef: NodeDefinition,
  ): SelectionNode | null {
    // Strip 'Connection' suffix to find the relationship
    const baseFieldName = fieldName.replace(/Connection$/, '');
    const relDef = nodeDef.relationships.get(baseFieldName);
    if (!relDef) return null;

    // Use resolveTargetDef to handle union/interface targets
    const targetDef = resolveTargetDef(relDef.target, this.schema);
    if (!targetDef) return null;

    const node: SelectionNode = {
      fieldName,
      isScalar: false,
      isRelationship: false,
      isConnection: true,
    };

    if (typeof value !== 'object' || value === null) return node;

    const obj = value as Record<string, unknown>;

    // Extract where clause
    if (obj.where && typeof obj.where === 'object')
      node.connectionWhere = obj.where as Record<string, unknown>;

    // Extract orderBy (node/edge scoped) for edge sorting
    if (obj.orderBy !== undefined)
      node.connectionOrderBy = this.normalizeConnectionOrderBy(
        obj.orderBy,
        targetDef,
        relDef,
        fieldName,
      );

    // Extract edges -> node and edges -> properties from select
    if (obj.select && typeof obj.select === 'object') {
      const selectObj = obj.select as Record<string, unknown>;

      if (selectObj.edges && typeof selectObj.edges === 'object') {
        const edgesObj = selectObj.edges as Record<string, unknown>;

        // edges.node.select -> children
        if (edgesObj.node && typeof edgesObj.node === 'object') {
          const nodeObj = edgesObj.node as Record<string, unknown>;
          if (nodeObj.select && typeof nodeObj.select === 'object') {
            const children = this.normalize(
              nodeObj.select as Record<string, unknown>,
              targetDef,
            );
            // Empty select fallback: at minimum return the id field
            node.children =
              children.length === 0
                ? [
                    {
                      fieldName: 'id',
                      isScalar: true,
                      isRelationship: false,
                      isConnection: false,
                    },
                  ]
                : children;
          }
        }

        // edges.properties.select -> edgeChildren
        if (edgesObj.properties && typeof edgesObj.properties === 'object') {
          const propsObj = edgesObj.properties as Record<string, unknown>;
          if (propsObj.select && typeof propsObj.select === 'object')
            node.edgeChildren = this.normalizeEdgeProperties(
              propsObj.select as Record<string, unknown>,
            );
        }
      }
    }

    return node;
  }

  /**
   * Normalize and validate a connection orderBy input.
   * Each entry must be an object with exactly one key: `node` or `edge`.
   * The inner value is a `{ field: 'ASC' | 'DESC' }` map, which may contain
   * multiple fields (preserving insertion order as sort priority).
   */
  private normalizeConnectionOrderBy(
    orderByInput: unknown,
    targetDef: NodeDefinition,
    relDef: RelationshipDefinition,
    fieldName: string,
  ): Array<{
    field: string;
    direction: 'ASC' | 'DESC';
    scope: 'node' | 'edge';
  }> {
    const items = Array.isArray(orderByInput) ? orderByInput : [orderByInput];
    const result: Array<{
      field: string;
      direction: 'ASC' | 'DESC';
      scope: 'node' | 'edge';
    }> = [];

    for (const item of items) {
      if (typeof item !== 'object' || item === null)
        throw new OGMError(
          `Invalid orderBy entry on connection "${fieldName}". ` +
            `Each entry must be an object like { node: { field: 'ASC' } } or { edge: { field: 'DESC' } }.`,
        );

      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length === 0) continue;
      if (entries.length > 1)
        throw new OGMError(
          `Invalid orderBy entry on connection "${fieldName}". ` +
            `Each entry must have exactly one of "node" or "edge" — got keys: ${entries
              .map(([k]) => `"${k}"`)
              .join(', ')}.`,
        );

      const [scopeKey, scopeValue] = entries[0];
      if (scopeKey !== 'node' && scopeKey !== 'edge')
        throw new OGMError(
          `Invalid orderBy scope "${scopeKey}" on connection "${fieldName}". ` +
            `Use "node" (to sort by target node fields) or "edge" (to sort by relationship property fields).`,
        );

      if (typeof scopeValue !== 'object' || scopeValue === null)
        throw new OGMError(
          `Invalid orderBy "${scopeKey}" value on connection "${fieldName}". ` +
            `Expected an object like { field: 'ASC' }.`,
        );

      const scope = scopeKey as 'node' | 'edge';
      let edgePropsDef:
        | { properties: NodeDefinition['properties'] }
        | undefined;
      if (scope === 'edge') {
        if (!relDef.properties)
          throw new OGMError(
            `Invalid orderBy on connection "${fieldName}": relationship has no @relationshipProperties, ` +
              `so "edge" sort keys are not available. Use { node: { ... } } instead.`,
          );
        const resolved = this.schema.relationshipProperties.get(
          relDef.properties,
        );
        if (!resolved)
          throw new OGMError(
            `Invalid orderBy on connection "${fieldName}": relationship properties type ` +
              `"${relDef.properties}" is not defined in the schema.`,
          );
        edgePropsDef = resolved;
      }

      for (const [sortField, rawDirection] of Object.entries(
        scopeValue as Record<string, unknown>,
      )) {
        assertSafeKey(sortField, `orderBy ${scope} field`);
        assertSafeIdentifier(sortField, `orderBy ${scope} field`);

        if (scope === 'node') {
          if (!targetDef.properties.has(sortField))
            throw new OGMError(
              `Invalid orderBy node field "${sortField}" on connection "${fieldName}". ` +
                `Field must be a scalar property of ${targetDef.typeName}.`,
            );
        } else if (!edgePropsDef?.properties.has(sortField))
          throw new OGMError(
            `Invalid orderBy edge field "${sortField}" on connection "${fieldName}". ` +
              `Field must be a scalar property of relationship type "${relDef.properties}".`,
          );

        const direction = assertSortDirection(String(rawDirection));
        result.push({ field: sortField, direction, scope });
      }
    }

    return result;
  }

  /**
   * Normalize edge property selections into SelectionNode[].
   * Edge properties are always scalars.
   */
  private normalizeEdgeProperties(
    select: Record<string, unknown>,
  ): SelectionNode[] {
    const nodes: SelectionNode[] = [];
    for (const [fieldName, value] of Object.entries(select)) {
      assertSafeKey(fieldName, 'edge select input');
      if (value === true)
        nodes.push({
          fieldName,
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        });
    }

    return nodes;
  }

  /**
   * Generate SelectionNode[] for all scalar (non-cypher) properties of a node.
   */
  private allScalarFields(nodeDef: NodeDefinition): SelectionNode[] {
    const cached = this.scalarFieldsCache.get(nodeDef.typeName);
    if (cached) return cached;

    const nodes: SelectionNode[] = [];
    for (const [, prop] of nodeDef.properties) {
      if (prop.isCypher) continue;
      nodes.push({
        fieldName: prop.name,
        isScalar: true,
        isRelationship: false,
        isConnection: false,
      });
    }

    this.scalarFieldsCache.set(nodeDef.typeName, nodes);
    return nodes;
  }
}
