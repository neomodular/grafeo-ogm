/**
 * MutationCompiler hot-path benchmark.
 *
 * What we measure:
 * - compileUpdate with simple property update + where (the scaffolding
 *   path: `{ ...whereResult.params }` spread is at line 135 / 214 / 336
 *   in mutation.compiler.ts — Tier 4 fix D targets this allocation).
 * - compileCreate with scalar properties (the cheaper baseline).
 * - compileDelete with where (exercises the same params spread).
 *
 * Each benchmark RETURNS the result so mitata's sink prevents V8 from
 * eliding the call.
 */

import { bench, group } from 'mitata';
import { MutationCompiler } from '../src/compilers/mutation.compiler';
import { schema, bookNode } from './fixtures';

const compiler = new MutationCompiler(schema);

const baseWhereResult = {
  cypher: 'n.`id` = $param0',
  params: { param0: 'abc123' },
};

// Slightly larger where with a few params — closer to a realistic
// workload where the spread cost grows with key count.
const widerWhereResult = {
  cypher:
    'n.`id` = $param0 AND n.`title` = $param1 AND n.`pageCount` >= $param2',
  params: {
    param0: 'abc',
    param1: 'Foo',
    param2: 100,
    extra1: 'noise',
    extra2: 'noise',
  },
};

group('MutationCompiler', () => {
  bench('compileUpdate — simple SET', () =>
    compiler.compileUpdate(
      { id: 'abc123' },
      { title: 'Updated' },
      undefined,
      undefined,
      bookNode,
      baseWhereResult,
    ),
  );

  bench('compileUpdate — wider where', () =>
    compiler.compileUpdate(
      { id: 'abc123' },
      { title: 'Updated', isbn: '978-...' },
      undefined,
      undefined,
      bookNode,
      widerWhereResult,
    ),
  );

  bench('compileDelete — basic', () =>
    compiler.compileDelete(bookNode, baseWhereResult, {}),
  );

  bench('compileCreate — scalar only', () =>
    compiler.compileCreate(
      [{ title: 'New Book', isbn: '978-...', pageCount: 200 }],
      bookNode,
    ),
  );
});
