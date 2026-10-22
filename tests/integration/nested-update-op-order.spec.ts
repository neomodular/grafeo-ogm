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
 *
 * The same holds for the root `update()` arguments: by default the root
 * `disconnect` runs after the `update` body, under strict mode before it.
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
    authors: [ItOpOrderUser!]!
      @relationship(type: "IT_OP_ORDER_WROTE", direction: IN)
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

  // --- root update() arguments ---------------------------------------------

  const rootWarnings = (w: string[]) =>
    w.filter((m) => m.includes('runs the root `disconnect` after'));

  async function title(postId: string): Promise<string | undefined> {
    const rows = await run(
      'MATCH (p:ItOpOrderPost {id: $postId}) RETURN p.title AS title',
      { postId },
    );
    return rows[0]?.title as string | undefined;
  }

  /** Seed, then also link post `b`, so the user has `a` and `b` ("old"). */
  async function seedTwo() {
    const s = await seed();
    await run(
      `MATCH (u:ItOpOrderUser {id: $u}), (b:ItOpOrderPost {id: $b})
       CREATE (u)-[:IT_OP_ORDER_WROTE]->(b)`,
      s,
    );
    return s;
  }

  async function rootDisconnectUpdate(strict?: boolean) {
    const { u, a, b } = await seedTwo();
    const { ogm, warnings } = makeOgm(strict);
    await ogm.model('ItOpOrderUser').update({
      where: { id: u },
      update: { posts: [{ update: { node: { title: 'new' } } }] },
      disconnect: { posts: [{ where: { node: { id: a } } }] },
    });
    return { linked: await posts(u), aTitle: await title(a), b, warnings };
  }

  it('root, default: the nested update also renames the post the root disconnect unlinks (and warns)', async () => {
    const { linked, aTitle, b, warnings } = await rootDisconnectUpdate();
    expect(linked).toEqual({ [b]: 'new' });
    expect(aTitle).toBe('new');
    expect(rootWarnings(warnings)).toHaveLength(1);
  });

  it('root, strict: the root disconnect runs first, so the unlinked post keeps its title', async () => {
    const { linked, aTitle, b, warnings } = await rootDisconnectUpdate(true);
    expect(linked).toEqual({ [b]: 'new' });
    expect(aTitle).toBe('old');
    expect(warnings).toEqual([]);
  });

  async function rootBlanketDisconnectCreate(strict?: boolean) {
    const { u } = await seedTwo();
    const { ogm, warnings } = makeOgm(strict);
    const c = id('c');
    await ogm.model('ItOpOrderUser').update({
      where: { id: u },
      update: { posts: [{ create: [{ node: { id: c, runId, title: 'n' } }] }] },
      disconnect: { posts: null },
    });
    return { linked: await posts(u), c, warnings };
  }

  it('root, default: a blanket root disconnect also unlinks the post the nested create added (and warns)', async () => {
    const { linked, warnings } = await rootBlanketDisconnectCreate();
    expect(linked).toEqual({});
    expect(rootWarnings(warnings)).toHaveLength(1);
  });

  it('root, strict: the blanket root disconnect runs first and the created post stays linked', async () => {
    const { linked, c } = await rootBlanketDisconnectCreate(true);
    expect(linked).toEqual({ [c]: 'n' });
  });

  async function rootDisconnectDelete(strict?: boolean) {
    const { u, a } = await seed();
    const { ogm } = makeOgm(strict);
    await ogm.model('ItOpOrderUser').update({
      where: { id: u },
      update: { posts: [{ delete: [{ where: { node: { id: a } } }] }] },
      disconnect: { posts: [{ where: { node: { id: a } } }] },
    });
    return { aTitle: await title(a), linked: await posts(u) };
  }

  it('root, default: the nested delete runs first and deletes the post', async () => {
    expect(await rootDisconnectDelete()).toEqual({
      aTitle: undefined,
      linked: {},
    });
  });

  it('root, strict: the root disconnect runs first, so the nested delete no longer reaches the post', async () => {
    expect(await rootDisconnectDelete(true)).toEqual({
      aTitle: 'old',
      linked: {},
    });
  });

  it('root, strict: a cycle delete of the root after the root disconnect is guarded (F1)', async () => {
    const { u, a, b } = await seedTwo();
    const { ogm } = makeOgm(true);
    const res = await ogm.model('ItOpOrderUser').update({
      where: { id: u },
      update: {
        posts: [
          {
            where: { node: { id: b } },
            update: { node: { authors: [{ delete: [{}] }] } },
          },
        ],
      },
      disconnect: { posts: [{ where: { node: { id: a } } }] },
      connect: { posts: [{ where: { node: { id: a } } }] },
      selectionSet: '{ id }',
    });
    expect(res.itOpOrderUsers).toEqual([]);
    expect(
      await run('MATCH (n:ItOpOrderUser {id: $u}) RETURN n', { u }),
    ).toEqual([]);
    // The post the root disconnect unlinked was not re-linked to anything.
    expect(
      await run(
        'MATCH (:ItOpOrderPost {id: $a})<-[r]-() RETURN count(r) AS c',
        { a },
      ),
    ).toEqual([{ c: 0 }]);
  });
});
