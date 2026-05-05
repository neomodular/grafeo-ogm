import { OGMError } from '../errors';
import {
  isFulltextLeaf,
  isFulltextIndexEntry,
  FulltextInput,
  FulltextIndexEntry,
} from '../model';
import { FulltextIndex, NodeDefinition, SchemaMetadata } from '../schema/types';
import {
  assertSafeIdentifier,
  escapeIdentifier,
  mergeParams,
} from '../utils/validation';

/** Maximum recursion depth for nested fulltext logical operators */
const MAX_DEPTH = 10;

/**
 * Hard cap on the length of a fulltext phrase, in characters. Lucene
 * itself accepts essentially unbounded query strings, but the OGM
 * pipeline forwards untrusted user input directly to the driver — and
 * a multi-megabyte phrase wastes round-trip bandwidth, parser CPU on
 * the database side, and (for callers that pre-process via embedding
 * providers) provider tokens. 8 KB is well above any legitimate
 * search query.
 */
const MAX_FULLTEXT_PHRASE_LENGTH = 8 * 1024;

function assertValidFulltextPhrase(phrase: unknown): asserts phrase is string {
  if (typeof phrase !== 'string' || phrase.trim().length === 0)
    throw new OGMError('Fulltext phrase must not be empty');
  if (phrase.length > MAX_FULLTEXT_PHRASE_LENGTH)
    throw new OGMError(
      `Fulltext phrase exceeds the maximum length of ${MAX_FULLTEXT_PHRASE_LENGTH} characters ` +
        `(got ${phrase.length}). Truncate or split the input before searching.`,
    );
}

export interface FulltextResult {
  cypher: string;
  params: Record<string, unknown>;
  scoreThreshold?: number;
}

/**
 * Compiles fulltext search input into Cypher CALL clauses using
 * db.index.fulltext.queryNodes and db.index.fulltext.queryRelationships.
 *
 * Supports logical operators:
 * - **Leaf (node index)**: `{ IndexName: { phrase, score? } }` → `queryNodes`
 * - **Leaf (relationship index)**: `{ relField: { IndexName: { phrase, score? } } }` → `queryRelationships`
 * - **OR**: `CALL { ... UNION ... }` combining multiple branches
 * - **AND**: Sequential correlated subqueries with node identity matching
 * - **NOT**: `WHERE NOT EXISTS { ... }` exclusion pattern (Neo4j 5+)
 */
export class FulltextCompiler {
  constructor(private schema: SchemaMetadata) {}

  /**
   * Compile fulltext input to Cypher CALL clause(s).
   * Handles flat leaves AND recursive OR/AND/NOT expressions.
   */
  compile(
    fulltext: FulltextInput,
    nodeDef: NodeDefinition,
    nodeVar = 'n',
  ): FulltextResult {
    assertSafeIdentifier(nodeVar, 'node variable');
    const paramCounter = { count: 0 };
    const result = this.compileNode(fulltext, nodeDef, nodeVar, paramCounter);

    // For simple leaf inputs, normalize param names for backward compat
    // with model.ts which references `$ft_phrase` and `$ft_score` in WHERE.
    if (isFulltextLeaf(fulltext))
      for (const key of Object.keys(result.params))
        if (key.startsWith('ft_phrase_')) {
          result.params.ft_phrase = result.params[key];
          delete result.params[key];
          result.cypher = result.cypher.replace(`$${key}`, '$ft_phrase');
        } else if (key.startsWith('ft_score_')) {
          result.params.ft_score = result.params[key];
          delete result.params[key];
        }

    return result;
  }

