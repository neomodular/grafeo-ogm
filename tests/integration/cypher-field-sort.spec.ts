/**
 * Live suite (vNEXT): sorting by `@cypher` fields below the root.
 *
 * - A connection `sort` / typed `orderBy` on a scalar `@cypher` field
 *   compiled to `n0.<field>`, a stored property the field never has, so the
 *   sort was silently ignored. It sorts by the statement's value now, in
 *   both modes (the ignored sort was not a result anyone could rely on).
 * - Strict item 47: a connection sort on a node-typed or aggregating
 *   `@cypher` field stays ignored by default, with a warning; strict mode
 *   throws.
 *
 * Opt-in: runs only when NEO4J_APOC_URI is set (sorting below the root
 * compiles to `apoc.coll.sortMulti`). Every node carries this run's `runId`
 * and is removed in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';

const URI = process.env.NEO4J_APOC_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItCfsUser @node {
    id: ID! @unique
    runId: String
    name: String
    n: Int
    friends: [ItCfsUser!]! @relationship(type: "IT_CFS_FRIEND", direction: OUT)
    posts: [ItCfsPost!]! @relationship(type: "IT_CFS_WROTE", direction: OUT)
    score: Int @cypher(statement: "RETURN this.n * 10 AS s", columnName: "s")
    postCount: Int
      @cypher(
        statement: "MATCH (this)-[:IT_CFS_WROTE]->(p) RETURN count(p) AS c"
        columnName: "c"
      )
    topPost: ItCfsPost
      @cypher(
        statement: "MATCH (this)-[:IT_CFS_WROTE]->(p:ItCfsPost) RETURN p ORDER BY p.rank DESC LIMIT 1"
        columnName: "p"
      )
  }
  type ItCfsPost @node {
    id: ID! @unique
    runId: String
    title: String
    rank: Int
  }
`;

describeLive(
  'sorting by @cypher fields below the root (vNEXT) — live Neo4j with APOC',
  () => {
    let driver: Driver;
    const runId = `it-${randomUUID()}`;
    const uid = `${runId}-u`;

    async function run(cypher: string, params: Record<string, unknown> = {}) {
      const session = driver.session();
      try {
        const res = await session.run(cypher, { ...params, runId });
        return res.records.map((r) => r.toObject());
      } finally {
        await session.close();
      }
    }

    const make = (strict: boolean) => {
      const logger = { debug: jest.fn(), warn: jest.fn() };
      const ogm = new OGM({ typeDefs, driver, strict, logger });
      const warnings = (needle: string) =>
        logger.warn.mock.calls.filter((c) => String(c[0]).includes(needle));
      return { ogm, warnings };
    };

    /** u's friends: a (n 2, post rank 1), b (n 3, post rank 2), c (n 1, no post). */
    beforeAll(async () => {
      driver = neo4j.driver(
        URI!,
        neo4j.auth.basic(
          process.env.NEO4J_APOC_USER ?? 'neo4j',
          process.env.NEO4J_APOC_PASSWORD ?? 'password',
        ),
        { disableLosslessIntegers: true },
      );
      await driver.verifyConnectivity();
      await run(
        `CREATE (u:ItCfsUser {id: $uid, runId: $runId, name: 'u', n: 0})
       CREATE (u)-[:IT_CFS_FRIEND]->(a:ItCfsUser {id: $uid + 'a', runId: $runId, name: 'a', n: 2})
       CREATE (u)-[:IT_CFS_FRIEND]->(b:ItCfsUser {id: $uid + 'b', runId: $runId, name: 'b', n: 3})
       CREATE (u)-[:IT_CFS_FRIEND]->(:ItCfsUser {id: $uid + 'c', runId: $runId, name: 'c', n: 1})
       CREATE (a)-[:IT_CFS_WROTE]->(:ItCfsPost {id: $uid + 'pa', runId: $runId, title: 'pa', rank: 1})
       CREATE (b)-[:IT_CFS_WROTE]->(:ItCfsPost {id: $uid + 'pb', runId: $runId, title: 'pb', rank: 2})`,
        { uid },
      );
    });

    afterAll(async () => {
      if (driver) {
        await run(
          'MATCH (n) WHERE (n:ItCfsUser OR n:ItCfsPost) AND n.runId = $runId DETACH DELETE n',
        );
        await driver.close();
      }
    });

    type Edges = { edges: { node: { name: string; score?: number } }[] };
    const names = (rows: Record<string, unknown>[]) =>
      (rows[0].friendsConnection as Edges).edges.map((e) => e.node.name);

    describe.each([false, true])('strict=%s', (strict) => {
      it.each([
        ['DESC', ['b', 'a', 'c']],
        ['ASC', ['c', 'a', 'b']],
      ] as const)(
        'a selectionSet connection sort by a scalar @cypher field (%s)',
        async (dir, expected) => {
          const rows = await make(strict)
            .ogm.model('ItCfsUser')
            .find({
              where: { id: uid },
              selectionSet: `{ friendsConnection(sort: [{ node: { score: ${dir} } }]) { edges { node { name score } } } }`,
            });
          expect(names(rows)).toEqual(expected);
        },
      );

      it('a typed select orderBy on a scalar @cypher field, without selecting it', async () => {
        const rows = await make(strict)
          .ogm.model('ItCfsUser')
          .find({
            where: { id: uid },
            select: {
              friendsConnection: {
                orderBy: [{ node: { score: 'DESC' } }],
                select: { edges: { node: { select: { name: true } } } },
              },
            },
          });
        expect(names(rows as Record<string, unknown>[])).toEqual([
          'b',
          'a',
          'c',
        ]);
      });
    });

    it.each([
      [
        'topPost',
        'it returns a node (type "ItCfsPost"), which has no sort order',
      ],
      ['postCount', 'its statement aggregates'],
    ])(
      'item 47: a connection sort by %s is ignored and warns (default); strict throws',
      async (field, problem) => {
        const lenient = make(false);
        const query = {
          where: { id: uid },
          selectionSet: `{ friendsConnection(sort: [{ node: { ${field}: DESC } }]) { edges { node { name } } } }`,
        };
        const rows = await lenient.ogm.model('ItCfsUser').find(query);
        expect(names(rows).sort()).toEqual(['a', 'b', 'c']);
        expect(lenient.warnings(problem)).toHaveLength(1);
        await expect(
          make(true).ogm.model('ItCfsUser').find(query),
        ).rejects.toThrow(
          new OGMError(
            `Cannot sort connection "friendsConnection" by the @cypher field "ItCfsUser.${field}": ${
              field === 'topPost'
                ? problem
                : 'its statement aggregates, so it cannot be computed per edge (select and sort it at the top level instead)'
            }.`,
          ),
        );
      },
    );

    // Pre-vNEXT apoc.coll.sortMulti failed with a ClassCastException as soon
    // as a value was a node (a and b each have a top post).
    it.each([
      [
        'selectionSet',
        {
          selectionSet:
            '{ friends(options: { sort: [{ topPost: DESC }] }) { name } }',
        },
      ],
      [
        'typed select',
        {
          select: {
            friends: { orderBy: { topPost: 'DESC' }, select: { name: true } },
          },
        },
      ],
    ] as const)(
      'item 47: a nested relationship sort by a node-typed @cypher field (%s) sorts as null (default) / throws (strict)',
      async (_n, sel) => {
        const lenient = make(false);
        const query = { where: { id: uid }, ...sel } as never;
        const rows = (await lenient.ogm.model('ItCfsUser').find(query)) as {
          friends: { name: string }[];
        }[];
        expect(rows[0].friends.map((f) => f.name).sort()).toEqual([
          'a',
          'b',
          'c',
        ]);
        expect(
          lenient.warnings(
            'A relationship sort by the @cypher field "ItCfsUser.topPost" is ignored',
          ),
        ).toHaveLength(1);
        await expect(
          make(true).ogm.model('ItCfsUser').find(query),
        ).rejects.toThrow(
          new OGMError(
            'Cannot sort a relationship by the @cypher field "ItCfsUser.topPost": it returns a node (type "ItCfsPost"), which has no sort order.',
          ),
        );
      },
    );

    it('a nested relationship sort by a scalar @cypher field still sorts', async () => {
      const rows = (await make(false)
        .ogm.model('ItCfsUser')
        .find({
          where: { id: uid },
          selectionSet:
            '{ friends(options: { sort: [{ score: DESC }] }) { name } }',
        })) as { friends: { name: string }[] }[];
      expect(rows[0].friends.map((f) => f.name)).toEqual(['b', 'a', 'c']);
    });
  },
);
