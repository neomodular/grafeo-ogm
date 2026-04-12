import type { SchemaMetadata, NodeDefinition } from '../schema/types';
import type { SelectionNode } from './selection.compiler';
import { assertSafeKey } from '../utils/validation';

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
    relDef: { target: string },
  ): SelectionNode | null {
    const targetDef = this.schema.nodes.get(relDef.target);
    if (!targetDef) return null;

    // `{ drugs: true }` → select all scalar fields from target
    if (value === true) {
      const children = this.allScalarFields(targetDef);
      return {
        fieldName,
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children,
      };
    }

    // `{ drugs: { where: {...}, select: { id: true, drugName: true } } }` → nested select with optional where
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

        return node;
      }

      // `{ drugs: { where: {...} } }` → where-only (select all scalars)
      if (obj.where && typeof obj.where === 'object')
        return {
          fieldName,
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: this.allScalarFields(targetDef),
          relationshipWhere: obj.where as Record<string, unknown>,
        };
    }

    return null;
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

    const targetDef = this.schema.nodes.get(relDef.target);
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
