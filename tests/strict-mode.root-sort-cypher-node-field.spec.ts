/**
 * vNEXT — strict item 47 (root sort): a root `options.sort` by a node-typed
 * `@cypher` field orders the rows by Neo4j's internal order of nodes, which
 * has no meaning. Default mode keeps the sort (Cypher byte-identical to
 * v2.25.0, captured on b324181) and warns once per OGM instance and field;
 * strict mode throws before anything runs. A scalar `@cypher` field sorts by
 * its value in both modes. Model and InterfaceModel.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OGM } from '../src/ogm';
import { OGMError } from '../src/errors';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';

const typeDefs = /* GraphQL */ `
  interface Person {
    id: ID!
    topPost: Post
      @cypher(
        statement: "MATCH (this)-[:WROTE]->(p:Post) RETURN p LIMIT 1"
        columnName: "p"
      )
  }
  type User implements Person @node {
    id: ID! @unique
    topPost: Post
      @cypher(
        statement: "MATCH (this)-[:WROTE]->(p:Post) RETURN p LIMIT 1"
        columnName: "p"
      )
    posts: [Post!]!
      @cypher(
        statement: "MATCH (this)-[:WROTE]->(p:Post) RETURN p"
        columnName: "p"
      )
    content: Content
      @cypher(
        statement: "MATCH (this)-[:WROTE]->(c) RETURN c LIMIT 1"
        columnName: "c"
      )
    postCount: Int
      @cypher(
        statement: "MATCH (this)-[:WROTE]->(p:Post) RETURN count(p) AS c"
        columnName: "c"
      )
  }
  union Content = Post | Doc
  type Post @node {
    id: ID! @unique
  }
  type Doc @node {
    id: ID! @unique
  }
`;

type Sort = Record<string, 'ASC' | 'DESC'>[];
type Call = (ogm: OGM, sort: Sort) => Promise<unknown>;

const calls: Array<[string, string, Call]> = [
  [
    'Model.find',
    'User',
    (ogm, sort) =>
      ogm.model('User').find({ selectionSet: '{ id }', options: { sort } }),
  ],
  [
    'Model.find (typed select, paged)',
    'User',
    (ogm, sort) =>
      ogm
        .model('User')
        .find({ select: { id: true }, options: { sort, limit: 2 } }),
  ],
  [
    'InterfaceModel.find',
    'Person',
    (ogm, sort) =>
      ogm
        .interfaceModel('Person')
        .find({ selectionSet: '{ id }', options: { sort } }),
  ],
];

