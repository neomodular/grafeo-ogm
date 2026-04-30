import type {
  SchemaMetadata,
  NodeDefinition,
  InterfaceDefinition,
} from '../../schema/types';

/**
 * For each node and interface in the schema, emits:
 * - `<Type>Sort` — one optional `SortDirection` field per non-cypher scalar
 * - `<Type>Options` — `limit`, `offset`, `sort` for use in find params
 */
export function emitSortOptions(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  const sortedNodes = [...schema.nodes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [, node] of sortedNodes) blocks.push(emitNodeSortAndOptions(node));

  const sortedInterfaces = [...schema.interfaces.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [, iface] of sortedInterfaces)
    blocks.push(emitInterfaceSortAndOptions(iface));

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitNodeSortAndOptions(node: NodeDefinition): string {
  return emitSortAndOptionsBlock(node.typeName, getSortableProperties(node));
}

function emitInterfaceSortAndOptions(iface: InterfaceDefinition): string {
  return emitSortAndOptionsBlock(
    iface.name,
    getInterfaceSortableProperties(iface),
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
 * Returns the names of all scalar (non-relationship, non-cypher) properties
 * on a node, preserving the insertion order of the properties map.
 */
function getSortableProperties(node: NodeDefinition): string[] {
  const names: string[] = [];

  for (const [name, prop] of node.properties) {
    if (prop.isCypher) continue;
    names.push(name);
  }

  return names;
}

function getInterfaceSortableProperties(iface: InterfaceDefinition): string[] {
  const names: string[] = [];

  for (const [name, prop] of iface.properties) {
    if (prop.isCypher) continue;
    names.push(name);
  }

  return names;
}
