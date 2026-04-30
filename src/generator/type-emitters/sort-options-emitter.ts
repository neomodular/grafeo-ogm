import type {
  SchemaMetadata,
  NodeDefinition,
  InterfaceDefinition,
  PropertyDefinition,
} from '../../schema/types';

/**
 * For each node and interface in the schema, emits:
 * - `<Type>Sort` — one optional `SortDirection` field per sortable scalar
 *   (stored scalars + scalar-returning `@cypher` fields)
 * - `<Type>Options` — `limit`, `offset`, `sort` for use in find params
 */
export function emitSortOptions(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  const sortedNodes = [...schema.nodes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [, node] of sortedNodes)
    blocks.push(emitNodeSortAndOptions(node, schema));

  const sortedInterfaces = [...schema.interfaces.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [, iface] of sortedInterfaces)
    blocks.push(emitInterfaceSortAndOptions(iface, schema));

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitNodeSortAndOptions(
  node: NodeDefinition,
  schema: SchemaMetadata,
): string {
  return emitSortAndOptionsBlock(
    node.typeName,
    getSortableProperties(node.properties, schema),
  );
}

function emitInterfaceSortAndOptions(
  iface: InterfaceDefinition,
  schema: SchemaMetadata,
): string {
  return emitSortAndOptionsBlock(
    iface.name,
    getSortableProperties(iface.properties, schema),
  );
}

function emitSortAndOptionsBlock(
  typeName: string,
  sortFields: string[],
): string {
  const sortMembers = sortFields
    .map((name) => `  ${name}?: InputMaybe<SortDirection>;`)
    .join('\n');

  const sortType = `export type ${typeName}Sort = {\n${sortMembers}\n};`;

  const optionsType = `export type ${typeName}Options = {
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  offset?: InputMaybe<Scalars["Int"]["input"]>;
  sort?: InputMaybe<Array<${typeName}Sort>>;
};`;

  return `${sortType}\n\n${optionsType}`;
}

/**
 * Returns the names of properties eligible for `ORDER BY`:
 * - Stored scalars (any non-`@cypher` property)
 * - `@cypher` fields whose declared return type is a sortable scalar
 *   (skips `Point` / `CartesianPoint` and array returns)
 *
 * Preserves the insertion order of the properties map.
 */
function getSortableProperties(
  properties: Map<string, PropertyDefinition>,
  schema: SchemaMetadata,
): string[] {
  const names: string[] = [];

  for (const [name, prop] of properties) {
    if (prop.isCypher) if (!isCypherSortable(prop, schema)) continue;

    names.push(name);
  }

  return names;
}

/**
 * A `@cypher` field is sortable when it returns a single (non-array)
 * scalar / enum value. Geo types (`Point` / `CartesianPoint`) are excluded
 * because Cypher cannot `ORDER BY` them directly.
 */
function isCypherSortable(
  prop: PropertyDefinition,
  schema: SchemaMetadata,
): boolean {
  if (prop.isArray) return false;
  if (prop.type === 'Point' || prop.type === 'CartesianPoint') return false;
  return SORTABLE_SCALARS.has(prop.type) || schema.enums.has(prop.type);
}

const SORTABLE_SCALARS = new Set([
  'ID',
  'String',
  'Int',
  'Float',
  'Boolean',
  'BigInt',
  'Date',
  'Time',
  'LocalTime',
  'DateTime',
  'LocalDateTime',
  'Duration',
]);
