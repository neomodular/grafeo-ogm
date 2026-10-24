/**
 * Live suite (v2.21.0, strict item 41): disconnect items that are not objects.
 *
 * A string / number / boolean / array item (`disconnect: { posts: ['p1'] }`,
 * `posts: true`, a nested `disconnect: [5]`) carries no `where`, so it
 * compiled to the blanket disconnect and unlinked EVERY related node.
 * Default mode keeps that (one warning per OGM and field); `strict: true`
 * throws an OGMError and unlinks nothing. The target's read policy still
 * bounds the default-mode blanket form.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterEach`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';
import { permissive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItDnoAuthor @node {
    id: ID! @id
    runId: String
    posts: [ItDnoPost!]! @relationship(type: "IT_DNO_WROTE", direction: OUT)
  }
  type ItDnoPost @node {
    id: ID! @id
    runId: String
    title: String
    visible: Boolean
    tags: [ItDnoTag!]! @relationship(type: "IT_DNO_TAGGED", direction: OUT)
  }
  type ItDnoTag @node {
    id: ID! @id
    runId: String
    name: String
  }
`;

/** Garbage the generated types reject; the cast is the point. */
const garbage = (v: unknown) => v as never;

describeLive('non-object disconnect items (2.21.0) — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let driver: Driver;

  async function run(cypher: string, params: Record<string, unknown> = {}) {
    const session = driver.session();
    try {
      const res = await session.run(cypher, { runId, ...params });
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  const titles = async (id: string) =>
    (
      await run(
        'MATCH (:ItDnoAuthor {id: $id})-[:IT_DNO_WROTE]->(p) RETURN p.title AS t ORDER BY t',
        { id },
      )
    ).map((r) => r.t as string);

  const tagCount = async (title: string) =>
    (
      await run(
        'MATCH (p:ItDnoPost {runId: $runId, title: $title})-[:IT_DNO_TAGGED]->(t) RETURN count(t) AS c',
        { title },
      )
    )[0].c as number;

  /** Author with posts p1 (2 tags), p2, and hidden p3. */
  async function seed(): Promise<string> {
    const id = `${runId}-${randomUUID()}`;
    await run(
      `CREATE (a:ItDnoAuthor {id: $id, runId: $runId})
       CREATE (a)-[:IT_DNO_WROTE]->(p1:ItDnoPost {id: $id + '-p1', runId: $runId, title: 'p1', visible: true})
       CREATE (a)-[:IT_DNO_WROTE]->(:ItDnoPost {id: $id + '-p2', runId: $runId, title: 'p2', visible: true})
       CREATE (a)-[:IT_DNO_WROTE]->(:ItDnoPost {id: $id + '-p3', runId: $runId, title: 'p3', visible: false})
       CREATE (p1)-[:IT_DNO_TAGGED]->(:ItDnoTag {id: $id + '-t1', runId: $runId, name: 't1'})
       CREATE (p1)-[:IT_DNO_TAGGED]->(:ItDnoTag {id: $id + '-t2', runId: $runId, name: 't2'})`,
      { id },
    );
    return id;
  }

  const make = (
    strict: boolean,
    policies?: ConstructorParameters<typeof OGM>[0]['policies'],
  ) => {
    const logger = { debug: jest.fn(), warn: jest.fn() };
    const ogm = new OGM({
      typeDefs,
      driver,
      strict,
      logger,
      ...(policies ? { policies } : {}),
    });
    const warnings = (needle: string) =>
      logger.warn.mock.calls.filter((c) => String(c[0]).includes(needle));
    return { ogm, warnings };
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
    await driver.verifyConnectivity();
  });

  afterEach(async () => {
    await run(
      'MATCH (n) WHERE (n:ItDnoAuthor OR n:ItDnoPost OR n:ItDnoTag) AND n.runId = $runId DETACH DELETE n',
    );
  });

  afterAll(async () => {
    if (driver) await driver.close();
  });

  const rootShapes: [string, unknown][] = [
    ['a string item', [{ where: { node: { title: 'p1' } } }, 'p2']],
    ['a number item', [5]],
    ['an array item', [['p1']]],
    ['a boolean spec', true],
  ];

  it.each(rootShapes)(
    'default: a root disconnect with %s still unlinks every post, and warns once',
    async (_n, spec) => {
      const { ogm, warnings } = make(false);
      const id = await seed();
      const A = ogm.model('ItDnoAuthor');
      await A.update({ where: { id }, disconnect: { posts: garbage(spec) } });
      expect(await titles(id)).toEqual([]);
      await A.update({ where: { id }, disconnect: { posts: garbage(spec) } });
      expect(warnings('A disconnect item on "posts" is')).toHaveLength(1);
    },
  );

  it.each(rootShapes)(
    'strict: a root disconnect with %s throws an OGMError and unlinks nothing',
    async (_n, spec) => {
      const { ogm } = make(true);
      const id = await seed();
      await expect(
        ogm
          .model('ItDnoAuthor')
          .update({ where: { id }, disconnect: { posts: garbage(spec) } }),
      ).rejects.toThrow(OGMError);
      expect(await titles(id)).toEqual(['p1', 'p2', 'p3']);
    },
  );

  it.each([false, true])(
    'strict=%s: a nested update disconnect [5] (default: unlinks all; strict: throws)',
    async (strict) => {
      const { ogm } = make(strict);
      const id = await seed();
      const write = ogm.model('ItDnoAuthor').update({
        where: { id },
        update: { posts: [{ disconnect: [garbage(5)] }] },
      });
      if (strict) {
        await expect(write).rejects.toThrow(OGMError);
        expect(await titles(id)).toEqual(['p1', 'p2', 'p3']);
      } else {
        await write;
        expect(await titles(id)).toEqual([]);
      }
    },
  );

  it.each([false, true])(
    "strict=%s: a disconnect item's own disconnect with a string item",
    async (strict) => {
      const { ogm } = make(strict);
      const id = await seed();
      const write = ogm.model('ItDnoAuthor').update({
        where: { id },
        disconnect: {
          posts: [
            {
              where: { node: { title: 'p1' } },
              disconnect: { tags: [garbage('t1')] },
            },
          ],
        },
      });
      if (strict) {
        await expect(write).rejects.toThrow(
          'A disconnect item on "tags" is a string.',
        );
        expect(await titles(id)).toEqual(['p1', 'p2', 'p3']);
        expect(await tagCount('p1')).toBe(2);
      } else {
        await write;
        expect(await titles(id)).toEqual(['p2', 'p3']);
        expect(await tagCount('p1')).toBe(0);
      }
    },
  );

  it('default with a read policy: the blanket form only unlinks posts the caller can read', async () => {
    const { ogm } = make(false, {
      ItDnoPost: [
        permissive({
          operations: ['read'],
          when: () => ({ visible: true }),
          name: 'post.read-visible',
        }),
      ],
    });
    const id = await seed();
    await ogm
      .withContext({})
      .model('ItDnoAuthor')
      .update({ where: { id }, disconnect: { posts: garbage(['x']) } });
    expect(await titles(id)).toEqual(['p3']);
  });

  it.each([false, true])(
    'strict=%s: `{ posts: [{}] }` and `{ posts: null }` stay the blanket disconnect, without a warning',
    async (strict) => {
      const { ogm, warnings } = make(strict);
      const A = ogm.model('ItDnoAuthor');
      const id1 = await seed();
      await A.update({ where: { id: id1 }, disconnect: { posts: [{}] } });
      expect(await titles(id1)).toEqual([]);
      const id2 = await seed();
      await A.update({ where: { id: id2 }, disconnect: { posts: null } });
      expect(await titles(id2)).toEqual([]);
      expect(warnings('A disconnect item')).toEqual([]);
    },
  );
});
