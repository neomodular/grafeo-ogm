/**
 * Live createMany suite (v2.4.6).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Every node it
 * creates carries this run's `runId` and is removed in `afterAll`.
 *
 * createMany took its column list from `data[0]` only: fields that only
 * later items supplied were silently dropped, an `@id` supplied by some
 * items left the others with a null id, and a `@default` column default
 * overwrote values later items supplied.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItCmTag @node {
    id: ID! @id
  }
  type ItCmPerson @node {
    id: ID! @id
    runId: String
    email: String @unique
    name: String
    age: Int
    status: String @default(value: "active")
    tags: [ItCmTag!]! @relationship(type: "IT_CM_TAGGED", direction: OUT)
  }
`;

type Row = Record<string, unknown>;

describeLive('createMany — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const email = (s: string) => `${s}-${runId}@example.test`;
  let driver: Driver;
  let ogm: OGM;

  async function people(): Promise<Row[]> {
    const session = driver.session();
    try {
      const res = await session.run(
        `MATCH (p:ItCmPerson {runId: $runId})
         RETURN p.email AS email, p.name AS name, p.age AS age, p.status AS status, p.id AS id
         ORDER BY email`,
        { runId },
      );
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

  afterEach(async () => {
    const session = driver.session();
    try {
      await session.run('MATCH (n {runId: $runId}) DETACH DELETE n', { runId });
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (driver) await driver.close();
  });

  const P = () => ogm.model('ItCmPerson');

  it('writes fields that only later items supply', async () => {
    await P().createMany({
      data: [
        { runId, email: email('a') },
        { runId, email: email('b'), name: 'B', age: 4 },
      ],
    });
    const rows = await people();
    expect(rows.map(({ email: e, name, age }) => ({ e, name, age }))).toEqual([
      { e: email('a'), name: null, age: null },
      { e: email('b'), name: 'B', age: 4 },
    ]);
  });

  it('gives every item an @id when only some supply one', async () => {
    await P().createMany({
      data: [
        { runId, email: email('c'), id: `${runId}-mine` },
        { runId, email: email('d') },
      ],
    });
    const [c, d] = await people();
    expect(c.id).toBe(`${runId}-mine`);
    expect(d.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('applies a @default per item without overwriting supplied values', async () => {
    await P().createMany({
      data: [
        { runId, email: email('e') },
        { runId, email: email('f'), status: 'banned' },
      ],
    });
    const [e, f] = await people();
    expect(e.status).toBe('active');
    expect(f.status).toBe('banned');
  });

  it('skipDuplicates still skips existing rows and writes later-only fields', async () => {
    await P().createMany({
      data: [{ runId, email: email('g'), name: 'orig' }],
    });
    await P().createMany({
      data: [
        { runId, email: email('g'), name: 'should-not-overwrite' },
        { runId, email: email('h'), name: 'H', age: 9 },
      ],
      skipDuplicates: true,
    });
    const [g, h] = await people();
    expect(g).toMatchObject({ email: email('g'), name: 'orig' });
    expect(h).toMatchObject({ email: email('h'), name: 'H', age: 9 });
  });

  // v2.5.0 — the count was `count(n)` after MERGE, which also counted the
  // matched (skipped) duplicates. Prisma returns the created count.
  it('skipDuplicates returns the number of nodes actually created', async () => {
    await P().createMany({ data: [{ runId, email: email('k') }] });
    const res = await P().createMany({
      data: [
        { runId, email: email('k') },
        { runId, email: email('l') },
        { runId, email: email('m') },
      ],
      skipDuplicates: true,
    });
    expect(res).toEqual({ count: 2 });
    const again = await P().createMany({
      data: [{ runId, email: email('k') }],
      skipDuplicates: true,
    });
    expect(again).toEqual({ count: 0 });
  });

  it('rejects a relationship field in the first item (unchanged)', async () => {
    await expect(
      P().createMany({
        data: [
          {
            runId,
            email: email('i'),
            tags: { create: [{ node: {} }] },
          } as never,
          { runId, email: email('j') },
        ],
      }),
    ).rejects.toThrow(OGMError);
    expect(await people()).toEqual([]);
  });
});
