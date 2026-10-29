/**
 * Live suite (v2.25.0, strict item 45): a nested create that is not an object.
 *
 * `create: true` / `[5]` / `[[]]` / `[{ node: true }]` (in a nested update
 * item or a create() field input) creates a target node with no input
 * fields: only `@id` and `@default` values. A falsy `create` is skipped.
 * Default mode keeps both (one warning per OGM, field and shape); `strict:
 * true` throws an OGMError and writes nothing. A string or non-empty array
 * item crashed with `Invalid identifier "0" in create property`; it throws a
 * clear OGMError in both modes now.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node is created under an
 * author carrying this run's `runId` and removed in `afterEach`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItCnoAuthor @node {
    id: ID! @id
    runId: String
    posts: [ItCnoPost!]! @relationship(type: "IT_CNO_WROTE", direction: OUT)
  }
  type ItCnoPost @node {
    id: ID! @id
    title: String
    status: String @default(value: "draft")
  }
`;

const garbage = (v: unknown) => v as never;

describeLive('non-object nested creates (2.25.0) — live Neo4j', () => {
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

  const posts = async () =>
    run(
      `MATCH (a:ItCnoAuthor {runId: $runId})-[:IT_CNO_WROTE]->(p:ItCnoPost)
       RETURN p.id IS NOT NULL AS hasId, p.title AS title, p.status AS status`,
    );
  const authors = async () =>
    (await run('MATCH (a:ItCnoAuthor {runId: $runId}) RETURN count(a) AS c'))[0]
      .c as number;

  const make = (strict: boolean) => {
    const logger = { debug: jest.fn(), warn: jest.fn() };
    const ogm = new OGM({ typeDefs, driver, strict, logger });
    const warnings = (needle: string) =>
      logger.warn.mock.calls.filter((c) => String(c[0]).includes(needle));
    return { ogm, warnings };
  };

  const seed = async () => {
    const id = `${runId}-${randomUUID()}`;
    await run('CREATE (:ItCnoAuthor {id: $id, runId: $runId})', { id });
    return id;
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
      `MATCH (a:ItCnoAuthor {runId: $runId})
       OPTIONAL MATCH (a)-[:IT_CNO_WROTE]->(p:ItCnoPost)
       DETACH DELETE a, p`,
    );
  });

  afterAll(async () => {
    if (driver) await driver.close();
  });

  const emptyShapes: [string, unknown][] = [
    ['true', true],
    ['[5]', [5]],
    ['[[]]', [[]]],
    ['[{ node: true }]', [{ node: true }]],
  ];
  const EMPTY_POST = [{ hasId: true, title: null, status: 'draft' }];

  it.each(emptyShapes)(
    'default: a nested update item `create: %s` creates an empty post, and warns once',
    async (_n, create) => {
      const { ogm, warnings } = make(false);
      const id = await seed();
      await ogm.model('ItCnoAuthor').update({
        where: { id },
        update: { posts: [{ create: garbage(create) }] },
      });
      expect(await posts()).toEqual(EMPTY_POST);
      expect(
        warnings('not an object: it creates a "ItCnoPost" node'),
      ).toHaveLength(1);
    },
  );

  it.each(emptyShapes)(
    'default: a create() field input `create: %s` creates an empty post',
    async (_n, create) => {
      const { ogm, warnings } = make(false);
      await ogm.model('ItCnoAuthor').create({
        input: [{ runId, posts: { create: garbage(create) } }],
      });
      expect(await posts()).toEqual(EMPTY_POST);
      expect(warnings('not an object: it creates')).toHaveLength(1);
    },
  );

  it.each(emptyShapes)(
    'strict: `create: %s` throws an OGMError and writes nothing',
    async (_n, create) => {
      const { ogm } = make(true);
      const id = await seed();
      await expect(
        ogm.model('ItCnoAuthor').update({
          where: { id },
          update: { posts: [{ create: garbage(create) }] },
        }),
      ).rejects.toThrow(OGMError);
      await expect(
        ogm.model('ItCnoAuthor').create({
          input: [{ runId, posts: { create: garbage(create) } }],
        }),
      ).rejects.toThrow(OGMError);
      expect(await posts()).toEqual([]);
      expect(await authors()).toBe(1);
    },
  );

  it.each([
    ['false', false],
    ['0', 0],
    ["''", ''],
  ] as const)(
    'default: `create: %s` creates nothing, and warns once; strict throws',
    async (_n, v) => {
      const lenient = make(false);
      const id = await seed();
      for (let i = 0; i < 2; i++)
        await lenient.ogm.model('ItCnoAuthor').update({
          where: { id },
          update: { posts: [{ create: garbage(v) }] },
        });
      expect(await posts()).toEqual([]);
      expect(
        lenient.warnings('it is ignored (nothing is created)'),
      ).toHaveLength(1);
      await expect(
        make(true)
          .ogm.model('ItCnoAuthor')
          .update({
            where: { id },
            update: { posts: [{ create: garbage(v) }] },
          }),
      ).rejects.toThrow(OGMError);
    },
  );

  it.each([false, true])(
    'strict=%s: a string item throws a clear OGMError (was "Invalid identifier")',
    async (strict) => {
      const { ogm } = make(strict);
      const id = await seed();
      for (const create of ['x', ['x'], [{ node: 'x' }]])
        await expect(
          ogm.model('ItCnoAuthor').update({
            where: { id },
            update: { posts: [{ create: garbage(create) }] },
          }),
        ).rejects.toThrow('A nested create on "posts" is ');
      expect(await posts()).toEqual([]);
    },
  );
});
