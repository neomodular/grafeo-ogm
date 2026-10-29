/**
 * Live suite (v2.25.0, strict item 44): a nested delete that is `true` or
 * falsy.
 *
 * `delete: true` is the undocumented pre-2.3.0 shorthand for "delete every
 * related node": in a nested update item it ignores the item's `where`, so
 * `posts: [{ where: { node: { title: 'p1' } }, delete: true }]` deletes
 * every post. A falsy value in a nested update item is skipped. Default mode
 * keeps both (one warning per OGM, field and shape); `strict: true` throws
 * an OGMError and deletes nothing. The target's delete policy still bounds
 * the default-mode `true` form.
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
  type ItDelAuthor @node {
    id: ID! @id
    runId: String
    posts: [ItDelPost!]! @relationship(type: "IT_DEL_WROTE", direction: OUT)
    items: [ItDelItem!]! @relationship(type: "IT_DEL_HAS", direction: OUT)
  }
  type ItDelPost @node {
    id: ID! @id
    runId: String
    title: String
    visible: Boolean
  }
  type ItDelDoc @node {
    id: ID! @id
    runId: String
    title: String
  }
  union ItDelItem = ItDelPost | ItDelDoc
`;

const garbage = (v: unknown) => v as never;

describeLive('`true` / falsy nested deletes (2.25.0) — live Neo4j', () => {
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

  /** Titles of every post / doc of this run still in the database. */
  const left = async () =>
    (
      await run(
        'MATCH (n) WHERE (n:ItDelPost OR n:ItDelDoc) AND n.runId = $runId RETURN n.title AS t ORDER BY t',
      )
    ).map((r) => r.t as string);

  /** Author with posts p1, p2 and hidden p3; items: post i1, doc d1. */
  async function seed(): Promise<string> {
    const id = `${runId}-${randomUUID()}`;
    await run(
      `CREATE (a:ItDelAuthor {id: $id, runId: $runId})
       CREATE (a)-[:IT_DEL_WROTE]->(:ItDelPost {id: $id + '-p1', runId: $runId, title: 'p1', visible: true})
       CREATE (a)-[:IT_DEL_WROTE]->(:ItDelPost {id: $id + '-p2', runId: $runId, title: 'p2', visible: true})
       CREATE (a)-[:IT_DEL_WROTE]->(:ItDelPost {id: $id + '-p3', runId: $runId, title: 'p3', visible: false})
       CREATE (a)-[:IT_DEL_HAS]->(:ItDelPost {id: $id + '-i1', runId: $runId, title: 'i1', visible: true})
       CREATE (a)-[:IT_DEL_HAS]->(:ItDelDoc {id: $id + '-d1', runId: $runId, title: 'd1'})`,
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
      'MATCH (n) WHERE (n:ItDelAuthor OR n:ItDelPost OR n:ItDelDoc) AND n.runId = $runId DETACH DELETE n',
    );
  });

  afterAll(async () => {
    if (driver) await driver.close();
  });

  const ALL = ['d1', 'i1', 'p1', 'p2', 'p3'];

  type Shape = [
    string,
    (ogm: OGM, id: string) => Promise<unknown>,
    string[], // default-mode result
  ];
  const trueShapes: Shape[] = [
    [
      'a nested update item `delete: true`',
      (ogm, id) =>
        ogm.model('ItDelAuthor').update({
          where: { id },
          update: { posts: [{ delete: garbage(true) }] },
        }),
      ['d1', 'i1'],
    ],
    [
      "`delete: true` next to the item's where (deletes every post, not p1)",
      (ogm, id) =>
        ogm.model('ItDelAuthor').update({
          where: { id },
          update: {
            posts: [
              { where: { node: { title: 'p1' } }, delete: garbage(true) },
            ],
          },
        }),
      ['d1', 'i1'],
    ],
    [
      'a union member `delete: true`',
      (ogm, id) =>
        ogm.model('ItDelAuthor').update({
          where: { id },
          update: { items: { ItDelPost: [{ delete: garbage(true) }] } },
        }),
      ['d1', 'p1', 'p2', 'p3'],
    ],
    [
      'a Model.delete cascade `{ posts: true }`',
      (ogm, id) =>
        ogm
          .model('ItDelAuthor')
          .delete({ where: { id }, delete: garbage({ posts: true }) }),
      ['d1', 'i1'],
    ],
  ];

  it.each(trueShapes)(
    'default: %s deletes as before, and warns once',
    async (_n, write, expected) => {
      const { ogm, warnings } = make(false);
      const id = await seed();
      await write(ogm, id);
      expect(await left()).toEqual(expected);
      await write(ogm, id);
      expect(warnings('is `true`: it deletes EVERY related node')).toHaveLength(
        1,
      );
    },
  );

  it.each(trueShapes)(
    'strict: %s throws an OGMError and deletes nothing',
    async (_n, write) => {
      const { ogm } = make(true);
      const id = await seed();
      await expect(write(ogm, id)).rejects.toThrow(OGMError);
      expect(await left()).toEqual(ALL);
    },
  );

  it('strict: a root `delete: { posts: true }` on update() throws and deletes nothing', async () => {
    const { ogm } = make(true);
    const id = await seed();
    await expect(
      ogm
        .model('ItDelAuthor')
        .update({ where: { id }, delete: garbage({ posts: true }) }),
    ).rejects.toThrow('A nested delete on "posts" is true.');
    expect(await left()).toEqual(ALL);
  });

  it.each([
    ['false', false],
    ['0', 0],
    ["''", ''],
  ] as const)(
    'default: a nested update `delete: %s` deletes nothing, and warns once',
    async (_n, v) => {
      const { ogm, warnings } = make(false);
      const id = await seed();
      for (let i = 0; i < 2; i++)
        await ogm.model('ItDelAuthor').update({
          where: { id },
          update: { posts: [{ delete: garbage(v) }] },
        });
      expect(await left()).toEqual(ALL);
      expect(warnings('it is ignored (nothing is deleted)')).toHaveLength(1);
    },
  );

  it.each([
    ['false', false],
    ['0', 0],
    ["''", ''],
  ] as const)(
    'strict: a nested update `delete: %s` throws and writes nothing',
    async (_n, v) => {
      const { ogm } = make(true);
      const id = await seed();
      await expect(
        ogm.model('ItDelAuthor').update({
          where: { id },
          update: {
            posts: [
              {
                where: { node: { title: 'p1' } },
                update: { node: { title: 'changed' } },
                delete: garbage(v),
              },
            ],
          },
        }),
      ).rejects.toThrow(OGMError);
      expect(await left()).toEqual(ALL);
    },
  );

  it('default with a delete policy: `delete: true` only deletes posts the policy allows', async () => {
    const { ogm } = make(false, {
      ItDelPost: [
        permissive({
          operations: ['read', 'delete'],
          when: () => ({ visible: true }),
          name: 'post.visible',
        }),
      ],
    });
    const id = await seed();
    await ogm
      .withContext({})
      .model('ItDelAuthor')
      .update({
        where: { id },
        update: { posts: [{ delete: garbage(true) }] },
      });
    expect(await left()).toEqual(['d1', 'i1', 'p3']);
  });

  it.each([false, true])(
    'strict=%s: `delete: [{}]` stays "delete every related node", without a warning',
    async (strict) => {
      const { ogm, warnings } = make(strict);
      const id = await seed();
      await ogm
        .model('ItDelAuthor')
        .update({ where: { id }, update: { posts: [{ delete: [{}] }] } });
      expect(await left()).toEqual(['d1', 'i1']);
      expect(warnings('nested delete')).toEqual([]);
    },
  );
});
