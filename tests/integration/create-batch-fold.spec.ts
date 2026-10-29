/**
 * Live suite for multi-input `create` with nested ops (vNEXT perf).
 *
 * Before an item with nested ops, the variables of the items created
 * before it are folded into one `__created` list, so every WITH / CALL
 * carries `__created, n_<i>` instead of all earlier variables (the
 * statement used to grow quadratically: ~0.5 s of Neo4j planning for a
 * 100-item create with connects). These tests pin the DATABASE OUTCOME of
 * that shape: one row per input in input order, connects that match zero
 * or many targets, nested creates, extra labels, policy-gated connects.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver, Integer } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItFoldTag @node {
    id: ID! @unique
    runId: String
    name: String
    secret: Boolean
  }
  type ItFoldNote @node {
    id: ID! @unique
    runId: String
  }
  type ItFoldPost @node {
    id: ID! @unique
    runId: String
    title: String
    tags: [ItFoldTag!]! @relationship(type: "IT_FOLD_TAGGED", direction: OUT)
    notes: [ItFoldNote!]! @relationship(type: "IT_FOLD_NOTE", direction: OUT)
  }
`;

type Row = Record<string, unknown>;

describeLive('Multi-input create with nested ops — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;
  let driver: Driver;
  let ogm: OGM;
  let policyOgm: OGM;

  async function run(cypher: string, params: Row = {}): Promise<Row[]> {
    const session = driver.session();
    try {
      const res = await session.run(cypher, { runId, ...params });
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
    );
    ogm = new OGM({ typeDefs, driver });
    policyOgm = new OGM({
      typeDefs,
      driver,
      policies: {
        ItFoldTag: [
          permissive({
            operations: ['read'],
            name: 'tag.public',
            when: () => ({ secret: false }),
          }),
        ],
        ItFoldPost: [
          permissive({
            operations: ['read', 'create'],
            name: 'post.all',
            when: () => ({}),
          }),
        ],
        ItFoldNote: [
          permissive({
            operations: ['read', 'create'],
            name: 'note.all',
            when: () => ({}),
          }),
        ],
      },
    });
    await run(
      `UNWIND range(0, 5) AS i
       CREATE (:ItFoldTag {id: $runId + '-t' + i, runId: $runId, name: 'multi', secret: i = 5})`,
    );
    await run(
      `CREATE (:ItFoldTag {id: $runId + '-solo', runId: $runId, name: 'solo', secret: false})`,
    );
  });

  afterAll(async () => {
    await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
    await driver.close();
  });

  const tagsOf = async (postId: string): Promise<string[]> =>
    (
      await run(
        `MATCH (:ItFoldPost {id: $postId})-[:IT_FOLD_TAGGED]->(t) RETURN t.id AS id ORDER BY id`,
        { postId },
      )
    ).map((r) => r.id as string);

  it('returns one row per input, in order, with every nested op applied', async () => {
    const solo = { connect: [{ where: { node: { id: id('solo') } } }] };
    const input = [
      { id: id('p0'), runId, title: 'p0', tags: solo },
      { id: id('p1'), runId, title: 'p1' },
      // zero matches: must not drop the row (nor the rows after it)
      {
        id: id('p2'),
        runId,
        title: 'p2',
        tags: { connect: [{ where: { node: { id: id('nope') } } }] },
      },
      // many matches (6 tags named 'multi'): must not multiply rows
      {
        id: id('p3'),
        runId,
        title: 'p3',
        tags: { connect: [{ where: { node: { name: 'multi' } } }] },
        notes: { create: [{ node: { id: id('n3a'), runId } }] },
      },
      { id: id('p4'), runId, title: 'p4' },
      {
        id: id('p5'),
        runId,
        title: 'p5',
        notes: {
          create: [
            { node: { id: id('n5a'), runId } },
            { node: { id: id('n5b'), runId } },
          ],
        },
        tags: solo,
      },
    ];
    const res = (await ogm.model('ItFoldPost').create({
      input,
      labels: ['ItFoldExtra'],
      selectionSet: '{ itFoldPosts { id tags { id } notes { id } } }',
    })) as unknown as { itFoldPosts: Row[] };

    expect(res.itFoldPosts.map((p) => p.id)).toEqual(input.map((i) => i.id));
    const tagIds = (p: Row) =>
      (p.tags as Row[]).map((t) => t.id as string).sort();
    expect(tagIds(res.itFoldPosts[0])).toEqual([id('solo')]);
    expect(tagIds(res.itFoldPosts[2])).toEqual([]);
    expect(tagIds(res.itFoldPosts[3])).toHaveLength(6);
    expect(tagIds(res.itFoldPosts[5])).toEqual([id('solo')]);
    expect((res.itFoldPosts[5].notes as Row[]).map((n) => n.id).sort()).toEqual(
      [id('n5a'), id('n5b')],
    );

    const [{ c }] = await run(
      'MATCH (p:ItFoldPost:ItFoldExtra) WHERE p.runId = $runId RETURN count(p) AS c',
    );
    expect((c as Integer).toNumber()).toBe(6);
    const [{ notes }] = await run(
      'MATCH (n:ItFoldNote) WHERE n.runId = $runId RETURN count(n) AS notes',
    );
    expect((notes as Integer).toNumber()).toBe(3);
    expect(await tagsOf(id('p3'))).toHaveLength(6);
  });

  it('applies the target read policy to connects of folded items', async () => {
    const res = (await policyOgm
      .withContext({})
      .model('ItFoldPost')
      .create({
        input: [
          { id: id('q0'), runId, title: 'q0' },
          {
            id: id('q1'),
            runId,
            title: 'q1',
            tags: { connect: [{ where: { node: { name: 'multi' } } }] },
          },
          {
            id: id('q2'),
            runId,
            title: 'q2',
            tags: { connect: [{ where: { node: { id: id('t5') } } }] },
          },
        ],
        selectionSet: '{ itFoldPosts { id } }',
      })) as unknown as { itFoldPosts: Row[] };

    expect(res.itFoldPosts.map((p) => p.id)).toEqual([
      id('q0'),
      id('q1'),
      id('q2'),
    ]);
    // t5 is secret: hidden from the read policy, so never connected
    expect(await tagsOf(id('q1'))).toHaveLength(5);
    expect(await tagsOf(id('q2'))).toEqual([]);
  });
});
