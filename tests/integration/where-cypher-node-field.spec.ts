/**
 * Live suite (2.25.0): filtering by a node-typed `@cypher` field with its
 * target's where input, as @neo4j/graphql 5.x does.
 *
 * `where: { topPost: { title: 'x' } }` compiled to `node = map`, which
 * never matches, so the filter always returned nothing; the list
 * quantifiers (`posts_SOME` …) compiled as a stored property. Both modes
 * now filter on the GUARDED value: a node the target's read policy hides
 * reads as null (absent from a list), so a filter can never reveal it.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
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
  interface ItWcnMedia {
    title: String
  }
  type ItWcnUser @node {
    id: ID! @unique
    runId: String
    name: String
    friends: [ItWcnUser!]! @relationship(type: "IT_WCN_FRIEND", direction: OUT)
    topPost: ItWcnPost
      @cypher(
        statement: "MATCH (this)-[:IT_WCN_WROTE]->(p:ItWcnPost) RETURN p ORDER BY p.rank DESC LIMIT 1"
        columnName: "p"
      )
    posts: [ItWcnPost!]!
      @cypher(
        statement: "MATCH (this)-[:IT_WCN_WROTE]->(p:ItWcnPost) RETURN p"
        columnName: "p"
      )
    topMedia: ItWcnMedia
      @cypher(
        statement: "MATCH (this)-[:IT_WCN_WROTE]->(p:ItWcnPost) RETURN p ORDER BY p.rank DESC LIMIT 1"
        columnName: "p"
      )
  }
  type ItWcnPost implements ItWcnMedia @node {
    id: ID! @unique
    runId: String
    title: String
    rank: Int
    visible: Boolean
    tags: [ItWcnTag!]! @relationship(type: "IT_WCN_TAG", direction: OUT)
  }
  type ItWcnTag @node {
    id: ID! @unique
    runId: String
    name: String
    secret: Boolean
  }
`;

const policies = {
  ItWcnPost: [
    permissive({ operations: ['read'], when: () => ({ visible: true }) }),
  ],
  ItWcnTag: [
    permissive({ operations: ['read'], when: () => ({ secret: false }) }),
  ],
};

describeLive('where on node-typed @cypher fields (2.25.0) — live Neo4j', () => {
  let driver: Driver;
  const runId = `it-${randomUUID()}`;
  const id = (k: string) => `${runId}-${k}`;

  async function run(cypher: string, params: Record<string, unknown> = {}) {
    const session = driver.session();
    try {
      const res = await session.run(cypher, { ...params, runId });
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  /**
   * a: pa1 (rank 1, visible), pa2 (rank 3, hidden) — top post pa2 (hidden)
   * b: pb (rank 2, visible, tagged with a secret tag) — top post pb
   * c: no posts; c's friend is a
   */
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
    await run(
      `CREATE (a:ItWcnUser {id: $a, runId: $runId, name: 'a'})
       CREATE (b:ItWcnUser {id: $b, runId: $runId, name: 'b'})
       CREATE (c:ItWcnUser {id: $c, runId: $runId, name: 'c'})
       CREATE (c)-[:IT_WCN_FRIEND]->(a)
       CREATE (a)-[:IT_WCN_WROTE]->(:ItWcnPost {id: $a + 'p1', runId: $runId, title: 'pa1', rank: 1, visible: true})
       CREATE (a)-[:IT_WCN_WROTE]->(:ItWcnPost {id: $a + 'p2', runId: $runId, title: 'pa2', rank: 3, visible: false})
       CREATE (b)-[:IT_WCN_WROTE]->(pb:ItWcnPost {id: $b + 'p', runId: $runId, title: 'pb', rank: 2, visible: true})
       CREATE (pb)-[:IT_WCN_TAG]->(:ItWcnTag {id: $b + 't', runId: $runId, name: 't', secret: true})`,
      { a: id('a'), b: id('b'), c: id('c') },
    );
  });

  afterAll(async () => {
    if (driver) {
      await run(
        'MATCH (n) WHERE (n:ItWcnUser OR n:ItWcnPost OR n:ItWcnTag) AND n.runId = $runId DETACH DELETE n',
      );
      await driver.close();
    }
  });

  const names = async (
    strict: boolean,
    withPolicies: boolean,
    where: Record<string, unknown>,
  ) => {
    const ogm = new OGM({
      typeDefs,
      driver,
      strict,
      ...(withPolicies ? { policies } : {}),
    });
    const model = (withPolicies ? ogm.withContext({}) : ogm).model('ItWcnUser');
    const rows = (await model.find({
      where: { AND: [{ runId }, where] },
      selectionSet: '{ name }',
    })) as { name: string }[];
    return rows.map((r) => r.name).sort();
  };

  // [filter, without policies, with policies]
  const cases: [string, Record<string, unknown>, string[], string[]][] = [
    [
      'topPost by title (hidden top post)',
      { topPost: { title: 'pa2' } },
      ['a'],
      [],
    ],
    ['topPost by title', { topPost: { title: 'pb' } }, ['b'], ['b']],
    [
      'topPost: {} (has a readable top post)',
      { topPost: {} },
      ['a', 'b'],
      ['b'],
    ],
    [
      'NOT topPost',
      { NOT: { topPost: { title: 'pb' } } },
      ['a', 'c'],
      ['a', 'c'],
    ],
    [
      "topPost through the target's relationship",
      { topPost: { tags_SOME: { name: 't' } } },
      ['b'],
      [],
    ],
    [
      'topMedia (interface target)',
      { topMedia: { title: 'pb' } },
      ['b'],
      ['b'],
    ],
    ['posts_SOME', { posts_SOME: { title: 'pa1' } }, ['a'], ['a']],
    [
      'posts_SOME on a hidden post',
      { posts_SOME: { title: 'pa2' } },
      ['a'],
      [],
    ],
    ['posts_ALL', { posts_ALL: { rank_LT: 3 } }, ['b', 'c'], ['a', 'b', 'c']],
    ['posts_NONE', { posts_NONE: { rank_GTE: 2 } }, ['c'], ['a', 'c']],
    ['posts_SINGLE', { posts_SINGLE: {} }, ['b'], ['a', 'b']],
    [
      'inside a relationship filter',
      { friends_SOME: { topPost: { title: 'pa2' } } },
      ['c'],
      [],
    ],
  ];

  describe.each([false, true])('strict=%s', (strict) => {
    it.each(cases)('%s', async (_n, where, plain, guarded) => {
      expect(await names(strict, false, where)).toEqual(plain);
      expect(await names(strict, true, where)).toEqual(guarded);
    });

    it('count() applies the same filter', async () => {
      const ogm = new OGM({ typeDefs, driver, strict });
      expect(
        await ogm
          .model('ItWcnUser')
          .count({ where: { runId, topPost: { title: 'pb' } } }),
      ).toBe(1);
    });

    it("a filter on the target's own @cypher field throws", async () => {
      const schema = typeDefs.replace(
        'visible: Boolean',
        'visible: Boolean\n    twice: Int @cypher(statement: "RETURN this.rank * 2 AS t", columnName: "t")',
      );
      await expect(
        new OGM({ typeDefs: schema, driver, strict })
          .model('ItWcnUser')
          .find({ where: { topPost: { twice: 4 } } }),
      ).rejects.toThrow(OGMError);
    });
  });
});