  /**
   * Compile fulltext input for a relationship index into a Cypher CALL clause.
   * Uses db.index.fulltext.queryRelationships.
   */
  compileRelationship(
    fulltext: Record<string, { phrase: string; score?: number }>,
    relIndex: FulltextIndex,
    relVar = 'r',
  ): FulltextResult {
    assertSafeIdentifier(relVar, 'relationship variable');

    const keys = Object.keys(fulltext);
    if (keys.length === 0)
      throw new OGMError(
        'Fulltext input must contain at least one index entry',
      );

    const indexName = keys[0];
    assertSafeIdentifier(indexName, 'fulltext index name');
    const input = fulltext[indexName];

    assertValidFulltextPhrase(input.phrase);

    if (relIndex.name !== indexName)
      throw new OGMError(
        `Unknown relationship fulltext index "${indexName}". Expected "${relIndex.name}".`,
      );

    const lines = [
      `CALL db.index.fulltext.queryRelationships('${indexName}', $ft_phrase)`,
      `YIELD relationship AS ${relVar}, score`,
    ];

    const params: Record<string, unknown> = { ft_phrase: input.phrase };
    const result: FulltextResult = {
      cypher: lines.join('\n'),
      params,
    };

    if (input.score !== undefined) {
      params.ft_score = input.score;
      result.scoreThreshold = input.score;
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private recursive compilation
  // ---------------------------------------------------------------------------

  private compileNode(
    input: FulltextInput,
    nodeDef: NodeDefinition,
    nodeVar: string,
    paramCounter: { count: number },
    depth = 0,
  ): FulltextResult {
    if (depth > MAX_DEPTH)
      throw new OGMError(
        `Fulltext logical nesting exceeds maximum depth of ${MAX_DEPTH}`,
      );
    if (isFulltextLeaf(input))
      return this.compileLeaf(input, nodeDef, nodeVar, paramCounter);

    if ('OR' in input)
      return this.compileOr(
        input.OR,
        nodeDef,
        nodeVar,
        paramCounter,
        depth + 1,
      );
    if ('AND' in input)
      return this.compileAnd(
        input.AND,
        nodeDef,
        nodeVar,
        paramCounter,
        depth + 1,
      );
    if ('NOT' in input)
      return this.compileNot(
        input.NOT,
        nodeDef,
        nodeVar,
        paramCounter,
        depth + 1,
      );

    throw new OGMError(
      'Invalid fulltext input: must be a leaf, OR, AND, or NOT',
    );
  }

  /**
   * Compile a leaf entry. Two shapes:
   * - Node index: `{ IndexName: { phrase, score? } }` — value has `phrase`
   * - Relationship index: `{ relField: { IndexName: { phrase, score? } } }` — value is nested
   */
  private compileLeaf(
    leaf: Record<string, unknown>,
    nodeDef: NodeDefinition,
    nodeVar: string,
    paramCounter: { count: number },
  ): FulltextResult {
    const keys = Object.keys(leaf);
    if (keys.length === 0)
      throw new OGMError(
        'Fulltext input must contain at least one index entry',
      );

    const key = keys[0];
    assertSafeIdentifier(key, 'fulltext index or relationship name');
    const value = leaf[key] as
      | FulltextIndexEntry
      | Record<string, FulltextIndexEntry>;

    // If value has `phrase`, it's a direct node index entry
    if (isFulltextIndexEntry(value))
      return this.compileNodeIndex(key, value, nodeDef, nodeVar, paramCounter);

    // Otherwise it's a relationship field → nested index entry
    return this.compileRelationshipIndex(
      key,
      value as Record<string, FulltextIndexEntry>,
      nodeDef,
      nodeVar,
      paramCounter,
    );
  }

  /** Compile a node-level fulltext index: `{ IndexName: { phrase, score? } }` */
  private compileNodeIndex(
    indexName: string,
    input: FulltextIndexEntry,
    nodeDef: NodeDefinition,
    nodeVar: string,
    paramCounter: { count: number },
  ): FulltextResult {
    assertValidFulltextPhrase(input.phrase);

    const nodeIndex = nodeDef.fulltextIndexes.find(
      (idx) => idx.name === indexName,
    );
    if (!nodeIndex)
      throw new OGMError(
        `Unknown fulltext index "${indexName}" for node "${nodeDef.typeName}"`,
      );

    const paramName = `ft_phrase_${paramCounter.count++}`;
    const params: Record<string, unknown> = { [paramName]: input.phrase };

    const cypher = [
      `CALL db.index.fulltext.queryNodes('${indexName}', $${paramName})`,
      `YIELD node AS ${nodeVar}, score`,
    ].join('\n');

    const result: FulltextResult = { cypher, params };

    if (input.score !== undefined) {
      const scoreName = `ft_score_${paramCounter.count - 1}`;
      params[scoreName] = input.score;
      result.scoreThreshold = input.score;
    }

    return result;
  }

  /**
   * Compile a relationship fulltext index:
   * `{ relFieldName: { IndexName: { phrase, score? } } }`
   *
   * Validates that the relationship field exists on the node and that the
   * index belongs to its @relationshipProperties type.
   */
  private compileRelationshipIndex(
    relFieldName: string,
    inner: Record<string, FulltextIndexEntry>,
    nodeDef: NodeDefinition,
    nodeVar: string,
    paramCounter: { count: number },
  ): FulltextResult {
    // Validate relationship field exists on node
    const relDef = nodeDef.relationships.get(relFieldName);
    if (!relDef)
      throw new OGMError(
        `Unknown relationship field "${relFieldName}" on node "${nodeDef.typeName}"`,
      );

    if (!relDef.properties)
      throw new OGMError(
        `Relationship "${relFieldName}" on "${nodeDef.typeName}" has no @relationshipProperties`,
      );

    // Validate index exists on the relationship properties type
    const relProps = this.schema.relationshipProperties.get(relDef.properties);
    if (!relProps)
      throw new OGMError(
        `@relationshipProperties type "${relDef.properties}" not found`,
      );

    const innerKeys = Object.keys(inner);
    if (innerKeys.length === 0)
      throw new OGMError(
        'Relationship fulltext entry must contain an index name',
      );

    const indexName = innerKeys[0];
    assertSafeIdentifier(indexName, 'fulltext index name');
    const input = inner[indexName];

    const ftIndex = (relProps.fulltextIndexes ?? []).find(
      (idx) => idx.name === indexName,
    );
    if (!ftIndex)
      throw new OGMError(
        `Unknown fulltext index "${indexName}" on @relationshipProperties "${relDef.properties}"`,
      );

    assertValidFulltextPhrase(input.phrase);

    const paramName = `ft_phrase_${paramCounter.count++}`;
    const params: Record<string, unknown> = { [paramName]: input.phrase };

    const cypher = [
      `CALL db.index.fulltext.queryRelationships('${indexName}', $${paramName})`,
      `YIELD relationship AS rel, score`,
      `WITH startNode(rel) AS ${nodeVar}, score`,
    ].join('\n');

    const result: FulltextResult = { cypher, params };

    if (input.score !== undefined) {
      const scoreName = `ft_score_${paramCounter.count - 1}`;
      params[scoreName] = input.score;
      result.scoreThreshold = input.score;
    }

    return result;
  }

  /**
   * OR: wrap branches in `CALL { ... UNION ... }` with max(score) deduplication.
   */
  private compileOr(
    branches: FulltextInput[],
    nodeDef: NodeDefinition,
    nodeVar: string,
    paramCounter: { count: number },
    depth: number,
  ): FulltextResult {
    if (branches.length === 0)
      throw new OGMError('OR must contain at least one branch');

    if (branches.length === 1)
      return this.compileNode(
        branches[0],
        nodeDef,
        nodeVar,
        paramCounter,
        depth,
      );

    const allParams: Record<string, unknown> = {};
    const unionBranches: string[] = [];

    for (const branch of branches) {
      const result = this.compileNode(
        branch,
        nodeDef,
        nodeVar,
        paramCounter,
        depth,
      );
      mergeParams(allParams, result.params);
      unionBranches.push(
        [
          `  ${result.cypher.split('\n').join('\n  ')}`,
          `  RETURN ${nodeVar}, score`,
        ].join('\n'),
      );
    }

    const cypher = [
      `CALL {`,
      unionBranches.join('\n  UNION\n'),
      `}`,
      `WITH ${nodeVar}, max(score) AS score`,
    ].join('\n');

    return { cypher, params: allParams };
  }

  /**
   * AND: sequential correlated subqueries.
   * First branch yields nodes, subsequent branches filter to matching nodes.
   */
  private compileAnd(
    branches: FulltextInput[],
    nodeDef: NodeDefinition,
    nodeVar: string,
    paramCounter: { count: number },
    depth: number,
  ): FulltextResult {
    if (branches.length === 0)
      throw new OGMError('AND must contain at least one branch');

    if (branches.length === 1)
      return this.compileNode(
        branches[0],
        nodeDef,
        nodeVar,
        paramCounter,
        depth,
      );

    const allParams: Record<string, unknown> = {};
    const cypherParts: string[] = [];

    // First branch: yields nodes normally
    const first = this.compileNode(
      branches[0],
      nodeDef,
      nodeVar,
      paramCounter,
      depth,
    );
    mergeParams(allParams, first.params);
    cypherParts.push(first.cypher);

    // Subsequent branches: correlated subqueries that filter to matching nodes
    for (let i = 1; i < branches.length; i++) {
      const branch = this.compileNode(
        branches[i],
        nodeDef,
        'm',
        paramCounter,
        depth,
      );
      mergeParams(allParams, branch.params);

      cypherParts.push(
        [
          `CALL {`,
          `  WITH ${nodeVar}`,
          `  ${branch.cypher.split('\n').join('\n  ')}`,
          `  WHERE m = ${nodeVar}`,
          `  RETURN score`,
          `}`,
        ].join('\n'),
      );
    }

    cypherParts.push(`WITH ${nodeVar}, score`);

    const cypher = cypherParts.join('\n');
    return { cypher, params: allParams };
  }

  /**
   * NOT: produces a WHERE NOT EXISTS { ... } clause.
   * When used standalone, wraps in a MATCH-all then filters out.
   */
  private compileNot(
    inner: FulltextInput,
    nodeDef: NodeDefinition,
    nodeVar: string,
    paramCounter: { count: number },
    depth: number,
  ): FulltextResult {
    const innerResult = this.compileNode(
      inner,
      nodeDef,
      'excluded',
      paramCounter,
      depth,
    );
    const allParams: Record<string, unknown> = { ...innerResult.params };

    const cypher = [
      `MATCH (${nodeVar}:${escapeIdentifier(nodeDef.label)})`,
      `WHERE NOT EXISTS {`,
      `  ${innerResult.cypher.split('\n').join('\n  ')}`,
      `  WHERE excluded = ${nodeVar}`,
      `}`,
      `WITH ${nodeVar}, 0 AS score`,
    ].join('\n');

    return { cypher, params: allParams };
  }
}
