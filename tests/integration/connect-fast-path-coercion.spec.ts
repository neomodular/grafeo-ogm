/**
 * Live suite (v2.18.0): an ARRAY `connect` whose `where` names a BigInt / Int
 * field by an integer string or a `bigint` (equality or `_IN`).
 *
 * The array form takes the UNWIND fast path, which bound the where values
 * raw: a String never equals the stored Long, so the connect linked
 * nothing — while the same item given alone (per-item path, WhereCompiler)
 * linked its target. Both shapes must now link.
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
  type ItCfHub @node {
    id: ID! @id
    runId: String
    items: [ItCfItem!]! @relationship(type: "IT_CF_HAS", direction: OUT)
  }
  type ItCfItem @node {
    id: ID! @id
    runId: String
    code: BigInt
    n: Int
    at: DateTime
  }
`;

describeLive('array connect coerces where values (v2.18.0) — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let driver: Driver;
  let ogm: OGM;

  async function count(hubId: string): Promise<number> {
    const session = driver.session();
    try {
      const res = await session.run(
        'MATCH (:ItCfHub {id: $hubId})-[:IT_CF_HAS]->(i) RETURN count(i) AS c',
        { hubId },
      );
      return res.records[0].get('c') as number;
    } finally {
      await session.close();
    }
  }

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
    await ogm.model('ItCfItem').create({
      input: [
        { runId, code: '9007199254740993', n: 5, at: '2024-01-01T00:00:00Z' },
        { runId, code: '9007199254740995', n: 6, at: '2024-02-01T00:00:00Z' },
      ],
    });
  });

  afterAll(async () => {
    if (driver) {
      const session = driver.session();
      try {
        await session.run(
          'MATCH (n) WHERE (n:ItCfHub OR n:ItCfItem) AND n.runId = $runId DETACH DELETE n',
          { runId },
        );
      } finally {
        await session.close();
      }
      await driver.close();
    }
  });

  const cases: [string, Record<string, unknown>[], number][] = [
    ['BigInt string', [{ code: '9007199254740993' }], 1],
    ['bigint', [{ code: BigInt('9007199254740993') }], 1],
    [
      'BigInt string _IN',
      [{ code_IN: ['9007199254740993', '9007199254740995'] }],
      2,
    ],
    [
      'two BigInt items',
      [{ code: '9007199254740993' }, { code: '9007199254740995' }],
      2,
    ],
    ['Int string', [{ n: '6' }], 1],
    ['Int number (unchanged)', [{ n: 5 }], 1],
    ['DateTime ISO string', [{ at: '2024-02-01T00:00:00Z' }], 1],
    [
      'DateTime ISO _IN',
      [{ at_IN: ['2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'] }],
      2,
    ],
  ];

  it.each(cases)('%s links its targets', async (_label, wheres, expected) => {
    const hubs = ogm.model('ItCfHub');
    const created = await hubs.create({ input: [{ runId }] });
    const hubId = (created as { itCfHubs: { id: string }[] }).itCfHubs[0].id;
    await hubs.update({
      where: { id: hubId },
      connect: {
        items: wheres.map((w) => ({ where: { node: { runId, ...w } } })),
      },
    });
    expect(await count(hubId)).toBe(expected);
  });
});
