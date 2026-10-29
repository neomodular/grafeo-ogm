/**
 * Live suite (v2.24.1, security): a nested create item that is not an object.
 *
 * `create: true`, `create: [5]`, `create: [[]]` or `{ node: true }` writes
 * an empty node of the target type (`@id` and `@default` values only). The
 * application-layer policy walk skipped non-object items, so such a create
 * bypassed the target's `create` policies: default deny (no permissive
 * applies) and WITH CHECK restrictives. They are now checked as the empty
 * input they write, in both modes.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` (or is created under an author that does) and is removed in
 * `afterEach`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { PolicyDeniedError } from '../../src/policy/errors';
import { permissive, restrictive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItNcoAuthor @node {
    id: ID! @id
    runId: String
    posts: [ItNcoPost!]! @relationship(type: "IT_NCO_WROTE", direction: OUT)
  }
  type ItNcoPost @node {
    id: ID! @id
    title: String
    status: String @default(value: "draft")
  }
`;

type Ctx = { canCreatePost?: boolean };

const author = [
  permissive({ operations: ['read', 'update', 'create'], when: () => ({}) }),
];
const policies = {
  ItNcoAuthor: author,
  ItNcoPost: [
    permissive({ operations: ['read'], when: () => ({}) }),
    permissive({
      operations: ['create'],
      appliesWhen: (c) => Boolean((c as Ctx).canCreatePost),
      when: () => ({}),
    }),
    // WITH CHECK: a created post must have a title.
    restrictive({
      operations: ['create'],
      when: (_c, input) => typeof input.title === 'string',
    }),
  ],
};

const garbage = (v: unknown) => v as never;

describeLive(
  'non-object nested create items and create policies — live Neo4j',
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

    const postCount = async () =>
      (
        await run(
          'MATCH (:ItNcoAuthor {runId: $runId})-[:IT_NCO_WROTE]->(p:ItNcoPost) RETURN count(p) AS c',
        )
      )[0].c as number;

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
        `MATCH (a:ItNcoAuthor {runId: $runId})
       OPTIONAL MATCH (a)-[:IT_NCO_WROTE]->(p:ItNcoPost)
       DETACH DELETE a, p`,
      );
    });

    afterAll(async () => {
      if (driver) await driver.close();
    });

    const shapes: [string, unknown][] = [
      ['true', true],
      ['5', 5],
      ['[true]', [true]],
      ['[[]]', [[]]],
      ['[{ node: true }]', [{ node: true }]],
    ];
    const ctxs: [string, Ctx][] = [
      ['default deny (no create permissive applies)', {}],
      ['WITH CHECK (create allowed, title required)', { canCreatePost: true }],
    ];

    describe.each([false, true])('strict=%s', (strict) => {
      const ogm = () => new OGM({ typeDefs, driver, strict, policies });

      describe.each(ctxs)('%s', (_c, ctx) => {
        it.each(shapes)(
          'a nested update item `create: %s` is denied and writes nothing',
          async (_n, create) => {
            const id = `${runId}-${randomUUID()}`;
            await run('CREATE (:ItNcoAuthor {id: $id, runId: $runId})', { id });
            await expect(
              ogm()
                .withContext(ctx)
                .model('ItNcoAuthor')
                .update({
                  where: { id },
                  update: { posts: [{ create: garbage(create) }] },
                }),
            ).rejects.toBeInstanceOf(PolicyDeniedError);
            expect(await postCount()).toBe(0);
          },
        );

        it.each(shapes)(
          'a create() field input `create: %s` is denied and writes nothing',
          async (_n, create) => {
            await expect(
              ogm()
                .withContext(ctx)
                .model('ItNcoAuthor')
                .create({
                  input: [{ runId, posts: { create: garbage(create) } }],
                }),
            ).rejects.toBeInstanceOf(PolicyDeniedError);
            expect(
              (
                await run(
                  'MATCH (a:ItNcoAuthor {runId: $runId}) RETURN count(a) AS c',
                )
              )[0].c,
            ).toBe(0);
          },
        );
      });

      it('an allowed object create still writes the post', async () => {
        const id = `${runId}-${randomUUID()}`;
        await run('CREATE (:ItNcoAuthor {id: $id, runId: $runId})', { id });
        await ogm()
          .withContext({ canCreatePost: true })
          .model('ItNcoAuthor')
          .update({
            where: { id },
            update: { posts: [{ create: [{ node: { title: 't' } }] }] },
          });
        expect(await postCount()).toBe(1);
      });
    });
  },
);
