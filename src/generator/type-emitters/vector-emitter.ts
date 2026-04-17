import type {
  SchemaMetadata,
  NodeDefinition,
  VectorIndex,
} from '../../schema/types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emits vector-search-related types for every node that declares at least one
 * `@vector` index:
 *
 * - `<Node>VectorResult`              — `{ node, score }` returned by search
 * - `<Node>VectorSearchByVectorInput` — arguments for `searchByVector`
 * - `<Node>VectorSearchByPhraseInput` — arguments for `searchByPhrase`
 *   (only emitted when at least one index on the node has `provider` set)
 *
 * Returns an empty string when no nodes have vector indexes.
 */
export function emitVectorTypes(schema: SchemaMetadata): string {
  const nodesWithVectors = getNodesWithVectors(schema);

  if (nodesWithVectors.length === 0) return '';

  const blocks: string[] = [];

  for (const node of nodesWithVectors) {
    const indexes = node.vectorIndexes ?? [];
    blocks.push(emitVectorResult(node));
    blocks.push(emitVectorSearchByVectorInput(node, indexes));

    const providerIndexes = indexes.filter((idx) => Boolean(idx.provider));
    if (providerIndexes.length > 0)
      blocks.push(emitVectorSearchByPhraseInput(node, providerIndexes));
  }

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns all nodes that have at least one vector index,
 * sorted alphabetically by type name.
 */
function getNodesWithVectors(schema: SchemaMetadata): NodeDefinition[] {
  return [...schema.nodes.values()]
    .filter((node) => (node.vectorIndexes ?? []).length > 0)
    .sort((a, b) => a.typeName.localeCompare(b.typeName));
}

/**
 * Builds a literal union of index names, e.g. `'idx_a' | 'idx_b'`.
 * Assumes the caller guarantees a non-empty list.
 */
function toIndexNameUnion(indexes: VectorIndex[]): string {
  return indexes.map((idx) => `'${idx.indexName}'`).join(' | ');
}

function emitVectorResult(node: NodeDefinition): string {
  return `export type ${node.typeName}VectorResult = {
  node: ${node.typeName};
  score: number;
};`;
}

function emitVectorSearchByVectorInput(
  node: NodeDefinition,
  indexes: VectorIndex[],
): string {
  const indexUnion = toIndexNameUnion(indexes);

  return `export type ${node.typeName}VectorSearchByVectorInput = {
  indexName: ${indexUnion};
  vector: number[];
  k: number;
  where?: ${node.typeName}Where;
  selectionSet?: string;
  labels?: string[];
};`;
}

function emitVectorSearchByPhraseInput(
  node: NodeDefinition,
  providerIndexes: VectorIndex[],
): string {
  const indexUnion = toIndexNameUnion(providerIndexes);

  return `export type ${node.typeName}VectorSearchByPhraseInput = {
  indexName: ${indexUnion};
  phrase: string;
  k: number;
  providerConfig?: Record<string, unknown>;
  where?: ${node.typeName}Where;
  selectionSet?: string;
  labels?: string[];
};`;
}
