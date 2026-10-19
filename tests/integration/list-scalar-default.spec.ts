/**
 * Live scalar `@default` on a list field (v2.5.3).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed in `afterAll`.
 *
 * `tags: [String!] @default(value: "solo")` stored the scalar `'solo'`
 * while the generated type says `string[]`. A single default value now
 * coerces to a one-element list, as GraphQL input coercion does.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItLdItem @node {
    id: ID! @id
    email: String @unique
    runId: String
    tags: [String!] @default(value: "solo")
    counts: [Int!] @default(value: 7)
  }
`;

describeLive('scalar @default on a list field — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let driver: Driver;
  let ogm: OGM;

  const stored = async () => {
    const session = driver.session();
    try {
      const res = await session.run(
        `MATCH (n:ItLdItem {runId: $runId})
         RETURN n.email AS email, n.tags AS tags, n.counts AS counts,
                valueType(n.tags) AS tagsType, valueType(n.counts) AS countsType
         ORDER BY email`,
        { runId },
      );
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  };

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    ogm = new OGM({ typeDefs, driver });
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      await session.run('MATCH (n:ItLdItem {runId: $runId}) DETACH DELETE n', {
        runId,
      });
    } finally {
      await session.close();
      await driver.close();
    }
  });

  it('create, createMany and upsert store a one-element list', async () => {
    const Item = ogm.model('ItLdItem');
    await Item.create({ input: [{ email: `a-${runId}`, runId }] });
    await Item.createMany({ data: [{ email: `b-${runId}`, runId }] });
    await Item.upsert({
      where: { email: `c-${runId}` },
      create: { email: `c-${runId}`, runId },
      update: {},
    });
    const rows = await stored();
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(row).toMatchObject({
        tags: ['solo'],
        counts: [7],
        tagsType: 'LIST<STRING NOT NULL> NOT NULL',
        countsType: 'LIST<INTEGER NOT NULL> NOT NULL',
      });
  });
});
