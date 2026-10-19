import { OGMError } from '../errors';
import type {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../schema/types';
import {
  AGGREGATE_SUFFIX,
  AGGREGATES_BY_KIND,
  aggregateKind,
} from './relationship-aggregate';
import { resolveTargetDef } from '../schema/utils';
import {
  assertSafeIdentifier,
  assertSafeKey,
  assertSortDirection,
  isPlainObject,
} from '../utils/validation';
import { lenientStrictMode, type StrictMode } from '../utils/strict-mode';
import { normalizeConnectionOrderBy } from './connection-order-by';
import {
  aggregateFieldHint,
  connectionKeyIssues,
  isScalarProperty,
  LEFT_OUT,
  PAGE_INFO_FIELDS,
  propertyTypeName,
  reportUnknownSelectedField,
  type ConnectionKeySelection,
  type PageInfoSelection,
  type SelectionNode,
} from './selection.compiler';

/** v2.8.0 — the keys of a relationship's object select. */
const RELATIONSHIP_SELECT_KEYS: ReadonlySet<string> = new Set([
  'select',
  'where',
  'orderBy',
]);

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

  /** v2.6.3 — strict mode + warn-once log, shared per OGM. */
  private strictMode: StrictMode;

  constructor(
    private schema: SchemaMetadata,
    strictMode?: StrictMode,
  ) {
    this.strictMode = strictMode ?? lenientStrictMode();
  }

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
      if (value == null || value === false) continue;

      assertSafeKey(fieldName, 'select input');

      // v2.4.8 — a `*Connection` key is a connection only when its base
      // name is a relationship. Pre-2.4.8 every such key was routed to
      // `normalizeConnection`, which silently dropped a scalar like
      // `internetConnection: String`.
      const isConnection =
        fieldName.endsWith('Connection') &&
        nodeDef.relationships.has(fieldName.slice(0, -'Connection'.length));

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

      // v2.7.0 — `postsAggregate: true | { where?, directed?, select? }`.
      // Pre-2.7.0 the key was not a relationship and dropped.
      if (
        !relDef &&
        fieldName.endsWith(AGGREGATE_SUFFIX) &&
        !nodeDef.properties.has(fieldName)
      ) {
        const aggregated = nodeDef.relationships.get(
          fieldName.slice(0, -AGGREGATE_SUFFIX.length),
        );
        if (aggregated) {
          nodes.push(this.normalizeAggregate(fieldName, value, aggregated));
          continue;
        }
      }

      if (relDef) {
        this.checkRelationshipShape(fieldName, value, relDef, nodeDef);
        // It's a relationship field
        const relNode = this.normalizeRelationship(fieldName, value, relDef);
        if (relNode) nodes.push(relNode);

        continue;
      }

      // v2.6.3 — a key that is no field of the type (#23). Pre-2.6.3 —
      // and in 2.x default mode — `key: true` is projected as a raw
      // property (null) and an object value is dropped; strict throws.
      const prop = nodeDef.properties.get(fieldName);
      if (fieldName !== '__typename' && !prop)
        reportUnknownSelectedField(this.strictMode, 'select', {
          owner: `type "${nodeDef.typeName}"`,
          field: fieldName,
          subSelection: value !== true,
          hint: aggregateFieldHint(fieldName, nodeDef.relationships),
        });
      // v2.8.0 — a scalar given anything but `true` is left out.
      else if (prop && value !== true && isScalarProperty(prop, this.schema))
        reportUnknownSelectedField(this.strictMode, 'select', {
          owner: `type "${nodeDef.typeName}"`,
          field: fieldName,
          subSelection: true,
          shape: {
            expected: `is a scalar field (${propertyTypeName(prop)}): select it with \`${fieldName}: true\``,
            outcome: LEFT_OUT,
          },
        });

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
    if (isPlainObject(value)) {
      const obj = value;
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

      // v2.8.0 — `{ drugs: {} }` (every key optional in the generated
      // types) is left out of the result in 2.x default mode, as before
      // (warned); `strict: true` selects all scalars, as `true` does. An
      // object with an unknown key is reported by `checkRelationshipShape`.
      if (Object.keys(obj).every((k) => RELATIONSHIP_SELECT_KEYS.has(k))) {
        if (!this.strictMode.strict) {
          this.strictMode.warn(
            'select-empty-relationship',
            `${relDef.target}.${fieldName}`,
            `Typed select \`${fieldName}: {}\` (a relationship to ${relDef.target}) is left out of the result.`,
            `select every scalar field of ${relDef.target}, as \`${fieldName}: true\` does`,
          );
          return null;
        }
        return {
          fieldName,
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: [...this.allScalarFields(targetDef)],
        };
      }
    }

    return null;
  }

  /**
   * v2.8.0 — report a relationship select value the runtime cannot honour
   * (it is left out of the result, or its unknown keys are ignored):
   * anything but `true` or an object, or an object with a key other than
   * `select`, `where` and `orderBy`. Strict throws.
   */
  private checkRelationshipShape(
    fieldName: string,
    value: unknown,
    relDef: RelationshipDefinition,
    nodeDef: NodeDefinition,
  ): void {
    if (value === true) return;
    const owner = `type "${nodeDef.typeName}"`;
    if (!isPlainObject(value)) {
      reportUnknownSelectedField(this.strictMode, 'select', {
        owner,
        field: fieldName,
        subSelection: false,
        shape: {
          expected:
            `is a relationship to ${relDef.target}: select it with \`${fieldName}: true\` (all scalar fields) ` +
            `or \`${fieldName}: { select: { … }, where?, orderBy? }\``,
          outcome: LEFT_OUT,
        },
      });
      return;
    }
    const unknown = Object.keys(value).filter(
      (k) => !RELATIONSHIP_SELECT_KEYS.has(k),
    );
    if (unknown.length === 0) return;
    // What 2.x does: an object with a usable `select`, `where` or
    // `orderBy` is compiled (the unknown keys ignored), any other dropped.
    const kept =
      (!!value.select && typeof value.select === 'object') ||
      (!!value.where && typeof value.where === 'object') ||
      value.orderBy !== undefined;
    reportUnknownSelectedField(this.strictMode, 'select', {
      owner,
      field: fieldName,
      subSelection: true,
      shape: {
        expected:
          `is a relationship to ${relDef.target} and takes \`select\`, \`where\` and \`orderBy\`, ` +
          `not ${unknown.map((k) => `"${k}"`).join(', ')}`,
        outcome: kept
          ? `2.x ignores the unknown key${unknown.length > 1 ? 's' : ''}`
          : LEFT_OUT,
      },
    });
  }

  /**
   * v2.7.0 — a typed `<rel>Aggregate` select into the selection the
   * selectionSet `postsAggregate(where, directed) { count node { … } edge
   * { … } }` parses to. `true` (at any level) selects everything below:
   * `count`, and every aggregate of every aggregatable node / edge field.
   * Unknown keys throw: the compiler validates the rest.
   */
  private normalizeAggregate(
    fieldName: string,
    value: unknown,
    relDef: RelationshipDefinition,
  ): SelectionNode {
    const node: SelectionNode = {
      fieldName,
      isScalar: false,
      isRelationship: true,
      isConnection: false,
    };
    const scalar = (name: string): SelectionNode => ({
      fieldName: name,
      isScalar: true,
      isRelationship: false,
      isConnection: false,
    });
    const targetProps = this.schema.unions?.get(relDef.target)?.length
      ? undefined
      : resolveTargetDef(relDef.target, this.schema)?.properties;
    const edgeProps = relDef.properties
      ? this.schema.relationshipProperties.get(relDef.properties)?.properties
      : undefined;
    /** `node` / `edge`: `true` → every aggregatable field, all aggregates. */
    const fieldsOf = (
      which: 'node' | 'edge',
      props: Map<string, PropertyDefinition> | undefined,
      v: unknown,
    ): SelectionNode => {
      const out: SelectionNode = {
        fieldName: which,
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children: [],
      };
      const where = `${fieldName}.${which}`;
      if (v === true) {
        for (const prop of props?.values() ?? []) {
          const kind = aggregateKind(prop);
          if (kind)
            out.children!.push({
              fieldName: prop.name,
              isScalar: false,
              isRelationship: true,
              isConnection: false,
              children: AGGREGATES_BY_KIND[kind].map(scalar),
            });
        }
        return out;
      }
      const sel = selectOf(v, where);
      for (const [field, fv] of Object.entries(sel)) {
        if (fv == null || fv === false) continue;
        assertSafeKey(field, 'select input');
        const prop = props?.get(field);
        const kind = prop ? aggregateKind(prop) : null;
        if (!kind)
          throw new OGMError(
            prop?.isArray
              ? `Field "${field}" on ${where} has no aggregates: list fields are not aggregated.`
              : `Field "${field}" on ${where} has no aggregates (unknown, or not aggregatable).`,
          );
        const ops =
          fv === true
            ? [...AGGREGATES_BY_KIND[kind]]
            : Object.entries(selectOf(fv, `${where}.${field}`))
                .filter(([, on]) => on === true)
                .map(([op]) => {
                  assertSafeKey(op, 'select input');
                  return op;
                });
        out.children!.push({
          fieldName: field,
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: ops.map(scalar),
        });
      }
      return out;
    };
    /** The `select` object of `{ select: { … } }`, validated. */
    const selectOf = (v: unknown, where: string): Record<string, unknown> => {
      if (!isPlainObject(v) || !isPlainObject(v.select))
        throw new OGMError(
          `select for ${where} must be true or { select: { … } }.`,
        );
      for (const k of Object.keys(v))
        if (k !== 'select')
          throw new OGMError(`Unknown key "${k}" in select for ${where}.`);
      return v.select;
    };

    let select: Record<string, unknown>;
    if (value === true)
      select = {
        count: true,
        ...(targetProps ? { node: true } : {}),
        ...(edgeProps ? { edge: true } : {}),
      };
    else if (isPlainObject(value)) {
      for (const k of Object.keys(value))
        if (!['where', 'directed', 'select'].includes(k))
          throw new OGMError(
            `Unknown key "${k}" in select for relationship aggregate "${fieldName}". ` +
              `Supported: where, directed, select.`,
          );
      if (value.where !== undefined) {
        if (!isPlainObject(value.where))
          throw new OGMError(
            `where on relationship aggregate "${fieldName}" must be an object.`,
          );
        node.relationshipWhere = value.where;
      }
      if (value.directed !== undefined) {
        if (typeof value.directed !== 'boolean')
          throw new OGMError(
            `directed on relationship aggregate "${fieldName}" must be true or false.`,
          );
        node.directed = value.directed;
      }
      select = isPlainObject(value.select) ? value.select : { count: true };
    } else
      throw new OGMError(
        `select for relationship aggregate "${fieldName}" must be true or an object.`,
      );

    node.children = [];
    for (const [key, v] of Object.entries(select)) {
      if (v == null || v === false) continue;
      if (key === 'count' && v === true) node.children.push(scalar('count'));
      else if (key === 'node')
        node.children.push(fieldsOf('node', targetProps, v));
      else if (key === 'edge')
        node.children.push(fieldsOf('edge', edgeProps, v));
      else
        throw new OGMError(
          `Unknown key "${key}" in select for relationship aggregate "${fieldName}". ` +
            `Supported: count, node, edge.`,
        );
    }
    return node;
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

    // v2.5.3 — the generated SelectFields offer `xConnection: true`,
    // `edges: true`, `node: true` and `properties: true`. Pre-2.5.3 only the
    // `{ select }` object forms were read, so every `true` form returned
    // `edges: [{}]`. `true` now selects all scalars (node and edge), as it
    // does for a plain relationship field.
    const allNode = () => [...this.allScalarFields(targetDef)];
    const allEdge = () => this.allEdgeScalarFields(relDef);

    if (value === true) {
      node.children = allNode();
      const edgeChildren = allEdge();
      if (edgeChildren.length > 0) node.edgeChildren = edgeChildren;
      return node;
    }

    if (!isPlainObject(value)) return node;

    const obj = value;

    // Extract where clause
    if (obj.where && typeof obj.where === 'object')
      node.connectionWhere = obj.where as Record<string, unknown>;

    // Extract orderBy (node/edge scoped) for edge sorting
    if (obj.orderBy !== undefined)
      node.connectionOrderBy = normalizeConnectionOrderBy(
        obj.orderBy,
        fieldName,
        'orderBy',
        { targetDef, relDef, schema: this.schema },
      );

    // Extract edges -> node and edges -> properties from select
    if (obj.select && typeof obj.select === 'object') {
      const selectObj = obj.select as Record<string, unknown>;

      // v2.4.8 — `totalCount` was ignored (silently undefined).
      if (selectObj.totalCount === true) {
        node.totalCount = true;
        if (selectObj.edges == null || selectObj.edges === false)
          node.totalCountOnly = true;
      }

      // v2.8.0 — `pageInfo` was ignored (silently undefined).
      if (selectObj.pageInfo != null && selectObj.pageInfo !== false)
        node.pageInfo = [this.normalizePageInfo(selectObj.pageInfo)];

      if (selectObj.edges === true) {
        node.children = allNode();
        const edgeChildren = allEdge();
        if (edgeChildren.length > 0) node.edgeChildren = edgeChildren;
      } else if (selectObj.edges && typeof selectObj.edges === 'object') {
        const edgesObj = selectObj.edges as Record<string, unknown>;

        // v2.8.0 — `cursor` was ignored (silently undefined).
        if (edgesObj.cursor != null && edgesObj.cursor !== false)
          node.cursors = [
            {
              key: 'cursor',
              field: 'cursor',
              ...(edgesObj.cursor === true ? {} : { subSelection: true }),
            },
          ];

        // edges.node.select -> children
        if (edgesObj.node === true) node.children = allNode();
        else if (edgesObj.node && typeof edgesObj.node === 'object') {
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
        if (edgesObj.properties === true) {
          const edgeChildren = allEdge();
          if (edgeChildren.length > 0) node.edgeChildren = edgeChildren;
        } else if (
          edgesObj.properties &&
          typeof edgesObj.properties === 'object'
        ) {
          const propsObj = edgesObj.properties as Record<string, unknown>;
          if (propsObj.select && typeof propsObj.select === 'object')
            node.edgeChildren = this.normalizeEdgeProperties(
              propsObj.select as Record<string, unknown>,
              relDef,
              nodeDef.typeName,
              baseFieldName,
            );
        }
      }
    }

    // v2.8.0 — report `pageInfo` / `cursor` the runtime cannot project.
    for (const issue of connectionKeyIssues(
      node,
      `${nodeDef.typeName}${baseFieldName.charAt(0).toUpperCase()}${baseFieldName.slice(1)}`,
      'select',
    ))
      reportUnknownSelectedField(this.strictMode, 'select', issue);

    return node;
  }

  /**
   * v2.8.0 — a typed `pageInfo` select: `true` selects every `PageInfo`
   * field, `{ select: { hasNextPage: true, … } }` the listed ones. Any
   * other value is reported as a shape mismatch (`connectionKeyIssues`).
   */
  private normalizePageInfo(value: unknown): PageInfoSelection {
    if (value === true)
      return {
        key: 'pageInfo',
        fields: [...PAGE_INFO_FIELDS].map((f) => ({ key: f, field: f })),
      };
    if (!isPlainObject(value) || !isPlainObject(value.select))
      return { key: 'pageInfo' };
    const fields: ConnectionKeySelection[] = [];
    for (const [field, on] of Object.entries(value.select)) {
      if (on == null || on === false) continue;
      assertSafeKey(field, 'select input');
      fields.push({
        key: field,
        field,
        ...(on === true ? {} : { subSelection: true }),
      });
    }
    return { key: 'pageInfo', fields };
  }

  /**
   * Normalize edge property selections into SelectionNode[].
   * Edge properties are always scalars.
   */
  private normalizeEdgeProperties(
    select: Record<string, unknown>,
    relDef: RelationshipDefinition,
    typeName: string,
    relField: string,
  ): SelectionNode[] {
    const nodes: SelectionNode[] = [];
    const props = relDef.properties
      ? this.schema.relationshipProperties.get(relDef.properties)
      : undefined;
    for (const [fieldName, value] of Object.entries(select)) {
      assertSafeKey(fieldName, 'edge select input');
      // v2.6.3 — an edge key that is no field of the relationship
      // properties type (#23): raw relationship property in 2.x, strict
      // throws.
      if (
        value != null &&
        value !== false &&
        fieldName !== '__typename' &&
        !props?.properties.has(fieldName)
      )
        reportUnknownSelectedField(this.strictMode, 'select', {
          owner: props
            ? `relationship properties type "${props.typeName}"`
            : `the "${relField}" relationship of type "${typeName}" (no @relationshipProperties)`,
          field: fieldName,
          subSelection: value !== true,
          edge: true,
        });
      // v2.8.0 — an edge property given anything but `true` is left out.
      const edgeProp = props?.properties.get(fieldName);
      if (edgeProp && value != null && value !== false && value !== true)
        reportUnknownSelectedField(this.strictMode, 'select', {
          owner: `relationship properties type "${props!.typeName}"`,
          field: fieldName,
          subSelection: true,
          edge: true,
          shape: {
            expected: `is a scalar field (${propertyTypeName(edgeProp)}): select it with \`${fieldName}: true\``,
            outcome: LEFT_OUT,
          },
        });
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
   * v2.5.3 — SelectionNode[] for every edge property of a relationship
   * (empty when it has no `@relationshipProperties`).
   */
  private allEdgeScalarFields(relDef: RelationshipDefinition): SelectionNode[] {
    if (!relDef.properties) return [];
    const propsDef = this.schema.relationshipProperties.get(relDef.properties);
    if (!propsDef) return [];
    const nodes: SelectionNode[] = [];
    for (const [, prop] of propsDef.properties) {
      if (prop.isCypher) continue;
      nodes.push({
        fieldName: prop.name,
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
