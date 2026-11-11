/**
 * Live suite (v2.30.0): a Duration read through grafeo can be written back.
 *
 * Pre-v2.30.0 the ResultMapper returned the driver's `Duration.toString()`.
 * neo4j-driver 6 changed that string (`P10YT`, `P2DT`, `PT1H`) and Neo4j 5.x
 * rejects the forms ending in `T` in `duration()` ("Text cannot be parsed
 * to a Duration"), which grafeo wraps every Duration write and filter
 * value in. On driver 6, writing back a value grafeo had just returned
 * threw. Every driver now gets driver 5's form (`P120M0DT0S`).
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItDurRt @node {
    id: ID! @id
    runId: String
    name: String
    ttl: Duration
    ttls: [Duration!]
  }
`;

type Row = Record<string, unknown>;

/** Stored Cypher literal → the string grafeo returns for it. */
const CASES: Array<[name: string, cypher: string, expected: string]> = [
  ['whole years', "duration('P10Y')", 'P120M0DT0S'],
  ['whole days', "duration('P2D')", 'P0M2DT0S'],
  ['one hour', "duration('PT1H')", 'P0M0DT3600S'],
  [
    'mixed, with nanoseconds',
    "duration('P1Y2M3DT4H5M6.000000007S')",
    'P14M3DT14706.000000007S',
  ],
  ['negative, with nanoseconds', "duration('PT-1.5S')", 'P0M0DT-1.500000000S'],
  ['zero', "duration('PT0S')", 'P0M0DT0S'],
];

describeLive('Duration output round-trips (v2.30.0) — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let driver: Driver;
  let ogm: OGM;

  async function run(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Row[]> {
    const session = driver.session();
    try {
      const res = await session.run(cypher, { runId, ...params });
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  const model = () => ogm.model('ItDurRt');

  /** Whether node `a`'s ttl / ttls equal node `b`'s, compared in Cypher. */
  const sameAs = async (a: string, b: string) =>
    (
      await run(
        `MATCH (a:ItDurRt {runId: $runId, name: $a}), (b:ItDurRt {runId: $runId, name: $b})
         RETURN a.ttl = b.ttl AS ttl, a.ttls = b.ttls AS ttls`,
        { a, b },
      )
    )[0];

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    await driver.verifyConnectivity();
    ogm = new OGM({ typeDefs, driver });
    for (const [name, cypher] of CASES)
      await run(
        `CREATE (:ItDurRt {id: randomUUID(), runId: $runId, name: $name,
                  ttl: ${cypher}, ttls: [${cypher}, duration('PT1M')]})`,
        { name: `src ${name}` },
      );
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n:ItDurRt {runId: $runId}) DETACH DELETE n');
      await driver.close();
    }
  });

  describe.each(CASES)('%s', (name, _cypher, expected) => {
    const src = `src ${name}`;
    const read = async () => {
      const rows = (await model().find({
        where: { runId, name: src },
        selectionSet: '{ ttl ttls }',
      })) as Array<{ ttl: string; ttls: string[] }>;
      expect(rows).toHaveLength(1);
      return rows[0];
    };

    it('reads the driver-5 ISO form on every driver', async () => {
      expect(await read()).toEqual({
        ttl: expected,
        ttls: [expected, 'P0M0DT60S'],
      });
    });

    it('the returned value matches the node in a where equality', async () => {
      const { ttl, ttls } = await read();
      const byTtl = await model().find({
        where: { runId, ttl },
        selectionSet: '{ name }',
      });
      expect(byTtl).toEqual([{ name: src }]);
      const byList = await model().find({
        where: { runId, name: src, ttls },
        selectionSet: '{ name }',
      });
      expect(byList).toEqual([{ name: src }]);
    });

    it('create stores the returned value unchanged', async () => {
      const { ttl, ttls } = await read();
      const copy = `create ${name}`;
      await model().create({ input: [{ runId, name: copy, ttl, ttls }] });
      expect(await sameAs(copy, src)).toEqual({ ttl: true, ttls: true });
    });

    it('update stores the returned value unchanged', async () => {
      const { ttl, ttls } = await read();
      const copy = `update ${name}`;
      await run(
        `CREATE (:ItDurRt {id: randomUUID(), runId: $runId, name: $copy,
                  ttl: duration('P99D'), ttls: [duration('P99D')]})`,
        { copy },
      );
      const res = (await model().update({
        where: { runId, name: copy },
        update: { ttl, ttls },
        selectionSet: '{ itDurRts { ttl ttls } }',
      })) as unknown as { itDurRts: Array<{ ttl: string; ttls: string[] }> };
      expect(res.itDurRts).toEqual([{ ttl, ttls }]);
      expect(await sameAs(copy, src)).toEqual({ ttl: true, ttls: true });
    });
  });
});
