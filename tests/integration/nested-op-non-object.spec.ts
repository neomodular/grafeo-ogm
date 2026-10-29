/**
 * Live suite (v2.25.0, strict item 46): nested write values that are not
 * objects and write nothing.
 *
 * A nested update item's `update: true` / `5` / falsy, a falsy `connect`,
 * and a relationship field value (or update item) that is not an object
 * (`posts: true`, `posts: ['p1']`) were skipped silently. Default mode keeps
 * that (one warning per OGM, field and shape); `strict: true` throws an
 * OGMError and writes nothing. A string or non-empty array `update` crashed
 * with `Invalid identifier "0" in nested update property` and throws a
 * clear OGMError in both modes.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterEach`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItNonAuthor @node {
    id: ID! @id
    runId: String
    name: String
    posts: [ItNonPost!]! @relationship(type: "IT_NON_WROTE", direction: OUT)
  }
  type ItNonPost @node {
    id: ID! @id
    runId: String
    title: String
  }
`;

const garbage = (v: unknown) => v as never;

describeLive(
  'non-object nested update / connect values (2.25.0) — live Neo4j',
  () => {
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

    /** `name` of the author and the titles of its posts. */
    const state = async (id: string) =>
      (
        await run(
          `MATCH (a:ItNonAuthor {id: $id})
         OPTIONAL MATCH (a)-[:IT_NON_WROTE]->(p)
         WITH a, p ORDER BY p.title
         RETURN a.name AS name, collect(p.title) AS titles`,
          { id },
        )
      )[0];

    /** Author `a0` with post p1; a free post `free`. */
    async function seed(): Promise<string> {
      const id = `${runId}-${randomUUID()}`;
      await run(
        `CREATE (a:ItNonAuthor {id: $id, runId: $runId, name: 'a0'})
       CREATE (a)-[:IT_NON_WROTE]->(:ItNonPost {id: $id + '-p1', runId: $runId, title: 'p1'})
       CREATE (:ItNonPost {id: $id + '-free', runId: $runId, title: 'free'})`,
        { id },
      );
      return id;
    }
    const BEFORE = { name: 'a0', titles: ['p1'] };

    const make = (strict: boolean) => {
      const logger = { debug: jest.fn(), warn: jest.fn() };
      const ogm = new OGM({ typeDefs, driver, strict, logger });
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
        'MATCH (n) WHERE (n:ItNonAuthor OR n:ItNonPost) AND n.runId = $runId DETACH DELETE n',
      );
    });

    afterAll(async () => {
      if (driver) await driver.close();
    });

    const shapes: [string, unknown][] = [
      ['an item `update: true`', [{ update: true }]],
      ['an item `update: 5`', [{ update: 5 }]],
      ['an item `update: false`', [{ update: false }]],
      ['an item `update: { node: true }`', [{ update: { node: true } }]],
      ['an item `connect: false`', [{ connect: false }]],
      ['an item `connect: 0`', [{ connect: 0 }]],
      ['a field value `true`', true],
      ["a string item `'p1'`", ['p1']],
    ];

    it.each(shapes)(
      'default: %s writes nothing beside the scalar update, and warns once',
      async (_n, posts) => {
        const { ogm, warnings } = make(false);
        const id = await seed();
        for (let i = 0; i < 2; i++)
          await ogm.model('ItNonAuthor').update({
            where: { id },
            update: { name: 'renamed', posts: garbage(posts) },
          });
        expect(await state(id)).toEqual({ name: 'renamed', titles: ['p1'] });
        expect(warnings('it is ignored (nothing is written)')).toHaveLength(1);
      },
    );

    it.each(shapes)(
      'strict: %s throws an OGMError and writes nothing',
      async (_n, posts) => {
        const { ogm } = make(true);
        const id = await seed();
        await expect(
          ogm.model('ItNonAuthor').update({
            where: { id },
            update: { name: 'renamed', posts: garbage(posts) },
          }),
        ).rejects.toThrow(OGMError);
        expect(await state(id)).toEqual(BEFORE);
      },
    );

    it.each([false, true])(
      'strict=%s: a create() field input `true` or `connect: false` (default: author only; strict: throws)',
      async (strict) => {
        const { ogm } = make(strict);
        for (const posts of [true, { connect: false }]) {
          const write = ogm.model('ItNonAuthor').create({
            input: [{ runId, name: 'new', posts: garbage(posts) }],
          });
          if (strict) await expect(write).rejects.toThrow(OGMError);
          else await write;
        }
        const created = await run(
          `MATCH (a:ItNonAuthor {runId: $runId, name: 'new'})
         OPTIONAL MATCH (a)-->(p) RETURN count(DISTINCT a) AS a, count(p) AS p`,
        );
        expect(created[0]).toEqual({ a: strict ? 0 : 2, p: 0 });
      },
    );

    it.each([false, true])(
      'strict=%s: a string / array `update` throws a clear OGMError (was "Invalid identifier")',
      async (strict) => {
        const { ogm } = make(strict);
        const id = await seed();
        for (const update of ['x', [{ title: 't' }], { node: 'x' }])
          await expect(
            ogm.model('ItNonAuthor').update({
              where: { id },
              update: { name: 'renamed', posts: [{ update: garbage(update) }] },
            }),
          ).rejects.toThrow('A nested update on "posts" is ');
        expect(await state(id)).toEqual(BEFORE);
      },
    );
  },
);
