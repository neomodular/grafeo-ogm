import { OGMError } from '../errors';
import { NodeDefinition, VectorIndex } from '../schema/types';
import { assertSafeIdentifier } from '../utils/validation';

/** Upper bound for k to prevent resource exhaustion on top-k queries. */
const MAX_K = 1000;

export interface VectorResult {
  cypher: string;
  params: Record<string, unknown>;
}

/**
 * Compiles vector-index search input into Cypher CALL clauses using
 * `db.index.vector.queryNodes` and (optionally) `genai.vector.encode`.
 *
 * Emits only the CALL prelude — the caller (Model) composes any
 * subsequent WHERE / RETURN / ORDER BY around it.
 *
 * Two entry points:
 * - `compileByVector` — user supplies a pre-computed embedding.
 * - `compileByPhrase`  — user supplies a text phrase; the server-side GenAI
 *   plugin encodes it using the `provider` configured on the index.
 */
export class VectorCompiler {
  // No schema dependency: all metadata is resolved from the caller-supplied
  // `nodeDef` on each `compileBy*` call. Keeping the constructor parameter-free
  // makes the coupling honest — add a schema dependency only when the compiler
  // genuinely needs cross-index metadata (e.g. resolving nodeDef from indexName).
  constructor() {}

  /**
   * Build the CALL clause for a vector similarity search against a pre-computed
   * embedding. Returns a Cypher fragment that yields `n` and `score`.
   */
  compileByVector(input: {
    indexName: string;
    vector: number[];
    k: number;
    nodeDef: NodeDefinition;
    paramCounter?: { count: number };
  }): VectorResult {
    const { indexName, vector, k, nodeDef } = input;
    const counter = input.paramCounter ?? { count: 0 };

    this.assertIndexExists(indexName, nodeDef);
    const safeK = assertValidK(k);
    assertValidVector(vector);

    const suffix = counter.count++;
    const nameParam = `v_name_${suffix}`;
    const kParam = `v_k_${suffix}`;
    const vectorParam = `v_vector_${suffix}`;

    const cypher = `CALL db.index.vector.queryNodes($${nameParam}, $${kParam}, $${vectorParam}) YIELD node AS n, score`;

    const params: Record<string, unknown> = {
      [nameParam]: indexName,
      [kParam]: safeK,
      [vectorParam]: vector,
    };

    return { cypher, params };
  }

  /**
   * Build the two-step CALL for a vector similarity search keyed on a text
   * phrase. Requires the matching index to declare a `provider`.
   */
  compileByPhrase(input: {
    indexName: string;
    phrase: string;
    k: number;
    providerConfig?: Record<string, unknown>;
    nodeDef: NodeDefinition;
    paramCounter?: { count: number };
  }): VectorResult {
    const { indexName, phrase, k, providerConfig, nodeDef } = input;
    const counter = input.paramCounter ?? { count: 0 };

    const index = this.assertIndexExists(indexName, nodeDef);
    const safeK = assertValidK(k);
    assertValidPhrase(phrase);

    if (!index.provider || index.provider.trim().length === 0)
      throw new OGMError(
        `Vector index "${indexName}" is not configured for phrase search. Set "provider" on the @vector directive to enable searchByPhrase.`,
      );

    const suffix = counter.count++;
    const nameParam = `v_name_${suffix}`;
    const kParam = `v_k_${suffix}`;
    const phraseParam = `v_phrase_${suffix}`;
    const providerParam = `v_provider_${suffix}`;
    const providerCfgParam = `v_providerConfig_${suffix}`;
    const encodedVar = `__v_encoded_${suffix}`;

    const cypher = [
      `CALL genai.vector.encode($${phraseParam}, $${providerParam}, $${providerCfgParam}) YIELD vector AS ${encodedVar}`,
      `CALL db.index.vector.queryNodes($${nameParam}, $${kParam}, ${encodedVar}) YIELD node AS n, score`,
    ].join('\n');

    const params: Record<string, unknown> = {
      [nameParam]: indexName,
      [kParam]: safeK,
      [phraseParam]: phrase,
      [providerParam]: index.provider,
      [providerCfgParam]: providerConfig ?? {},
    };

    return { cypher, params };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve and validate that `indexName` is declared on `nodeDef`. Throws a
   * descriptive `OGMError` listing the available indexes on miss. The index
   * name is also run through `assertSafeIdentifier` as defense in depth —
   * even though it travels through a parameter, validating it here guards
   * against accidental injection if the shape ever changes.
   */
  private assertIndexExists(
    indexName: string,
    nodeDef: NodeDefinition,
  ): VectorIndex {
    assertSafeIdentifier(indexName, 'vector index name');

    const indexes = nodeDef.vectorIndexes ?? [];
    const match = indexes.find((idx) => idx.indexName === indexName);
    if (!match) {
      const available = indexes.map((idx) => idx.indexName);
      throw new OGMError(
        `Invalid vector index: "${indexName}" is not defined on ${nodeDef.typeName}. Available: [${available.join(', ')}]`,
      );
    }
    return match;
  }
}

/** Validate `k` is a positive integer; clamp to `MAX_K`. */
function assertValidK(k: number): number {
  if (typeof k !== 'number' || !Number.isFinite(k))
    throw new OGMError(`Vector search "k" must be a finite number, got ${k}`);
  if (!Number.isInteger(k))
    throw new OGMError(`Vector search "k" must be an integer, got ${k}`);
  if (k < 1) throw new OGMError(`Vector search "k" must be >= 1, got ${k}`);
  return k > MAX_K ? MAX_K : k;
}

/** Validate `vector` is a non-empty array of finite numbers. */
function assertValidVector(vector: unknown): asserts vector is number[] {
  if (!Array.isArray(vector))
    throw new OGMError('Vector search "vector" must be a number[]');
  if (vector.length === 0)
    throw new OGMError('Vector search "vector" must not be empty');
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i];
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new OGMError(
        `Vector search "vector" contains a non-finite value at index ${i}`,
      );
  }
}

/** Validate `phrase` is a non-empty, non-whitespace string. */
function assertValidPhrase(phrase: unknown): asserts phrase is string {
  if (typeof phrase !== 'string' || phrase.trim().length === 0)
    throw new OGMError('Vector search "phrase" must be a non-empty string');
}
