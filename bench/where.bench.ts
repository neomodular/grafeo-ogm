/**
 * WhereCompiler hot-path benchmarks.
 *
 * What we measure:
 * - Simple equality (cheapest path — single key, no operator suffix)
 * - Mixed operators (4 keys, multiple operator templates)
 * - Deep logical nesting (AND/OR/NOT recursion — exercises the
 *   per-frame `params:{}` allocation that Tier 4 fix C targets)
 * - Relationship _SOME with inner where (recursion + EXISTS body)
 * - Connection node + edge (two scopes + two compileConditions calls)
 *
 * Each benchmark RETURNS the result so mitata's sink prevents V8
 * dead-code elimination of the entire body — see the explanation in
 * the v1.8.0 design notes.
 */

import { bench, group } from 'mitata';
import { WhereCompiler } from '../src/compilers/where.compiler';
import {
  bookNode,
  schema,
  SIMPLE_WHERE,
  MIXED_OPERATORS_WHERE,
  DEEP_LOGICAL_WHERE,
  RELATIONSHIP_SOME_WHERE,
  CONNECTION_NODE_EDGE_WHERE,
} from './fixtures';

const compiler = new WhereCompiler(schema);

group('WhereCompiler.compile', () => {
  bench('simple equality', () => compiler.compile(SIMPLE_WHERE, 'n', bookNode));

  bench('mixed operators (4 keys)', () =>
    compiler.compile(MIXED_OPERATORS_WHERE, 'n', bookNode),
  );

  bench('deep logical AND/OR/NOT', () =>
    compiler.compile(DEEP_LOGICAL_WHERE, 'n', bookNode),
  );

  bench('relationship _SOME with inner where', () =>
    compiler.compile(RELATIONSHIP_SOME_WHERE, 'n', bookNode),
  );

  bench('connection where (node + edge)', () =>
    compiler.compile(CONNECTION_NODE_EDGE_WHERE, 'n', bookNode),
  );
});
