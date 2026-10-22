/**
 * Live suite — order of the ops within one nested update item (v2.9.0).
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
 *
 * Default mode keeps the 2.x order (delete, disconnect, connect, create,
 * update): the item's `update` also matches the nodes its own `connect` /
 * `create` just linked, and one warning is logged. `strict: true` takes the
 * @neo4j/graphql 5.x order (delete, disconnect, update, connect, create):
 * the `update` only touches the relationships that existed before.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItOpOrderUser @node {
    id: ID! @unique
    runId: String
    posts: [ItOpOrderPost!]!
      @relationship(type: "IT_OP_ORDER_WROTE", direction: OUT)
  }
  type ItOpOrderPost @node {
    id: ID! @unique
    runId: String
    title: String
  }
`;

type Row = Record<string, unknown>;

describeLive('Nested update item op order — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let seq = 0;
  const id = (s: string) => `${runId}-${s}-${seq}`;
  let driver: Driver;

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

  function makeOgm(strict?: boolean) {
    const warnings: string[] = [];
    const ogm = new OGM({
      typeDefs,
      driver,
      logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
      ...(strict === undefined ? {} : { strict }),
    });
    return { ogm, warnings };
  }

  /** `id -> title` of every post linked from the user. */
  async function posts(userId: string): Promise<Record<string, string>> {
    const rows = await run(
      `MATCH (:ItOpOrderUser {id: $userId})-[:IT_OP_ORDER_WROTE]->(p:ItOpOrderPost)
       RETURN p.id AS id, p.title AS title ORDER BY id`,
      { userId },
    );
    return Object.fromEntries(
      rows.map((r) => [r.id as string, r.title as string]),
    );
  }

  /** A user linked to post `a` (title "old") and an unlinked post `b` ("old"). */
  async function seed() {
    seq++;
    await run(
      `CREATE (u:ItOpOrderUser {id: $u, runId: $runId})
       CREATE (u)-[:IT_OP_ORDER_WROTE]->(:ItOpOrderPost {id: $a, runId: $runId, title: 'old'})
       CREATE (:ItOpOrderPost {id: $b, runId: $runId, title: 'old'})`,
      { u: id('u'), a: id('a'), b: id('b') },
    );
    return { u: id('u'), a: id('a'), b: id('b') };
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
  });

  afterAll(async () => {
    await run(
      'MATCH (n) WHERE (n:ItOpOrderUser OR n:ItOpOrderPost) AND n.runId = $runId DETACH DELETE n',
    );
    await driver.close();
  });

  const orderWarnings = (w: string[]) =>
    w.filter((m) => m.includes('runs `connect` / `create` before'));

  async function updateConnect(strict?: boolean) {
    const { u, a, b } = await seed();
    const { ogm, warnings } = makeOgm(strict);
    await ogm.model('ItOpOrderUser').update({
      where: { id: u },
      update: {
        posts: [
          {
            where: { node: { title: 'old' } },
            update: { node: { title: 'new' } },
            connect: [{ where: { node: { id: b } } }],
          },
        ],
      },
    });
    return { linked: await posts(u), a, b, warnings };
  }

  async function updateCreate(strict?: boolean) {
    const { u, a } = await seed();
    const { ogm, warnings } = makeOgm(strict);
    const c = id('c');
    await ogm.model('ItOpOrderUser').update({
      where: { id: u },
      update: {
        posts: [
          {
            update: { node: { title: 'new' } },
            create: [{ node: { id: c, runId, title: 'fresh' } }],
          },
        ],
      },
    });
    return { linked: await posts(u), a, c, warnings };
  }

  it('default: update also renames the post the same item connects (and warns)', async () => {
    const { linked, a, b, warnings } = await updateConnect();
    expect(linked).toEqual({ [a]: 'new', [b]: 'new' });
    expect(orderWarnings(warnings)).toHaveLength(1);
  });

  it('strict: update runs first and leaves the connected post alone', async () => {
    const { linked, a, b, warnings } = await updateConnect(true);
    expect(linked).toEqual({ [a]: 'new', [b]: 'old' });
    expect(warnings).toEqual([]);
  });

  it('default: update also renames the post the same item creates (and warns)', async () => {
    const { linked, a, c, warnings } = await updateCreate();
    expect(linked).toEqual({ [a]: 'new', [c]: 'new' });
    expect(orderWarnings(warnings)).toHaveLength(1);
  });

  it('strict: update runs first and leaves the created post alone', async () => {
    const { linked, a, c } = await updateCreate(true);
    expect(linked).toEqual({ [a]: 'new', [c]: 'fresh' });
  });

  it('strict: all five ops in one item run on Neo4j 5.x and return the root once', async () => {
    const { u, a, b } = await seed();
    const d = id('d');
    const q = id('q');
    await run(
      `MATCH (u:ItOpOrderUser {id: $u})
       CREATE (u)-[:IT_OP_ORDER_WROTE]->(:ItOpOrderPost {id: $d, runId: $runId, title: 'old'})
       CREATE (u)-[:IT_OP_ORDER_WROTE]->(:ItOpOrderPost {id: $q, runId: $runId, title: 'old'})`,
      { u, d, q },
    );
    const { ogm } = makeOgm(true);
    const c = id('c');
    const res = await ogm.model('ItOpOrderUser').update({
      where: { id: u },
      update: {
        posts: [
          {
            delete: [{ where: { node: { id: d } } }],
            disconnect: [{ where: { node: { id: q } } }],
            where: { node: { title: 'old' } },
            update: { node: { title: 'new' } },
            connect: [{ where: { node: { id: b } } }],
            create: [{ node: { id: c, runId, title: 'fresh' } }],
          },
        ],
      },
      selectionSet: '{ id }',
    });
    expect(res.itOpOrderUsers).toEqual([{ id: u }]);
    expect(await posts(u)).toEqual({ [a]: 'new', [b]: 'old', [c]: 'fresh' });
    expect(
      await run('MATCH (p:ItOpOrderPost {id: $d}) RETURN p', { d }),
    ).toEqual([]);
  });
});
