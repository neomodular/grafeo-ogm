import type { SchemaMetadata, NodeDefinition } from '../../schema/types';

/**
 * For each node in the schema, emits a `<Node>Sort` type (with one optional
 * `SortDirection` field per scalar property) and a `<Node>Options` type that
 * exposes `limit`, `offset`, and `sort`.
 */
export function emitSortOptions(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  // Process nodes in alphabetical order
  const sortedNodes = [...schema.nodes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, node] of sortedNodes) blocks.push(emitNodeSortAndOptions(node));

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitNodeSortAndOptions(node: NodeDefinition): string {
  const sortFields = getSortableProperties(node);

  const sortMembers = sortFields
    .map((name) => `  ${name}?: InputMaybe<SortDirection>;`)
    .join('\n');

  const sortType = `export type ${node.typeName}Sort = {\n${sortMembers}\n};`;

  const optionsType = `export type ${node.typeName}Options = {
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  offset?: InputMaybe<Scalars["Int"]["input"]>;
  sort?: InputMaybe<Array<${node.typeName}Sort>>;
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
    // Skip @cypher fields — they are computed and not stored
    if (prop.isCypher) continue;

    names.push(name);
  }

  return names;
}
