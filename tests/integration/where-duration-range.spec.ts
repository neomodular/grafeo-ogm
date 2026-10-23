/**
 * Live proof of Duration range filters (v2.15.0).
 *
 * Neo4j does not order durations: `duration > duration` is `null`. The
 * where compiler emitted a plain `n.d > $p`, so `_GT` / `_LT` on a Duration
 * field never matched a row and `_GTE` / `_LTE` matched only an EQUAL
 * duration. Like `@neo4j/graphql` 5.x, both sides are now added to the
 * current instant: `datetime() + n.d > datetime() + duration($p)`.
 *
 * - `_GT` / `_LT`: corrected in default and strict mode.
 * - `_GTE` / `_LTE`: strict mode only (item 25); default mode keeps the
 *   equality-only result and warns once (`duration-range-equality`).
 *
 * Mixed units: `P1M` is compared against `P27D` / `P32D`, which order the
 * same whatever month the suite runs in (a month is 28–31 days); `P1M` vs
 * `P30D` depends on the month starting today, so it is not asserted.
 *
 * Paths: root where, nested relationship filter, connection edge filter
 * (Duration relationship property), nested selection where,
 * `<rel>Aggregate(where)`, `aggregate()` where, a policy `when` partial and
 * the array-connect fast path's where.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId`, every query filters on it, and `afterAll` deletes them.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = `
type ItDurTask @node {
  id: ID! @unique
  runId: String
  d: Duration
  steps: [ItDurStep!]! @relationship(type: "IT_DUR_HAS", direction: OUT, properties: "ItDurWait")
}
type ItDurStep @node {
  id: ID! @unique
  runId: String
  d: Duration
}
type ItDurWait @relationshipProperties {
  wait: Duration
}
`;

describeLive('Duration range filters — live Neo4j', () => {
  const runId = `it-dur-${randomUUID()}`;
  const id = (suffix: string) => `${runId}-${suffix}`;
  let driver: Driver;

  function makeOgm(strict: boolean, withPolicy = false) {
    const warnings: string[] = [];
    const ogm = new OGM({
      typeDefs,
      driver,
      strict,
      logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
      ...(withPolicy
        ? {
            policies: {
              ItDurTask: [
                permissive({
                  operations: ['read'],
                  name: 'long-tasks',
                  when: () => ({ d_GT: 'P27D' }),
                }),
              ],
            },
          }
        : {}),
    });
    return { ogm, warnings };
  }

  const ids = async (
    ogm: OGM,
    where: Record<string, unknown>,
  ): Promise<string[]> => {
    const rows = (await ogm
      .withContext({})
      .model('ItDurTask')
      .find({
        where: { runId, ...where } as never,
        selectionSet: '{ id }',
      })) as { id: string }[];
    return rows.map((r) => r.id.slice(runId.length + 1)).sort();
  };

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(process.env.NEO4J_USER!, process.env.NEO4J_PASSWORD!),
    );
    const session = driver.session();
    try {
      await session.run(
        `UNWIND $tasks AS t
         CREATE (:ItDurTask { id: $runId + '-' + t.id, runId: $runId,
                              d: CASE WHEN t.d IS NULL THEN null ELSE duration(t.d) END })`,
        {
          runId,
          tasks: [
            { id: 'a', d: 'P1M' },
            { id: 'b', d: 'P27D' },
            { id: 'c', d: 'P32D' },
            { id: 'd', d: 'P1D' },
            { id: 'e', d: null },
          ],
        },
      );
      await session.run(
        `CREATE (s1:ItDurStep { id: $runId + '-s1', runId: $runId, d: duration('P1M') })
         CREATE (s2:ItDurStep { id: $runId + '-s2', runId: $runId, d: duration('P1D') })
         WITH s1, s2
         MATCH (a:ItDurTask { id: $runId + '-a' }), (b:ItDurTask { id: $runId + '-b' })
         CREATE (a)-[:IT_DUR_HAS { wait: duration('P1M') }]->(s1)
         CREATE (b)-[:IT_DUR_HAS { wait: duration('P1D') }]->(s2)`,
        { runId },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      await session.run(
        `MATCH (n) WHERE (n:ItDurTask OR n:ItDurStep) AND n.runId = $runId DETACH DELETE n`,
        { runId },
      );
    } finally {
      await session.close();
    }
    await driver.close();
  });

  describe.each([false, true])('strict: %s', (strict) => {
    it('_GT / _LT order durations of mixed units', async () => {
      const { ogm } = makeOgm(strict);
      expect(await ids(ogm, { d_GT: 'P27D' })).toEqual(['a', 'c']);
      expect(await ids(ogm, { d_LT: 'P1M' })).toEqual(['b', 'd']);
      expect(await ids(ogm, { d_GT: 'P1M' })).toEqual(['c']);
      // A null duration never matches.
      expect(await ids(ogm, { d_LT: 'P100Y' })).toEqual(['a', 'b', 'c', 'd']);
    });

    it('equality and _IN keep comparing the durations themselves', async () => {
      const { ogm } = makeOgm(strict);
      expect(await ids(ogm, { d: 'P27D' })).toEqual(['b']);
      expect(await ids(ogm, { d_IN: ['P1D', 'P1M'] })).toEqual(['a', 'd']);
      // P1D and PT24H are different durations.
      expect(await ids(ogm, { d: 'PT24H' })).toEqual([]);
    });

    it('nested relationship and connection edge filters', async () => {
      const { ogm } = makeOgm(strict);
      expect(await ids(ogm, { steps_SOME: { d_GT: 'P27D' } })).toEqual(['a']);
      expect(
        await ids(ogm, { stepsConnection_SOME: { edge: { wait_LT: 'P27D' } } }),
      ).toEqual(['b']);
    });

    it('nested selection where and <rel>Aggregate(where)', async () => {
      const { ogm } = makeOgm(strict);
      const rows = (await ogm.model('ItDurTask').find({
        where: { runId } as never,
        selectionSet: `{ id steps(where: { d_GT: "P27D" }) { id } stepsAggregate(where: { d_LT: "P27D" }) { count } }`,
      })) as {
        id: string;
        steps: { id: string }[];
        stepsAggregate: { count: number };
      }[];
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(id('a'))!.steps.map((s) => s.id)).toEqual([id('s1')]);
      expect(byId.get(id('b'))!.steps).toEqual([]);
      expect(byId.get(id('a'))!.stepsAggregate.count).toBe(0);
      expect(byId.get(id('b'))!.stepsAggregate.count).toBe(1);
    });

    it('aggregate() where', async () => {
      const { ogm } = makeOgm(strict);
      const res = await ogm.model('ItDurTask').aggregate({
        where: { runId, d_GT: 'P27D' } as never,
        aggregate: { count: true },
      });
      expect(res.count).toBe(2);
    });

    it('policy `when` partial', async () => {
      const { ogm } = makeOgm(strict, true);
      expect(await ids(ogm, {})).toEqual(['a', 'c']);
    });

    it('array-connect fast path where', async () => {
      const { ogm } = makeOgm(strict);
      const tid = id(`f-${strict}`);
      const tasks = ogm.model('ItDurTask');
      await tasks.create({ input: [{ id: tid, runId }] } as never);
      await tasks.update({
        where: { id: tid } as never,
        connect: {
          steps: [{ where: { node: { runId, d_GT: 'P27D' } } }],
        } as never,
      });
      const rows = (await tasks.find({
        where: { id: tid } as never,
        selectionSet: '{ steps { id } }',
      })) as { steps: { id: string }[] }[];
      expect(rows[0].steps.map((s) => s.id)).toEqual([id('s1')]);
      await tasks.delete({ where: { id: tid } as never });
    });
  });

  describe('_GTE / _LTE', () => {
    it('strict: ordered at the current instant', async () => {
      const { ogm, warnings } = makeOgm(true);
      expect(await ids(ogm, { d_GTE: 'P27D' })).toEqual(['a', 'b', 'c']);
      expect(await ids(ogm, { d_LTE: 'P27D' })).toEqual(['b', 'd']);
      // P1D and PT24H are the same span from now (UTC), so they order equal.
      expect(await ids(ogm, { d_LTE: 'PT24H' })).toEqual(['d']);
      expect(
        await ids(ogm, {
          stepsConnection_SOME: { edge: { wait_GTE: 'P1M' } },
        }),
      ).toEqual(['a']);
      expect(warnings).toEqual([]);
    });

    it('default: match only an equal duration, and warn once per type and field', async () => {
      const { ogm, warnings } = makeOgm(false);
      expect(await ids(ogm, { d_GTE: 'P27D' })).toEqual(['b']);
      expect(await ids(ogm, { d_LTE: 'P27D' })).toEqual(['b']);
      expect(await ids(ogm, { d_LTE: 'PT24H' })).toEqual([]);
      const own = warnings.filter((w) => w.includes('ItDurTask.d'));
      expect(own).toHaveLength(1);
      expect(own[0]).toContain('Enable `strict: true` (default in 3.0)');
      await ids(ogm, { stepsConnection_SOME: { edge: { wait_GTE: 'P1M' } } });
      expect(warnings.filter((w) => w.includes('ItDurWait.wait'))).toHaveLength(
        1,
      );
    });
  });
});
