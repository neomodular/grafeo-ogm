/**
 * Live relationship-property suite (v2.4.5).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Every node it
 * creates carries this run's `runId` and is removed in `afterAll`.
 *
 * A nested `create` inside `update` accepted `edge` (the generated
 * `CreateFieldInput` offers it, and `create()` honours it) but never read
 * it, so the relationship was created with no properties.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItEdgeWrote @relationshipProperties {
    role: String
    weight: Int
  }
  type ItEdgePost @node {
    id: ID! @unique
    runId: String
  }
  type ItEdgeAuthor @node {
    id: ID! @unique
    runId: String
    posts: [ItEdgePost!]!
      @relationship(
        type: "IT_EDGE_WROTE"
        direction: OUT
        properties: "ItEdgeWrote"
      )
  }
`;

type Row = Record<string, unknown>;

describeLive('Relationship properties — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;
  let driver: Driver;
  let ogm: OGM;

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

  /** The edge's properties plus the stored type of `weight`. */
  async function edge(authorId: string, postId: string): Promise<Row> {
    const [row] = await run(
      `MATCH (:ItEdgeAuthor {id: $authorId})-[r:IT_EDGE_WROTE]->(:ItEdgePost {id: $postId})
       RETURN properties(r) AS props, valueType(r.weight) AS weightType`,
      { authorId, postId },
    );
    return row;
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
    ogm = new OGM({ typeDefs, driver });
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await driver.close();
    }
  });

  it('nested create inside update stores edge properties', async () => {
    await run('CREATE (:ItEdgeAuthor {id: $a, runId: $runId})', {
      a: id('a1'),
    });
    await ogm.model('ItEdgeAuthor').update({
      where: { id: id('a1') },
      update: {
        posts: [
          {
            create: [
              {
                node: { id: id('p1'), runId },
                edge: { role: 'author', weight: 3 },
              },
            ],
          },
        ],
      },
    });
    const e = await edge(id('a1'), id('p1'));
    expect(e.props).toEqual({ role: 'author', weight: 3 });
    expect(e.weightType).toBe('INTEGER NOT NULL');
  });

  it('several nested creates each get their own edge properties', async () => {
    await run('CREATE (:ItEdgeAuthor {id: $a, runId: $runId})', {
      a: id('a2'),
    });
    await ogm.model('ItEdgeAuthor').update({
      where: { id: id('a2') },
      update: {
        posts: [
          {
            create: [
              {
                node: { id: id('p2a'), runId },
                edge: { role: 'lead', weight: 1 },
              },
              { node: { id: id('p2b'), runId }, edge: { role: 'editor' } },
            ],
          },
        ],
      },
    });
    expect((await edge(id('a2'), id('p2a'))).props).toEqual({
      role: 'lead',
      weight: 1,
    });
    expect((await edge(id('a2'), id('p2b'))).props).toEqual({ role: 'editor' });
  });

  it('create() stores the same edge properties (parity guard)', async () => {
    await ogm.model('ItEdgeAuthor').create({
      input: [
        {
          id: id('a3'),
          runId,
          posts: {
            create: [
              {
                node: { id: id('p3'), runId },
                edge: { role: 'author', weight: 3 },
              },
            ],
          },
        },
      ],
    });
    const e = await edge(id('a3'), id('p3'));
    expect(e.props).toEqual({ role: 'author', weight: 3 });
    expect(e.weightType).toBe('INTEGER NOT NULL');
  });
});
