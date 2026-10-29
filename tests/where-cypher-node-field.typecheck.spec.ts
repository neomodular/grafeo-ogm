/**
 * vNEXT — the generated where input of a node-typed `@cypher` field: the
 * target's where (singular field) or `_SOME` / `_NONE` / `_ALL` / `_SINGLE`
 * (list field), as @neo4j/graphql 5.x offers and the runtime applies
 * (compiler invariant 5).
 */
import { typecheckGenerated } from './helpers/generated-typecheck';

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  interface Media {
    title: String
  }
  type User @node {
    id: ID! @id
    topPost: Post
      @cypher(
        statement: "MATCH (this)-->(p:Post) RETURN p LIMIT 1"
        columnName: "p"
      )
    posts: [Post!]!
      @cypher(statement: "MATCH (this)-->(p:Post) RETURN p", columnName: "p")
    topMedia: Media
      @cypher(
        statement: "MATCH (this)-->(m:Post) RETURN m LIMIT 1"
        columnName: "m"
      )
    score: Int @cypher(statement: "RETURN 1 AS s", columnName: "s")
  }
  type Post implements Media @node {
    id: ID! @id
    title: String
    rank: Int
  }
`;

describe('generated where types for node-typed @cypher fields (vNEXT)', () => {
  let generated = '';
  let errors: string[] = [];

  beforeAll(async () => {
    ({ generated, errors } = await typecheckGenerated(
      typeDefs,
      `
import type { OGM } from 'grafeo-ogm';
import type { ModelMap, InterfaceModelMap } from './generated';
declare const ogm: OGM<ModelMap, InterfaceModelMap>;
const users = ogm.model('User');

async function run() {
  await users.find({
    where: {
      topPost: { title: 't', rank_GT: 1 },
      topMedia: { title_CONTAINS: 'x' },
      posts_SOME: { title: 't' },
      posts_NONE: { rank: 1 },
      posts_ALL: { rank_LT: 5 },
      posts_SINGLE: {},
      score_GT: 1,
    },
  });
  await users.find({ where: { topPost: null } });
  // @ts-expect-error — the target's where input, not a node field typo
  await users.find({ where: { topPost: { titel: 't' } } });
  // @ts-expect-error — a list field is filtered through its quantifiers
  await users.find({ where: { posts: { title: 't' } } });
  // @ts-expect-error — a singular field has no quantifiers
  await users.find({ where: { topPost_SOME: { title: 't' } } });
}
void run;
`,
    ));
  });

  it('the filters the runtime applies compile; the others do not', () => {
    expect(errors).toEqual([]);
  });

  it('names the target where types', () => {
    expect(generated).toContain('topPost?: InputMaybe<PostWhere>;');
    expect(generated).toContain('topMedia?: InputMaybe<MediaWhere>;');
    expect(generated).toContain('posts_SINGLE?: InputMaybe<PostWhere>;');
  });
});
