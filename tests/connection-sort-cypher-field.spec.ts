/**
 * v2.25.0 — a connection sort key that is a `@cypher` field.
 *
 * A scalar field sorts by its statement (pre-v2.25.0: `n0.<field>`, a stored
 * property the field never has, so the sort was ignored). Strict item 47: a
 * node-typed or aggregating field keeps the pre-v2.25.0 Cypher by default and
 * warns once; strict throws. The live counterpart is
 * `tests/integration/cypher-field-sort.spec.ts`.
 */
import type { Driver } from 'neo4j-driver';
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';

const typeDefs = /* GraphQL */ `
  type User @node {
    id: ID! @unique
    name: String
    n: Int
    friends: [User!]! @relationship(type: "FRIEND", direction: OUT)
    posts: [Post!]! @relationship(type: "WROTE", direction: OUT)
    score: Int @cypher(statement: "RETURN this.n * 10 AS s", columnName: "s")
    postCount: Int
      @cypher(
        statement: "MATCH (this)-[:WROTE]->(p) RETURN count(p) AS c"
        columnName: "c"
      )
    topPost: Post
      @cypher(
        statement: "MATCH (this)-[:WROTE]->(p:Post) RETURN p LIMIT 1"
        columnName: "p"
      )
  }
  type Post @node {
    id: ID! @unique
    title: String
  }
`;

function setup(strict?: boolean) {
  const cyphers: string[] = [];
  const session = {
    run: jest.fn((cypher: string) => {
      cyphers.push(cypher);
      return Promise.resolve({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const driver = {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
  const logger = { debug: jest.fn(), warn: jest.fn() };
  const ogm = new OGM({
    typeDefs,
    driver,
    logger,
    ...(strict === undefined ? {} : { strict }),
  });
  const find = (field: string) =>
    ogm.model('User').find({
      where: { id: 'u' },
      selectionSet: `{ friendsConnection(sort: [{ node: { ${field}: DESC } }]) { edges { node { name } } } }`,
    });
  return { ogm, find, cyphers, warnings: () => logger.warn.mock.calls };
}

/** Captured from 041511b (v2.23.0). */
const V2_23_0 = (field: string) =>
  'MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN n { friendsConnection: ' +
  `{ edges: [x IN apoc.coll.sortMulti([(n)-[e0:\`FRIEND\`]->(n0:\`User\`) | { node: n0 { .\`name\` }, __sk0: n0.\`${field}\` }], ['__sk0']) | { node: x.node }] } }`;

describe('connection sort by a @cypher field (2.25.0)', () => {
  it.each([undefined, false, true])(
    'strict=%s: a scalar field sorts by its statement',
    async (strict) => {
      const { find, cyphers, warnings } = setup(strict);
      await find('score');
      expect(cyphers[0]).toContain(
        '| { node: n0 { .`name` }, __sk0: head(COLLECT { WITH n0 AS this\n  RETURN this.n * 10 AS s\n}) }',
      );
      expect(cyphers[0]).not.toContain('n0.`score`');
      expect(warnings()).toEqual([]);
    },
  );

  it('a stored sort key compiles as before', async () => {
    const { find, cyphers } = setup();
    await find('name');
    expect(cyphers[0]).toBe(V2_23_0('name'));
  });

  describe.each([
    ['topPost', 'it returns a node (type "Post"), which has no sort order'],
    [
      'postCount',
      'its statement aggregates, so it cannot be computed per edge (select and sort it at the top level instead)',
    ],
  ])('item 47 — %s', (field, problem) => {
    it('default: byte-identical to v2.23.0, warns once', async () => {
      const { find, cyphers, warnings } = setup();
      await find(field);
      await find(field);
      expect(cyphers).toEqual([V2_23_0(field), V2_23_0(field)]);
      expect(warnings()).toEqual([
        [
          `[OGM] The sort of connection "friendsConnection" by the @cypher field "User.${field}" is ignored: ${problem}. ` +
            'Enable `strict: true` (default in 3.0) to throw an OGMError for a connection sort key that cannot be sorted by.',
        ],
      ]);
    });

    it('strict: throws before running', async () => {
      const { find, cyphers } = setup(true);
      await expect(find(field)).rejects.toThrow(
        new OGMError(
          `Cannot sort connection "friendsConnection" by the @cypher field "User.${field}": ${problem}.`,
        ),
      );
      expect(cyphers).toEqual([]);
    });
  });
});
