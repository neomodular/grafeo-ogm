/**
 * Live upsert suite (v2.4.1).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Every node it
 * creates carries this run's `runId` and is removed in `afterAll`.
 *
 * An upsert that took the ON CREATE branch never generated the `@id`, so
 * the node was stored without it (and the response carried `id: null` for
 * an `ID!` field). create() / createMany() always generated it.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItUpPerson @node {
    id: ID! @id
    runId: String
    email: String @unique
    name: String
  }
`;

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describeLive('upsert — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const email = (s: string) => `${s}-${runId}@example.test`;
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
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await driver.close();
    }
  });

  const Person = () => ogm.model('ItUpPerson');

  it('ON CREATE generates the @id, in the DB and in the response', async () => {
    const e = email('create');
    const res = (await Person().upsert({
      where: { email: e },
      create: { email: e, runId, name: 'A' },
      update: { name: 'B' },
      select: { id: true, name: true },
    } as never)) as Row;
    expect(res.id).toMatch(UUID);
    const [stored] = await run(
      'MATCH (p:ItUpPerson {email: $e}) RETURN p.id AS id',
      { e },
    );
    expect(stored.id).toBe(res.id);
  });

  it('ON MATCH keeps the existing id', async () => {
    const e = email('match');
    await run(
      'CREATE (:ItUpPerson {id: "fixed-id", runId: $runId, email: $e, name: "A"})',
      { e },
    );
    const res = (await Person().upsert({
      where: { email: e },
      create: { email: e, runId, name: 'unused' },
      update: { name: 'B' },
      select: { id: true, name: true },
    } as never)) as Row;
    expect(res).toEqual({ id: 'fixed-id', name: 'B' });
  });

  it('a caller-supplied id is kept on ON CREATE', async () => {
    const e = email('supplied');
    const res = (await Person().upsert({
      where: { email: e },
      create: { id: `${runId}-mine`, email: e, runId },
      update: {},
      select: { id: true },
    } as never)) as Row;
    expect(res.id).toBe(`${runId}-mine`);
  });
});