/** Cypher of v2.25.0 (b324181) per call and sort field. */
const V2250: Record<string, string> = {
  'Model.find topPost':
    'MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (this)-[:WROTE]->(p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __sort_topPost\n}\nWITH n, __sort_topPost\nWITH *\nORDER BY __sort_topPost DESC, n.`id` ASC\nRETURN n { .`id` }',
  'Model.find posts':
    'MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (this)-[:WROTE]->(p:Post) RETURN p\n  }\n  RETURN head(collect(`p`)) AS __sort_posts\n}\nWITH n, __sort_posts\nWITH *\nORDER BY __sort_posts DESC, n.`id` ASC\nRETURN n { .`id` }',
  'Model.find content':
    'MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (this)-[:WROTE]->(c) RETURN c LIMIT 1\n  }\n  RETURN head(collect(`c`)) AS __sort_content\n}\nWITH n, __sort_content\nWITH *\nORDER BY __sort_content DESC, n.`id` ASC\nRETURN n { .`id` }',
  'Model.find (typed select, paged) topPost':
    'MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (this)-[:WROTE]->(p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __sort_topPost\n}\nWITH n, __sort_topPost\nWITH *\nORDER BY __sort_topPost DESC, n.`id` ASC\nLIMIT $options_limit\nRETURN n { .`id` }',
  'Model.find (typed select, paged) posts':
    'MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (this)-[:WROTE]->(p:Post) RETURN p\n  }\n  RETURN head(collect(`p`)) AS __sort_posts\n}\nWITH n, __sort_posts\nWITH *\nORDER BY __sort_posts DESC, n.`id` ASC\nLIMIT $options_limit\nRETURN n { .`id` }',
  'Model.find (typed select, paged) content':
    'MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (this)-[:WROTE]->(c) RETURN c LIMIT 1\n  }\n  RETURN head(collect(`c`)) AS __sort_content\n}\nWITH n, __sort_content\nWITH *\nORDER BY __sort_content DESC, n.`id` ASC\nLIMIT $options_limit\nRETURN n { .`id` }',
  'InterfaceModel.find topPost':
    "MATCH (n:`User`)\nWITH n, CASE WHEN n:`User` THEN 'User' END AS __typename\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (this)-[:WROTE]->(p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __sort_topPost\n}\nWITH n, __typename, __sort_topPost\nWITH *\nORDER BY __sort_topPost DESC, n.`id` ASC\nRETURN n { __typename: head([__label IN labels(n) WHERE __label IN ['User']]), .`id` , __typename: __typename }",
  'Model.find postCount':
    'MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (this)-[:WROTE]->(p:Post) RETURN count(p) AS c\n  }\n  RETURN head(collect(`c`)) AS __sort_postCount\n}\nWITH n, __sort_postCount\nWITH *\nORDER BY __sort_postCount DESC\nRETURN n { .`id` }',
};

function make(strict: boolean | undefined, warn = jest.fn()) {
  const records: Recorded[] = [];
  const ogm = new OGM({
    typeDefs,
    driver: recordingDriver(records),
    ...(strict === undefined ? {} : { strict }),
    logger: { debug: () => undefined, warn },
  });
  return { ogm, records, warn };
}

describe('strict item 47 — root sort by a node-typed @cypher field', () => {
  describe.each(calls)('%s', (label, typeName, call) => {
    const nodeFields =
      typeName === 'Person' ? ['topPost'] : ['topPost', 'posts', 'content'];

    it.each(nodeFields)(
      'default mode: %s — byte-identical Cypher, warns once',
      async (field) => {
        for (const strict of [undefined, false]) {
          const { ogm, records, warn } = make(strict);
          const sort: Sort = [{ [field]: 'DESC' }, { id: 'ASC' }];
          await call(ogm, sort);
          await call(ogm, sort);
          expect(records).toHaveLength(2);
          expect(records[0].cypher).toBe(records[1].cypher);
          expect(records[0].cypher).toBe(V2250[`${label} ${field}`]);
          const warned = warn.mock.calls.filter((c) =>
            String(c[0]).includes('has no meaning'),
          );
          expect(warned).toHaveLength(1);
          expect(String(warned[0][0])).toContain(
            `A sort by the @cypher field "${typeName}.${field}" has no meaning`,
          );
        }
      },
    );

    it.each(nodeFields)('strict mode: %s throws OGMError', async (field) => {
      const { ogm, records } = make(true);
      await expect(
        call(ogm, [{ id: 'ASC' }, { [field]: 'ASC' }]),
      ).rejects.toThrow(OGMError);
      await expect(call(ogm, [{ [field]: 'ASC' }])).rejects.toThrow(
        `Cannot sort by the @cypher field "${typeName}.${field}": it returns`,
      );
      expect(records).toHaveLength(0);
    });
  });

  it('a scalar @cypher sort key is unaffected in both modes', async () => {
    for (const strict of [undefined, true]) {
      const { ogm, records, warn } = make(strict);
      await ogm.model('User').find({
        selectionSet: '{ id }',
        options: { sort: [{ postCount: 'DESC' }] },
      });
      expect(records[0].cypher).toBe(V2250['Model.find postCount']);
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('README documents the warning code', () => {
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain('`root-sort-cypher-node-field`');
  });
});
