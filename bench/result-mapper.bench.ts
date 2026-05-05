/**
 * ResultMapper hot-path benchmark.
 *
 * `convertNeo4jTypes` runs on EVERY row of EVERY query result, so per-
 * visit allocation cost is the most-multiplied number in the OGM. Tier
 * 4 fix E (replace `Object.entries` + `Object.create(null)` with
 * `for...in` + `hasOwnProperty`) should show its biggest gains here.
 *
 * Test shapes:
 * - Pure scalar map (no Neo4j types) — fast path baseline
 * - Single Neo4j Integer (in safe range)
 * - Mixed scalar + temporals + nested object
 * - Deeply nested relationship-style result (5 children, 10 grandchildren)
 *   — the realistic shape of `Model.find({ select: { ..., rel: { ... } } })`
 */

import { bench, group } from 'mitata';
import neo4j from 'neo4j-driver';
import { ResultMapper } from '../src/execution/result-mapper';

const PURE_SCALAR = { id: 'abc', title: 'Foo', rating: 4.5 };

const SINGLE_INT = { count: neo4j.int(42) };

const MIXED = {
  id: 'abc',
  title: 'Foo',
  pageCount: neo4j.int(300),
  publishedAt: new neo4j.types.DateTime(2024, 1, 15, 10, 30, 0, 0, 0),
  metadata: { tag: 'fiction', shelf: 'top' },
};

// Realistic nested shape: a parent node with a relationship array of 10
// children, each with their own scalar properties.
const NESTED_RELATIONSHIP_RESULT = {
  id: 'parent',
  title: 'Parent',
  pageCount: neo4j.int(500),
  hasReviews: Array.from({ length: 10 }, (_, i) => ({
    id: `r${i}`,
    score: neo4j.int(i + 1),
    text: `Review number ${i}`,
    createdAt: new neo4j.types.DateTime(2024, 1, i + 1, 0, 0, 0, 0, 0),
  })),
  taggedWith: Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`,
    label: `tag-${i}`,
  })),
};

group('ResultMapper.convertNeo4jTypes', () => {
  bench('pure scalar map', () => ResultMapper.convertNeo4jTypes(PURE_SCALAR));

  bench('single Neo4j Integer (safe range)', () =>
    ResultMapper.convertNeo4jTypes(SINGLE_INT),
  );

  bench('mixed types + nested object', () =>
    ResultMapper.convertNeo4jTypes(MIXED),
  );

  bench('nested relationship array (10 reviews + 5 tags)', () =>
    ResultMapper.convertNeo4jTypes(NESTED_RELATIONSHIP_RESULT),
  );
});
