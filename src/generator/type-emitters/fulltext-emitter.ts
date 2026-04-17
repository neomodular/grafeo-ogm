import type {
  SchemaMetadata,
  NodeDefinition,
  RelationshipDefinition,
  RelationshipPropertiesDefinition,
} from '../../schema/types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emits fulltext-related types for every node that declares at least one
 * `@fulltext` index (either directly on the node or on a relationship whose
 * `@relationshipProperties` type has fulltext indexes):
 *
 * - `<Node>FulltextResult` — score + the matched node
 * - `<Node>FulltextWhere`  — filtering by score and node-level where
 * - `<Node>FulltextSort`   — sorting by score and node-level sort
 * - `<Node>FulltextLeaf`   — per-node leaf with literal index-name keys
 * - `<Node>FulltextInput`  — leaf | OR/AND/NOT composition
 *
 * Also emits the shared `FloatWhere` and `FulltextIndexEntry` types used by
 * the typed inputs.
 *
 * Returns an empty string when no nodes have fulltext indexes (direct or via
 * a relationship-properties type).
 */
export function emitFulltextTypes(schema: SchemaMetadata): string {
  const nodesWithResults = getNodesWithNodeLevelFulltext(schema);
  const nodesWithInputs = getNodesWithAnyFulltext(schema);

  if (nodesWithResults.length === 0 && nodesWithInputs.length === 0) return '';

  const blocks: string[] = [FLOAT_WHERE_TYPE, FULLTEXT_INDEX_ENTRY_TYPE];

  // Node-level fulltext result/where/sort — only emitted when the node itself
  // has indexes (these types describe RETURN shape, which only makes sense
  // when you query the node's own index).
  for (const node of nodesWithResults) {
    blocks.push(emitFulltextResult(node));
    blocks.push(emitFulltextWhere(node));
    blocks.push(emitFulltextSort(node));
  }

  // Per-node typed fulltext INPUT — emitted when the node OR any relationship
  // exposes a fulltext index. Drives the find()/findFirst()/count()/aggregate()
  // autocomplete in the generated model.
  for (const node of nodesWithInputs) {
    blocks.push(emitFulltextLeaf(node, schema));
    blocks.push(emitFulltextInput(node));
  }

  return blocks.join('\n\n');
}

/**
 * Returns true when the node has a node-level fulltext index OR a
 * relationship whose `@relationshipProperties` type has fulltext indexes.
 * Exposed so the model-map emitter can decide whether to override the
 * `fulltext` parameter type on the generated `<Node>Model`.
 */
export function nodeHasAnyFulltext(
  node: NodeDefinition,
  schema: SchemaMetadata,
): boolean {
  if (node.fulltextIndexes.length > 0) return true;
  return getRelationshipFulltextEntries(node, schema).length > 0;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

const FLOAT_WHERE_TYPE = `export type FloatWhere = {
  min?: InputMaybe<Scalars["Float"]["input"]>;
  max?: InputMaybe<Scalars["Float"]["input"]>;
};`;

/**
 * Structural mirror of the runtime `FulltextIndexEntry` in `src/model.ts`.
 * Inlined here so the generated file stays decoupled from runtime internals.
 */
const FULLTEXT_INDEX_ENTRY_TYPE = `export type FulltextIndexEntry = {
  phrase: string;
  score?: number;
};`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns all nodes that have at least one node-level fulltext index,
 * sorted alphabetically by type name.
 */
function getNodesWithNodeLevelFulltext(
  schema: SchemaMetadata,
): NodeDefinition[] {
  return [...schema.nodes.values()]
    .filter((node) => node.fulltextIndexes.length > 0)
    .sort((a, b) => a.typeName.localeCompare(b.typeName));
}

/**
 * Returns all nodes that have at least one node-level OR relationship-level
 * fulltext index, sorted alphabetically by type name.
 */
function getNodesWithAnyFulltext(schema: SchemaMetadata): NodeDefinition[] {
  return [...schema.nodes.values()]
    .filter((node) => nodeHasAnyFulltext(node, schema))
    .sort((a, b) => a.typeName.localeCompare(b.typeName));
}

/**
 * For a given node, returns each relationship that points to a
 * `@relationshipProperties` type whose fulltext indexes list is non-empty.
 * The resulting entries drive the nested keys on `<Node>FulltextLeaf`.
 */
function getRelationshipFulltextEntries(
  node: NodeDefinition,
  schema: SchemaMetadata,
): Array<{
  rel: RelationshipDefinition;
  props: RelationshipPropertiesDefinition;
}> {
  const entries: Array<{
    rel: RelationshipDefinition;
    props: RelationshipPropertiesDefinition;
  }> = [];

  for (const rel of node.relationships.values()) {
    if (!rel.properties) continue;
    const props = schema.relationshipProperties.get(rel.properties);
    if (!props) continue;
    if (!props.fulltextIndexes || props.fulltextIndexes.length === 0) continue;
    entries.push({ rel, props });
  }

  return entries.sort((a, b) => a.rel.fieldName.localeCompare(b.rel.fieldName));
}

/**
 * Converts a PascalCase type name to camelCase for the result field name.
 * e.g. `Book` → `book`, `BookCategory` → `bookCategory`
 */
function toCamelCase(typeName: string): string {
  return typeName.charAt(0).toLowerCase() + typeName.slice(1);
}

/**
 * Returns a syntactically valid TypeScript object-literal key for the given
 * name. Identifiers are left bare; anything else is quoted.
 *
 * Matches TypeScript's identifier rules conservatively: must start with a
 * letter, `_`, or `$`, and only contain letters, digits, `_`, `$`.
 */
function formatObjectKey(name: string): string {
  const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  return IDENTIFIER.test(name) ? name : `'${name.replace(/'/g, "\\'")}'`;
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

/**
 * Emits `<Node>FulltextLeaf` — an object whose keys are the node's fulltext
 * index names (literal, optional) and whose relationship keys map to
 * `{ [IndexName]?: FulltextIndexEntry }` shapes matching the runtime
 * `FulltextRelationshipEntry` contract.
 *
 * If the node has node-level indexes only, the relationship section is
 * omitted and vice-versa.
 */
function emitFulltextLeaf(
  node: NodeDefinition,
  schema: SchemaMetadata,
): string {
  const nodeLevelKeys = node.fulltextIndexes.map((idx) => {
    const key = formatObjectKey(idx.name);
    return `  ${key}?: FulltextIndexEntry;`;
  });

  const relEntries = getRelationshipFulltextEntries(node, schema);
  const relKeys = relEntries.map(({ rel, props }) => {
    const key = formatObjectKey(rel.fieldName);
    const indexKeys = (props.fulltextIndexes ?? [])
      .map((idx) => `${formatObjectKey(idx.name)}?: FulltextIndexEntry`)
      .join('; ');
    return `  ${key}?: { ${indexKeys} };`;
  });

  const body = [...nodeLevelKeys, ...relKeys].join('\n');

  return `export type ${node.typeName}FulltextLeaf = {
${body}
};`;
}

/**
 * Emits `<Node>FulltextInput` — the top-level union accepted by `find()` et
 * al. Includes the leaf and the three logical composition operators.
 */
function emitFulltextInput(node: NodeDefinition): string {
  return `export type ${node.typeName}FulltextInput =
  | ${node.typeName}FulltextLeaf
  | { OR: ${node.typeName}FulltextInput[] }
  | { AND: ${node.typeName}FulltextInput[] }
  | { NOT: ${node.typeName}FulltextInput };`;
}
