/**
 * SelectionCompiler hot-path benchmarks.
 *
 * What we measure:
 * - parseSelectionSet on a CACHE HIT (the common case — same string
 *   reused across requests). Pre-1.7.5 this also re-touched the LRU;
 *   with the v1.7.5 LRU fix it does delete + re-set on every hit.
 * - parseSelectionSet on a CACHE MISS (forced by varying the input).
 *   Exercises the eviction path AND the underlying `graphql.parse()`.
 * - compile (the cypher emit step) on a parsed selection set.
 * - parse + compile end-to-end with a deeply nested selection.
 *
 * Tier 4 fix B (dedup selection caches) should show up in the cache-
 * hit benchmark — pre-fix every hit pays two `Map.get` calls
 * (Model._selectionCache + SelectionCompiler.parseCache); post-fix one.
 */

import { bench, group } from 'mitata';
import {
  SelectionCompiler,
  type SelectionNode,
} from '../src/compilers/selection.compiler';
import {
  bookNode,
  schema,
  SIMPLE_SELECTION_SET,
  NESTED_SELECTION_SET,
  DEEP_SELECTION_SET,
} from './fixtures';

const compiler = new SelectionCompiler(schema);

// Pre-warm the cache so the "hit" benchmark hits an existing entry.
const simpleParsed = compiler.parseSelectionSet(SIMPLE_SELECTION_SET);
const nestedParsed = compiler.parseSelectionSet(NESTED_SELECTION_SET);
const deepParsed = compiler.parseSelectionSet(DEEP_SELECTION_SET);

// Counter for forced cache misses — every benchmark iteration sees a
// fresh string so the cache never serves it.
let missCounter = 0;

group('SelectionCompiler.parseSelectionSet', () => {
  bench('cache hit — simple', () =>
    compiler.parseSelectionSet(SIMPLE_SELECTION_SET),
  );

  bench('cache hit — nested', () =>
    compiler.parseSelectionSet(NESTED_SELECTION_SET),
  );

  bench('cache miss — fresh string each call', () => {
    missCounter++;
    return compiler.parseSelectionSet(`{ id field${missCounter} }`);
  });
});

group('SelectionCompiler.compile (already-parsed)', () => {
  bench('compile simple', () =>
    compiler.compile(simpleParsed as SelectionNode[], 'n', bookNode),
  );

  bench('compile nested (1 level rels)', () =>
    compiler.compile(nestedParsed as SelectionNode[], 'n', bookNode),
  );

  bench('compile deep (multi-level rels + connection)', () =>
    compiler.compile(deepParsed as SelectionNode[], 'n', bookNode),
  );
});
