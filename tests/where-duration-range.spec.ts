/**
 * v2.15.0 — range filters on a Duration field.
 *
 * Neo4j does not order durations (`duration > duration` is `null`), so the
 * plain `n.d > $p` never matched and `n.d >= $p` matched only an equal
 * duration. Like `@neo4j/graphql` 5.x (`createDurationOperation`), both
 * sides are added to the current instant:
 * `datetime() + n.d > datetime() + duration($p)`.
 *
 * - `_GT` / `_LT`: corrected in both modes.
 * - `_GTE` / `_LTE`: strict item 25; default mode is byte-identical to
 *   v2.12.3 and warns once per OGM, type and field
 *   (`duration-range-equality`).
 * - Everything else (Duration equality / `_NOT` / `_IN`, list fields,
 *   other temporals and numbers) is byte-identical to v2.12.3 in both
 *   modes.
 *
 * `fixtures/where-duration-range.v2.12.3.json` is the Cypher v2.12.3
 * (3a8d21f) emits for every case, in both modes, recorded from a worktree
 * of that commit with these same cases. A corrected statement is the
 * v2.12.3 statement with `datetime() + ` added in front of both operands.
 *
 * Live suite: tests/integration/where-duration-range.spec.ts.
 */
import { Model } from '../src/model';
import v2123 from './fixtures/where-duration-range.v2.12.3.json';
import {
  durationCases,
  harness,
  run,
  UNCHANGED_CASES,
  type Case,
} from './where-duration-range.cases';

const BASELINE = v2123 as Record<string, string[]>;

beforeEach(() => Model.clearSelectionCache());

const key = (strict: boolean, c: Case) =>
  `${strict ? 'strict' : 'default'} | ${c[0]}`;

const cyphers = async (c: Case, strict: boolean) =>
  (await run(c, strict)).statements.map((s) => s.cypher);

describe.each([false, true])('strict: %s', (strict) => {
  it.each(UNCHANGED_CASES.map((c) => [c[0], c] as const))(
    'byte-identical to v2.12.3: %s',
    async (_name, c) => {
      const r = await run(c, strict);
      expect(r.statements.map((s) => s.cypher)).toEqual(
        BASELINE[key(strict, c)],
      );
      expect(r.warnings).toEqual([]);
    },
  );

  const corrected = ['_GT', '_LT', ...(strict ? ['_GTE', '_LTE'] : [])];
  it.each(corrected.flatMap(durationCases).map((c) => [c[0], c] as const))(
    'compared at the current instant: %s',
    async (_name, c) => {
      const r = await run(c, strict);
      const got = r.statements.map((s) => s.cypher);
      const base = BASELINE[key(strict, c)];
      expect(got).toHaveLength(base.length);
      // Exactly one comparison changed, by `datetime() + ` on both sides.
      const joined = got.join('\n');
      expect(joined.match(/datetime\(\) \+ /g)).toHaveLength(2);
      expect(got.map((s) => s.replace(/datetime\(\) \+ /g, ''))).toEqual(base);
      expect(r.warnings).toEqual([]);
    },
  );
});

describe('default mode, _GTE / _LTE', () => {
  it.each(
    ['_GTE', '_LTE'].flatMap(durationCases).map((c) => [c[0], c] as const),
  )('byte-identical to v2.12.3 and warns: %s', async (_name, c) => {
    const r = await run(c, false);
    expect(r.statements.map((s) => s.cypher)).toEqual(BASELINE[key(false, c)]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(
      /^\[OGM\] `LbDur(Task\.d|Step\.d|Wait\.wait)` is a Duration: in 2\.x its _GTE \/ _LTE filters match only an equal duration/,
    );
    expect(r.warnings[0]).toContain(
      'Enable `strict: true` (default in 3.0) to compare durations by adding them to the current instant',
    );
  });

  it('warns once per OGM, type and field', async () => {
    const h = harness();
    const find = (where: Record<string, unknown>) =>
      h.task().find({ where: where as never, selectionSet: '{ id }' });
    await find({ d_GTE: 'P1D' });
    await find({ d_LTE: 'P2D' });
    await find({ d_GTE: 'P3D', steps_SOME: { d_LTE: 'P1D' } });
    await find({ stepsConnection_SOME: { edge: { wait_GTE: 'P1D' } } });
    await find({ stepsConnection_SOME: { edge: { wait_LTE: 'P1D' } } });
    expect(h.warnings.map((w) => w.split(' is a ')[0])).toEqual([
      '[OGM] `LbDurTask.d`',
      '[OGM] `LbDurStep.d`',
      '[OGM] `LbDurWait.wait`',
    ]);
  });
});

describe('exact Cypher', () => {
  it.each([
    ['_GT', '>'],
    ['_LT', '<'],
  ])('%s in both modes', async (op, cmp) => {
    for (const strict of [false, true]) {
      const [c] = durationCases(op);
      expect(await cyphers(c, strict)).toEqual([
        `MATCH (n:\`LbDurTask\`)\nWHERE datetime() + n.\`d\` ${cmp} datetime() + duration($param0)\nRETURN n { .\`id\` }`,
      ]);
    }
  });

  it('_GTE / _LTE: default keeps the plain comparison, strict compares at the current instant', async () => {
    const [gte] = durationCases('_GTE');
    expect(await cyphers(gte, false)).toEqual([
      'MATCH (n:`LbDurTask`)\nWHERE n.`d` >= duration($param0)\nRETURN n { .`id` }',
    ]);
    expect(await cyphers(gte, true)).toEqual([
      'MATCH (n:`LbDurTask`)\nWHERE datetime() + n.`d` >= datetime() + duration($param0)\nRETURN n { .`id` }',
    ]);
  });

  it('a driver Duration value is not wrapped in duration()', async () => {
    const { Duration } = await import('neo4j-driver');
    const h = harness();
    await h.task().find({
      where: { d_GT: new Duration(1, 0, 0, 0) } as never,
      selectionSet: '{ id }',
    });
    expect(h.statements()[0].cypher).toBe(
      'MATCH (n:`LbDurTask`)\nWHERE datetime() + n.`d` > datetime() + $param0\nRETURN n { .`id` }',
    );
  });
});
