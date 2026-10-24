/**
 * Live suite — v2.22.0 strict item 43: the @neo4j/graphql 5.x relationship
 * ops of `update()` / `updateMany()`: `connectOrCreate` in a nested update
 * item, and a root `create` / `connectOrCreate` / `delete`.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
 *
 * Default mode keeps the 2.x behaviour: the ops are ignored (and warn).
 * `strict: true` applies them in @neo4j/graphql's order (delete,
 * disconnect, update, connect, connectOrCreate, create).
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItRoWrote @relationshipProperties {
    role: String
    since: Int @default(value: 1)
  }
  type ItRoUser @node {
    id: ID! @unique
    runId: String
    name: String
    posts: [ItRoPost!]!
      @relationship(
        type: "IT_RO_WROTE"
        direction: OUT
        properties: "ItRoWrote"
      )
    media: [ItRoMedia!]! @relationship(type: "IT_RO_MEDIA", direction: OUT)
    best: ItRoPost @relationship(type: "IT_RO_BEST", direction: OUT)
  }
  type ItRoPost @node {
    id: ID! @id @unique
    slug: String @unique
    runId: String
    title: String
    ownerId: String
    views: Int @default(value: 0)
    tags: [ItRoTag!]! @relationship(type: "IT_RO_TAGGED", direction: OUT)
  }
  type ItRoTag @node {
    name: String! @unique
    runId: String
    label: String
  }
  union ItRoMedia = ItRoPost | ItRoTag
`;

type Row = Record<string, unknown>;
const extra = <T extends object>(o: T): T => o;

describeLive(
  'update() relationship ops of @neo4j/graphql 5.x — live Neo4j',
  () => {
    const runId = `it-${randomUUID()}`;
    let seq = 0;
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

    function makeOgm(strict?: boolean, policies = false) {
      const warnings: string[] = [];
      const ogm = new OGM({
        typeDefs,
        driver,
        logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
        ...(strict === undefined ? {} : { strict }),
        ...(policies
          ? {
              policies: {
                ItRoUser: [
                  permissive({
                    operations: ['update', 'read'],
                    when: () => ({}),
                  }),
                ],
                ItRoPost: [
                  permissive({
                    operations: ['read'],
                    when: (c) => ({ ownerId: (c as { uid: string }).uid }),
                  }),
                  permissive({ operations: ['create'], when: () => ({}) }),
                ],
              },
            }
          : {}),
      });
      return { ogm, users: ogm.model('ItRoUser'), warnings };
    }

    /** A fresh key, unique to this run. */
    const key = (s: string) => `${runId}-${s}-${++seq}`;

    async function seedUser(): Promise<string> {
      const u = key('u');
      await run('CREATE (:ItRoUser {id: $u, runId: $runId})', { u });
      return u;
    }

    /** `slug -> { title, views, role, since }` of the posts linked to `u`. */
    async function postsOf(u: string): Promise<Row[]> {
      return run(
        `MATCH (:ItRoUser {id: $u})-[r:IT_RO_WROTE]->(p:ItRoPost)
       RETURN p.slug AS slug, p.title AS title, p.views AS views, p.id IS NOT NULL AS hasId,
              r.role AS role, r.since AS since
       ORDER BY slug`,
        { u },
      );
    }

    async function countPosts(slug: string): Promise<number> {
      const rows = await run(
        'MATCH (p:ItRoPost {slug: $slug}) RETURN count(p) AS c',
        { slug },
      );
      return rows[0].c as number;
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
        `MATCH (n) WHERE (n:ItRoUser OR n:ItRoPost OR n:ItRoTag)
         AND (n.runId = $runId OR coalesce(n.slug, n.name, '') STARTS WITH $runId)
       DETACH DELETE n`,
      );
      await driver.close();
    });

    it('strict: a nested connectOrCreate creates the missing node once, then only links it', async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      const slug = key('p');
      const { users, warnings } = makeOgm(true);
      const coc = (title: string, role: string) => ({
        where: { node: { slug } },
        onCreate: { node: { title, runId }, edge: { role } },
      });
      await users.update({
        where: { id: u1 },
        update: { posts: [{ connectOrCreate: [coc('first', 'author')] }] },
      });
      expect(await postsOf(u1)).toEqual([
        {
          slug,
          title: 'first',
          views: 0,
          hasId: true,
          role: 'author',
          since: 1,
        },
      ]);
      // Again on the same user: neither the node nor the edge is rewritten.
      await users.update({
        where: { id: u1 },
        update: { posts: [{ connectOrCreate: [coc('second', 'editor')] }] },
      });
      // Another user: linked to the existing node, not a new one.
      await users.update({
        where: { id: u2 },
        update: { posts: [{ connectOrCreate: [coc('third', 'reader')] }] },
      });
      expect(await countPosts(slug)).toBe(1);
      expect(await postsOf(u1)).toEqual([
        {
          slug,
          title: 'first',
          views: 0,
          hasId: true,
          role: 'author',
          since: 1,
        },
      ]);
      expect(await postsOf(u2)).toEqual([
        {
          slug,
          title: 'first',
          views: 0,
          hasId: true,
          role: 'reader',
          since: 1,
        },
      ]);
      expect(warnings).toEqual([]);
    });

    it('strict: root create, connectOrCreate and delete', async () => {
      const u = await seedUser();
      const [a, b, c] = [key('a'), key('b'), key('c')];
      await run(
        `MATCH (u:ItRoUser {id: $u})
       CREATE (u)-[:IT_RO_WROTE]->(:ItRoPost {id: $a, slug: $a, runId: $runId, title: 'old'})`,
        { u, a },
      );
      const { users } = makeOgm(true);
      const res = await users.update({
        where: { id: u },
        delete: { posts: [{ where: { node: { slug: a } } }] },
        connectOrCreate: {
          posts: [
            { where: { node: { slug: b } }, onCreate: { node: { runId } } },
          ],
        },
        create: {
          posts: [
            { node: { slug: c, runId, title: 'new' }, edge: { role: 'r' } },
          ],
        },
        selectionSet: '{ id posts { slug } }',
      });
      expect(await countPosts(a)).toBe(0);
      expect((await postsOf(u)).map((p) => [p.slug, p.role, p.since])).toEqual(
        [
          [b, null, 1],
          [c, 'r', 1],
        ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
      const out = res as unknown as {
        itRoUsers: { posts: { slug: string }[] }[];
      };
      expect(out.itRoUsers).toHaveLength(1);
      expect(out.itRoUsers[0].posts.map((p) => p.slug).sort()).toEqual(
        [b, c].sort(),
      );
    });

    it('strict: root ops run in @neo4j/graphql order (delete before create, connect before create)', async () => {
      const u = await seedUser();
      const title = key('t');
      await run(
        `MATCH (u:ItRoUser {id: $u})
       CREATE (u)-[:IT_RO_WROTE]->(:ItRoPost {id: randomUUID(), runId: $runId, title: $title, slug: $s})`,
        { u, title, s: key('s') },
      );
      const fresh = key('fresh');
      const { users } = makeOgm(true);
      await users.update({
        where: { id: u },
        // delete runs first: the post created below survives it.
        delete: { posts: [{ where: { node: { title } } }] },
        // connect runs before create: it cannot see the post created below.
        connect: { posts: [{ where: { node: { slug: fresh } } }] },
        create: { posts: [{ node: { title, slug: fresh, runId } }] },
      });
      const rows = await run(
        `MATCH (:ItRoUser {id: $u})-[r:IT_RO_WROTE]->(p:ItRoPost) RETURN p.slug AS slug, count(r) AS links`,
        { u },
      );
      expect(rows).toEqual([{ slug: fresh, links: 1 }]);
    });

    it('strict: per union member, single relationship, and two levels down', async () => {
      const u = await seedUser();
      const [tag, best, inner, deep] = [
        key('tag'),
        key('best'),
        key('in'),
        key('deep'),
      ];
      await run(
        `MATCH (u:ItRoUser {id: $u})
       CREATE (u)-[:IT_RO_WROTE]->(:ItRoPost {id: randomUUID(), slug: $inner, runId: $runId})`,
        { u, inner },
      );
      const { users } = makeOgm(true);
      await users.update({
        where: { id: u },
        update: {
          media: {
            ItRoTag: [
              {
                connectOrCreate: [
                  {
                    where: { node: { name: tag } },
                    onCreate: { node: { name: tag, runId } },
                  },
                ],
              },
            ],
          },
          best: {
            connectOrCreate: {
              where: { node: { slug: best } },
              onCreate: { node: { runId, title: 'b' } },
            },
          },
          posts: [
            {
              where: { node: { slug: inner } },
              update: {
                node: {
                  tags: [
                    {
                      connectOrCreate: [
                        {
                          where: { node: { name: deep } },
                          onCreate: { node: { name: deep, runId } },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        },
      });
      const rows = await run(
        `MATCH (u:ItRoUser {id: $u})
       RETURN [(u)-[:IT_RO_MEDIA]->(t:ItRoTag) | t.name] AS tags,
              [(u)-[:IT_RO_BEST]->(p:ItRoPost) | p.title] AS best,
              [(u)-[:IT_RO_WROTE]->(:ItRoPost {slug: $inner})-[:IT_RO_TAGGED]->(t:ItRoTag) | t.name] AS deep`,
        { u, inner },
      );
      expect(rows).toEqual([{ tags: [tag], best: ['b'], deep: [deep] }]);
    });

    it('strict: updateMany keeps one row per node (count) and MERGEs the node once', async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      const slug = key('many');
      const { users } = makeOgm(true);
      const res = await users.updateMany({
        where: { id_IN: [u1, u2] },
        data: {
          posts: [
            {
              connectOrCreate: [
                { where: { node: { slug } }, onCreate: { node: { runId } } },
              ],
            },
          ],
        },
      });
      expect(res.count).toBe(2);
      expect(await countPosts(slug)).toBe(1);
      expect(await postsOf(u1)).toHaveLength(1);
      expect(await postsOf(u2)).toHaveLength(1);
    });

    it('strict: an existing node the read policy hides is not linked; a missing one is created', async () => {
      const u = await seedUser();
      const [hidden, mine] = [key('hidden'), key('mine')];
      await run(
        `CREATE (:ItRoPost {id: randomUUID(), slug: $hidden, runId: $runId, ownerId: 'other'})`,
        { hidden },
      );
      const { ogm } = makeOgm(true, true);
      const users = ogm.withContext({ uid: 'me' }).model('ItRoUser');
      await users.update({
        where: { id: u },
        connectOrCreate: {
          posts: [
            {
              where: { node: { slug: hidden } },
              onCreate: { node: { ownerId: 'me', runId } },
            },
            {
              where: { node: { slug: mine } },
              onCreate: { node: { ownerId: 'me', runId } },
            },
          ],
        },
      });
      expect((await postsOf(u)).map((p) => p.slug)).toEqual([mine]);
      expect(await countPosts(hidden)).toBe(1);
      const hiddenRow = await run(
        'MATCH (p:ItRoPost {slug: $hidden}) RETURN p.ownerId AS ownerId',
        { hidden },
      );
      expect(hiddenRow).toEqual([{ ownerId: 'other' }]);
    });

    it('default: every op is ignored and warns once', async () => {
      const u = await seedUser();
      const [a, b, c] = [key('a'), key('b'), key('c')];
      await run(
        `MATCH (u:ItRoUser {id: $u})
       CREATE (u)-[:IT_RO_WROTE]->(:ItRoPost {id: randomUUID(), slug: $a, runId: $runId})`,
        { u, a },
      );
      const { users, warnings } = makeOgm();
      await users.update(
        extra({
          where: { id: u },
          update: {
            posts: [
              {
                connectOrCreate: [
                  {
                    where: { node: { slug: b } },
                    onCreate: { node: { runId } },
                  },
                ],
              },
            ],
          },
          delete: { posts: [{ where: { node: { slug: a } } }] },
          create: { posts: [{ node: { slug: c, runId } }] },
        }),
      );
      expect((await postsOf(u)).map((p) => p.slug)).toEqual([a]);
      expect(await countPosts(b)).toBe(0);
      expect(await countPosts(c)).toBe(0);
      expect(warnings).toHaveLength(2);
      expect(
        warnings.every((w) => w.includes('only with `strict: true`')),
      ).toBe(true);
    });
  },
);
