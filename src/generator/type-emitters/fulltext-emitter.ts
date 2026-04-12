import type { SchemaMetadata, NodeDefinition } from '../../schema/types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emits fulltext-related types for every node that declares at least one
 * `@fulltext` index:
 *
 * - `<Node>FulltextResult` — score + the matched node
 * - `<Node>FulltextWhere`  — filtering by score and node-level where
 * - `<Node>FulltextSort`   — sorting by score and node-level sort
 *
 * Also emits the shared `FloatWhere` type used for score filtering.
 *
 * Returns an empty string when no nodes have fulltext indexes.
 */
export function emitFulltextTypes(schema: SchemaMetadata): string {
  const nodesWithFulltext = getNodesWithFulltext(schema);

  if (nodesWithFulltext.length === 0) return '';

  const blocks: string[] = [FLOAT_WHERE_TYPE];

  for (const node of nodesWithFulltext) {
    blocks.push(emitFulltextResult(node));
    blocks.push(emitFulltextWhere(node));
    blocks.push(emitFulltextSort(node));
  }

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

const FLOAT_WHERE_TYPE = `export type FloatWhere = {
  min?: InputMaybe<Scalars["Float"]["input"]>;
  max?: InputMaybe<Scalars["Float"]["input"]>;
};`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns all nodes that have at least one fulltext index,
 * sorted alphabetically by type name.
 */
function getNodesWithFulltext(schema: SchemaMetadata): NodeDefinition[] {
  return [...schema.nodes.values()]
    .filter((node) => node.fulltextIndexes.length > 0)
    .sort((a, b) => a.typeName.localeCompare(b.typeName));
}

/**
 * Converts a PascalCase type name to camelCase for the result field name.
 * e.g. `Book` → `book`, `BookCategory` → `bookCategory`
 */
function toCamelCase(typeName: string): string {
  return typeName.charAt(0).toLowerCase() + typeName.slice(1);
}

function emitFulltextResult(node: NodeDefinition): string {
  const fieldName = toCamelCase(node.typeName);

  return `export type ${node.typeName}FulltextResult = {
  __typename?: "${node.typeName}FulltextResult";
  score: Scalars["Float"]["output"];
  ${fieldName}: ${node.typeName};
};`;
}

function emitFulltextWhere(node: NodeDefinition): string {
  const fieldName = toCamelCase(node.typeName);

  return `/** The input for filtering a fulltext query on an index of ${node.typeName} */
export type ${node.typeName}FulltextWhere = {
  score?: InputMaybe<FloatWhere>;
  ${fieldName}?: InputMaybe<${node.typeName}Where>;
};`;
}

function emitFulltextSort(node: NodeDefinition): string {
  const fieldName = toCamelCase(node.typeName);

  return `export type ${node.typeName}FulltextSort = {
  score?: InputMaybe<SortDirection>;
  ${fieldName}?: InputMaybe<${node.typeName}Sort>;
};`;
}
