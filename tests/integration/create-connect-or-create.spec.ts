/**
 * Live suite — vNEXT, strict item 43: `connectOrCreate` in a create field
 * input (`create()`, and the relationship fields of every nested create),
 * as @neo4j/graphql 5.x accepts it.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
 *
 * Default mode keeps the 2.x behaviour: the key is ignored (and warns).
 * `strict: true` MERGEs the target on its unique key, sets `onCreate` only
 * on a node it creates, links it once, and runs after `create` / `connect`.
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
  type ItCcWrote @relationshipProperties {
    role: String
    since: Int @default(value: 1)
  }
  type ItCcUser @node {
    id: ID! @unique
    runId: String
    posts: [ItCcPost!]!
      @relationship(
        type: "IT_CC_WROTE"
        direction: OUT
        properties: "ItCcWrote"
      )
    media: [ItCcMedia!]! @relationship(type: "IT_CC_MEDIA", direction: OUT)
    best: ItCcPost @relationship(type: "IT_CC_BEST", direction: OUT)
  }
  type ItCcPost @node {
    id: ID! @id @unique
    slug: String @unique
    runId: String
    title: String
    ownerId: String
    views: Int @default(value: 0)
    tags: [ItCcTag!]! @relationship(type: "IT_CC_TAGGED", direction: OUT)
  }
  type ItCcTag @node {
    name: String! @unique
    runId: String
    label: String
  }
  union ItCcMedia = ItCcPost | ItCcTag
`;

type Row = Record<string, unknown>;
const extra = <T extends object>(o: T): T => o;

describeLive('create() connectOrCreate (strict item 43) — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let seq = 0;
  let driver: Driver;

  async function run(cypher: string, params: Row = {}): Promise<Row[]> {
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
              ItCcUser: [
                permissive({
                  operations: ['create', 'read'],
                  when: () => ({}),
                }),
              ],
              ItCcPost: [
                permissive({
                  operations: ['read'],
                  when: (c) => ({ ownerId: (c as { uid: string }).uid }),
                }),
                permissive({ operations: ['create'], when: () => ({}) }),
                restrictive({
                  operations: ['create'],
                  when: (c, input) =>
                    (input as { ownerId?: string }).ownerId ===
                    (c as { uid: string }).uid,
                }),
              ],
            },
          }
        : {}),
    });
    return { ogm, users: ogm.model('ItCcUser'), warnings };
  }

  const key = (s: string) => `${runId}-${s}-${++seq}`;

  async function postsOf(u: string): Promise<Row[]> {
    return run(
      `MATCH (:ItCcUser {id: $u})-[r:IT_CC_WROTE]->(p:ItCcPost)
       RETURN p.slug AS slug, p.title AS title, p.views AS views, p.id IS NOT NULL AS hasId,
              r.role AS role, r.since AS since
       ORDER BY slug`,
      { u },
    );
  }

  const countPosts = async (slug: string) =>
    (
      await run('MATCH (p:ItCcPost {slug: $slug}) RETURN count(p) AS c', {
        slug,
      })
    )[0].c as number;

  const coc = (slug: string, title = 'new', role?: string) => ({
    where: { node: { slug } },
    onCreate: {
      node: { title, runId },
      ...(role ? { edge: { role } } : {}),
    },
  });

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
    if (!driver) return;
    await run(
      'MATCH (n) WHERE (n:ItCcUser OR n:ItCcPost OR n:ItCcTag) AND n.runId = $runId DETACH DELETE n',
    );
    await driver.close();
  });

  it('default: connectOrCreate is ignored and warns once; the rest of the create runs', async () => {
    const { users, warnings } = makeOgm();
    const u = key('u');
    const slug = key('s');
    for (const id of [u, `${u}-2`])
      await users.create({
        input: [
          {
            id,
            runId,
            posts: extra({
              create: [{ node: { slug: `${id}-c`, title: 'c', runId } }],
              connectOrCreate: [coc(slug)],
            }) as never,
          },
        ],
      });
    expect(await countPosts(slug)).toBe(0);
    expect((await postsOf(u)).map((p) => p.title)).toEqual(['c']);
    const w = warnings.filter((m) => m.includes('"connectOrCreate"'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('is applied only with `strict: true`');
  });

  it('strict: creates the missing node once (@id, @default, edge default), then only links it', async () => {
    const { users, warnings } = makeOgm(true);
    const u1 = key('u');
    const u2 = key('u');
    const slug = key('s');
    const res = await users.create({
      input: [
        {
          id: u1,
          runId,
          posts: { connectOrCreate: [coc(slug, 'first', 'author')] },
        },
        {
          id: u2,
          runId,
          posts: { connectOrCreate: [coc(slug, 'second', 'editor')] },
        },
      ],
      selectionSet: '{ itCcUsers { id posts { slug title } } }',
    } as never);
    // One row per created node (invariant 2), both linked to the one post.
    const created = (res as unknown as { itCcUsers: Row[] }).itCcUsers;
    expect(created.map((r) => r.id)).toEqual([u1, u2]);
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
        title: 'first', // existing node: onCreate.node is not applied
        views: 0,
        hasId: true,
        role: 'editor', // new relationship: onCreate.edge is
        since: 1,
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it('strict: runs after create and connect, in a nested create, per union member and on a single relationship', async () => {
    const { users } = makeOgm(true);
    const u = key('u');
    const existing = key('s');
    const tag = key('t');
    const best = key('s');
    await run(
      'CREATE (:ItCcPost {id: $id, slug: $slug, runId: $runId, title: "old", views: 7})',
      { id: key('id'), slug: existing },
    );
    await users.create({
      input: [
        {
          id: u,
          runId,
          posts: {
            create: [
              {
                node: {
                  slug: key('s'),
                  title: 'created',
                  runId,
                  tags: {
                    connectOrCreate: [
                      {
                        where: { node: { name: tag } },
                        onCreate: { node: { label: 'L', runId } },
                      },
                    ],
                  },
                },
              },
            ],
            connectOrCreate: [coc(existing, 'ignored')],
          },
          media: {
            ItCcTag: {
              connectOrCreate: [
                {
                  where: { node: { name: tag } },
                  onCreate: { node: { label: 'other', runId } },
                },
              ],
            },
          },
          best: { connectOrCreate: coc(best, 'best') },
        },
      ],
    });
    const posts = await postsOf(u);
    expect(posts.map((p) => p.title).sort()).toEqual(['created', 'old']);
    expect(posts.find((p) => p.slug === existing)?.views).toBe(7);
    const tags = await run(
      `MATCH (t:ItCcTag {name: $tag}) RETURN t.label AS label,
         COUNT { (:ItCcPost)-[:IT_CC_TAGGED]->(t) } AS tagged,
         COUNT { (:ItCcUser {id: $u})-[:IT_CC_MEDIA]->(t) } AS media`,
      { tag, u },
    );
    // The nested create's connectOrCreate created the tag; the union
    // member's found it and only linked it.
    expect(tags).toEqual([{ label: 'L', tagged: 1, media: 1 }]);
    const b = await run(
      'MATCH (:ItCcUser {id: $u})-[:IT_CC_BEST]->(p:ItCcPost) RETURN p.slug AS slug, p.title AS title',
      { u },
    );
    expect(b).toEqual([{ slug: best, title: 'best' }]);
  });

  it('strict: after a same-input create of its key, connectOrCreate only links (one node, one relationship)', async () => {
    const { users } = makeOgm(true);
    const u = key('u');
    const slug = key('s');
    await users.create({
      input: [
        {
          id: u,
          runId,
          posts: {
            create: [{ node: { slug, title: 'from-create', runId } }],
            connectOrCreate: [coc(slug, 'from-coc', 'r')],
          },
        },
      ],
    });
    expect(await countPosts(slug)).toBe(1);
    const posts = await postsOf(u);
    expect(posts).toHaveLength(1);
    expect(posts[0].title).toBe('from-create');
  });

  it('strict: a connectOrCreate inside a nested create of update()', async () => {
    const { users } = makeOgm(true);
    const u = key('u');
    const tag = key('t');
    await run('CREATE (:ItCcUser {id: $u, runId: $runId})', { u });
    await users.update({
      where: { id: u },
      update: {
        posts: [
          {
            create: [
              {
                node: {
                  slug: key('s'),
                  title: 'p',
                  runId,
                  tags: {
                    connectOrCreate: [
                      {
                        where: { node: { name: tag } },
                        onCreate: { node: { runId } },
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
    });
    const rows = await run(
      'MATCH (:ItCcUser {id: $u})-[:IT_CC_WROTE]->(:ItCcPost)-[:IT_CC_TAGGED]->(t:ItCcTag) RETURN t.name AS name',
      { u },
    );
    expect(rows).toEqual([{ name: tag }]);
  });

  it('strict: an existing node the read policy hides is not linked; WITH CHECK guards the node it may create', async () => {
    const { ogm } = makeOgm(true, true);
    const users = ogm.withContext({ uid: 'me' }).model('ItCcUser');
    const hidden = key('s');
    const missing = key('s');
    await run(
      'CREATE (:ItCcPost {id: $id, slug: $slug, runId: $runId, title: "theirs", ownerId: "other"})',
      { id: key('id'), slug: hidden },
    );
    const u = key('u');
    const res = await users.create({
      input: [
        {
          id: u,
          runId,
          posts: {
            connectOrCreate: [
              {
                where: { node: { slug: hidden } },
                onCreate: { node: { ownerId: 'me', runId } },
              },
              {
                where: { node: { slug: missing } },
                onCreate: { node: { ownerId: 'me', runId, title: 'mine' } },
              },
            ],
          },
        },
      ],
    });
    expect(
      (res as unknown as { itCcUsers: Row[] }).itCcUsers.map((r) => r.id),
    ).toEqual([u]);
    expect((await postsOf(u)).map((p) => p.slug)).toEqual([missing]);
    expect(await countPosts(hidden)).toBe(1);

    const u2 = key('u');
    await expect(
      users.create({
        input: [
          {
            id: u2,
            runId,
            posts: {
              connectOrCreate: [
                {
                  where: { node: { slug: key('s') } },
                  onCreate: { node: { ownerId: 'other', runId } },
                },
              ],
            },
          },
        ],
      }),
    ).rejects.toThrow(PolicyDeniedError);
    expect(
      await run('MATCH (u:ItCcUser {id: $u2}) RETURN count(u) AS c', { u2 }),
    ).toEqual([{ c: 0 }]);
  });
});
