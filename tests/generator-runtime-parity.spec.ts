/**
 * Generated-types ↔ runtime parity. Each case generates types for a small
 * schema and type-checks real user code against them, so the assertion is
 * "this compiles" / "this is rejected" rather than a text match on the
 * emitter output.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateTypes } from '../src/generator';
import { SchemaParseError } from '../src/generator/generate-types';
import { typecheckGenerated } from './helpers/generated-typecheck';

const PRELUDE = `
import type { OGM } from 'grafeo-ogm';
import type { ModelMap, InterfaceModelMap } from './generated';
import * as G from './generated';
declare const ogm: OGM<ModelMap, InterfaceModelMap>;
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;
`;

jest.setTimeout(60_000);

describe('generated SelectFields include scalar @cypher fields', () => {
  const typeDefs = `
    type Drug @node {
      id: ID! @id
      name: String!
      upperName: String
        @cypher(statement: "RETURN toUpper(this.name) AS upperName", columnName: "upperName")
      score: Int @cypher(statement: "RETURN 1 AS score", columnName: "score")
    }
  `;

  it('accepts select on @cypher scalars and types the result', async () => {
    const { errors } = await typecheckGenerated(
      typeDefs,
      `${PRELUDE}
async function run() {
  const rows = await ogm.model('Drug').find({
    select: { id: true, upperName: true, score: true },
  });
  const row = rows[0];
  type _a = Expect<Equal<typeof row.upperName, G.Maybe<string> | undefined>>;
  type _b = Expect<Equal<typeof row.score, G.Maybe<number> | undefined>>;
}
const fields: G.DrugSelectFields = { upperName: true };
`,
    );
    expect(errors).toEqual([]);
  });
});

describe('generated connection SelectFields offer totalCount', () => {
  // v2.4.8 — the runtime projects `totalCount` for a typed connection
  // select, but the generated select type had no key for it.
  const typeDefs = `
    type Kid @node { id: ID! @id }
    type Parent @node {
      id: ID! @id
      kids: [Kid!]! @relationship(type: "HAS_KID", direction: OUT)
    }
  `;

  it('accepts select: { totalCount: true } on a connection', async () => {
    const { errors } = await typecheckGenerated(
      typeDefs,
      `${PRELUDE}
async function run() {
  const rows = await ogm.model('Parent').find({
    select: { id: true, kidsConnection: { select: { totalCount: true } } },
  });
  const count: number | undefined = rows[0].kidsConnection?.totalCount;
}
`,
    );
    expect(errors).toEqual([]);
  });
});

describe('generated CreateInput makes @default-ed required fields optional', () => {
  const typeDefs = `
    enum Status { DRAFT LIVE }
    type Post @node {
      id: ID! @id
      title: String!
      status: Status! @default(value: DRAFT)
      views: Int! @default(value: 0)
    }
  `;

  it('accepts a create that omits defaulted fields, still requires the rest', async () => {
    const { errors } = await typecheckGenerated(
      typeDefs,
      `${PRELUDE}
async function run() {
  await ogm.model('Post').create({ input: [{ title: 'hello' }] });
  await ogm.model('Post').create({
    input: [{ title: 'hello', status: G.Status.Live, views: 3 }],
  });
}
// @ts-expect-error title has no default and stays required
const missingTitle: G.PostCreateInput = {};
`,
    );
    expect(errors).toEqual([]);
  });

  it('keeps defaulted edge properties required (edge writes apply no defaults)', async () => {
    const { generated, errors } = await typecheckGenerated(
      `
      type Post @node {
        id: ID! @id
        likes: [Post!]! @relationship(type: "LIKES", direction: OUT, properties: "Liked")
      }
      type Liked @relationshipProperties {
        weight: Int! @default(value: 1)
      }
    `,
      'export {};',
    );
    expect(errors).toEqual([]);
    const block = generated.match(
      /export type LikedCreateInput = \{[^}]*\}/,
    )?.[0];
    expect(block).toContain('weight: Scalars["Int"]["input"];');
  });
});

describe('generated ModelMap excludes interfaces', () => {
  const typeDefs = `
    interface Entity {
      id: ID!
    }
    type User implements Entity @node(labels: ["User", "Entity"]) {
      id: ID! @id
    }
  `;

  // Through v2.4.7 interfaces were also listed in ModelMap, so
  // ogm.model('Entity') resolved to the typed overload (autocomplete,
  // typed where) but always threw at runtime ("is an interface, not a
  // node type"). Note OGM.model() keeps an untyped `(name: string)`
  // overload, so the call itself still compiles — it just no longer
  // advertises a typed model.
  it('lists only node types in ModelMap, interfaces in InterfaceModelMap', async () => {
    const { errors } = await typecheckGenerated(
      typeDefs,
      `${PRELUDE}
ogm.model('User');
ogm.interfaceModel('Entity');
type _k = Expect<Equal<keyof ModelMap, 'User'>>;
type _i = Expect<Equal<keyof InterfaceModelMap, 'Entity'>>;
`,
    );
    expect(errors).toEqual([]);
  });
});

describe('generated type-name collisions', () => {
  async function generate(typeDefs: string): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-collide-'));
    try {
      await generateTypes({
        typeDefs,
        outFile: path.join(dir, 'out.ts'),
        config: { formatOutput: false },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Through v2.4.7 the generator wrote ~20 duplicate declarations (TS2300)
  // for this schema and the output did not compile. The naming scheme is
  // inherited from @neo4j/graphql and stays; the clash is reported instead.
  it('throws naming both sources when two fields map to the same type names', async () => {
    const typeDefs = `
      type User @node {
        id: ID! @id
        postComments: [Comment!]! @relationship(type: "WROTE", direction: OUT)
      }
      type UserPost @node {
        id: ID! @id
        comments: [Comment!]! @relationship(type: "HAS", direction: OUT)
      }
      type Comment @node {
        id: ID! @id
      }
    `;
    const run = generate(typeDefs);
    await expect(run).rejects.toThrow(SchemaParseError);
    await expect(generate(typeDefs)).rejects.toThrow(
      /UserPostCommentsConnectionWhere.*User\.postComments.*UserPost\.comments/s,
    );
  });

  it('throws when a node name collides with a generated helper type', async () => {
    await expect(
      generate(`
        type Book @node { id: ID! @id }
        type BookWhere @node { id: ID! @id }
      `),
    ).rejects.toThrow(/"BookWhere".*type BookWhere.*type Book\b/s);
  });

  // v2.5.3 — the generated file imports ModelInterface,
  // InterfaceModelInterface, ExecutionContext, DocumentNode and
  // SelectionSetNode. A node with one of those names produced a file that
  // did not compile (TS2440) while the collision detector, which only saw
  // `export` declarations, reported nothing. The imports are now aliased.
  it('compiles a schema whose node names match the imported identifiers', async () => {
    const { errors, generated } = await typecheckGenerated(
      `
      type DocumentNode @node { id: ID! @id }
      type ExecutionContext @node { id: ID! @id }
      type SelectionSetNode @node { id: ID! @id }
      type ModelInterface @node { id: ID! @id }
      type InterfaceModelInterface @node { id: ID! @id }
    `,
      `${PRELUDE}
async function run() {
  const rows = await ogm.model('ModelInterface').find({ where: { id: 'x' } });
  const id: string | undefined = rows[0]?.id;
  await ogm.model('DocumentNode').find({ select: { id: true } });
  return id;
}
`,
    );
    expect(errors).toEqual([]);
    expect(generated).toMatch(/export type ModelInterface = /);
  });

  it('accepts schemas without collisions', async () => {
    await expect(
      generate(
        fs.readFileSync(
          path.join(__dirname, '..', 'examples', 'schema.graphql'),
          'utf-8',
        ),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('generated <T>AggregateSelection matches Model.aggregate() output', () => {
  // Model.aggregate() returns { min, max } for every non-numeric field and
  // adds { average, sum } for Int / Float. Through v2.4.7 the generated
  // ID / String selections declared { shortest, longest }, which the
  // runtime never returns.
  it('types ID / String aggregates as { min, max }', async () => {
    const { errors } = await typecheckGenerated(
      `
      type Book @node {
        id: ID! @id
        title: String!
        pages: Int
        price: Float
        published: DateTime
      }
    `,
      `${PRELUDE}
const agg: G.BookAggregateSelection = {
  count: 2,
  id: { min: 'a', max: 'b' },
  title: { min: 'A', max: 'Z' },
  pages: { min: 1, max: 9, average: 5, sum: 10 },
  price: { min: 1.5, max: 2.5, average: 2, sum: 4 },
  published: { min: '2024-01-01T00:00:00Z', max: '2024-02-01T00:00:00Z' },
};
// @ts-expect-error the runtime never returns shortest
const s: G.StringAggregateSelection = { shortest: 'A' };
// @ts-expect-error the runtime never returns longest
const i: G.IdAggregateSelection = { longest: 'b' };
`,
    );
    expect(errors).toEqual([]);
  });
});

describe('generated <rel>Aggregate where keys stay out', () => {
  // Through v2.4.7 every relationship produced a `<rel>Aggregate` where
  // key, which the where compiler throws on. Aggregate FILTERS are still
  // unsupported (the aggregate SELECTION is supported since v2.7.0).
  it('rejects <rel>Aggregate in where', async () => {
    const { errors } = await typecheckGenerated(
      `
      type Author @node {
        id: ID! @id
        books: [Book!]! @relationship(type: "WROTE", direction: OUT)
      }
      type Book @node {
        id: ID! @id
      }
    `,
      `${PRELUDE}
async function run() {
  await ogm.model('Author').find({
    // @ts-expect-error unsupported at runtime (the where compiler throws)
    where: { booksAggregate: { count: 1 } },
  });
  await ogm.model('Author').find({ where: { books_SOME: { id: 'b' } } });
}
`,
    );
    expect(errors).toEqual([]);
  });
});

describe('generated <rel>Aggregate selection types match the runtime (v2.7.0)', () => {
  // 2.4.8–2.6.x left `<rel>Aggregate` out of the node types because the
  // runtime never populated it (issue #23). It now does, with upstream's
  // shape; the node / interface types and SelectFields offer it again.
  const typeDefs = `
    interface Content {
      id: ID!
      title: String
      comments: [Comment!]! @declareRelationship
    }
    type Wrote @relationshipProperties {
      weight: Int
      score: Float
      big: BigInt
      note: String
      at: DateTime
      dur: Duration
      flag: Boolean
      marks: [Int!]
    }
    union Item = Post | Note
    type User @node {
      id: ID! @id
      posts: [Post!]! @relationship(type: "WROTE", direction: OUT, properties: "Wrote")
      content: [Content!]! @relationship(type: "HAS", direction: OUT)
      items: [Item!]! @relationship(type: "ITEM", direction: OUT, properties: "Wrote")
    }
    type Post implements Content @node {
      id: ID! @id
      title: String
      views: Int
      rating: Float
      big: BigInt
      at: DateTime
      ldt: LocalDateTime
      lt: LocalTime
      t: Time
      dur: Duration
      d: Date
      flag: Boolean
      tags: [String!]
      comments: [Comment!]! @relationship(type: "ON", direction: IN)
    }
    type Note implements Content @node {
      id: ID! @id
      title: String
      comments: [Comment!]! @relationship(type: "ON", direction: IN)
    }
    type Comment @node {
      id: ID! @id
      likes: Int
    }
  `;

  it('types the selectionSet result, node and edge aggregates', async () => {
    const { errors } = await typecheckGenerated(
      typeDefs,
      `${PRELUDE}
async function run() {
  const [u] = await ogm.model('User').find({
    selectionSet: '{ postsAggregate { count node { views { sum } } edge { weight { max } } } }',
  });
  const count: number | undefined = u.postsAggregate?.count;
  const sum: G.Maybe<number> | undefined = u.postsAggregate?.node?.views.sum;
  const longest: G.Maybe<string> | undefined = u.postsAggregate?.node?.title.longest;
  const shortestId: G.Maybe<string> | undefined = u.postsAggregate?.node?.id.shortest;
  const big: G.Maybe<string> | undefined = u.postsAggregate?.node?.big.average;
  const at: unknown = u.postsAggregate?.node?.ldt.min;
  const dur: G.Maybe<string> | undefined = u.postsAggregate?.edge?.dur.max;
  const weight: G.Maybe<number> | undefined = u.postsAggregate?.edge?.weight.max;
  const items: number | undefined = u.itemsAggregate?.count;
  const contentTitle: G.Maybe<string> | undefined = u.contentAggregate?.node?.title.shortest;
  return [count, sum, longest, shortestId, big, at, dur, weight, items, contentTitle];
}
declare const agg: G.UserPostPostsAggregationSelection;
// @ts-expect-error Boolean fields have no aggregates
agg.node?.flag;
// @ts-expect-error Date fields have no aggregates
agg.node?.d;
// @ts-expect-error Int has no shortest
agg.node?.views.shortest;
declare const edge: G.UserPostPostsEdgeAggregateSelection;
// @ts-expect-error Boolean edge properties have no aggregates
edge.flag;
// The pre-2.4.8 field shape: optional, Maybe.
type _f = Expect<Equal<G.User['postsAggregate'], G.Maybe<G.UserPostPostsAggregationSelection> | undefined>>;
`,
    );
    expect(errors).toEqual([]);
  });

  it('accepts the typed select forms the runtime accepts', async () => {
    const { errors } = await typecheckGenerated(
      typeDefs,
      `${PRELUDE}
async function run() {
  const rows = await ogm.model('User').find({
    select: {
      id: true,
      postsAggregate: {
        where: { views_GT: 1 },
        directed: false,
        select: {
          count: true,
          node: { select: { views: { select: { sum: true, average: true } }, title: true } },
          edge: { select: { weight: { select: { max: true } } } },
        },
      },
      itemsAggregate: true,
      contentAggregate: { select: { node: true } },
    },
  });
  const c: number | undefined = rows[0].postsAggregate?.count;
  const s: G.Maybe<number> | undefined = rows[0].postsAggregate?.node?.views?.sum;
  return [c, s];
}
const bad1: G.UserSelectFields = {
  // @ts-expect-error a union target has no node aggregates
  itemsAggregate: { select: { node: true } },
};
const bad2: G.UserSelectFields = {
  // @ts-expect-error Int has no longest
  postsAggregate: { select: { node: { select: { views: { select: { longest: true } } } } } },
};
const bad3: G.UserSelectFields = {
  // @ts-expect-error Boolean fields have no aggregates
  postsAggregate: { select: { node: { select: { flag: true } } } },
};
`,
    );
    expect(errors).toEqual([]);
  });

  it('InterfaceModel results and interface SelectFields carry it too', async () => {
    const { errors } = await typecheckGenerated(
      typeDefs,
      `${PRELUDE}
async function run() {
  const rows = await ogm.interfaceModel('Content').find({
    selectionSet: '{ id commentsAggregate { count } }',
  });
  const c: number | undefined = rows[0].commentsAggregate?.count;
  return c;
}
const f: G.ContentSelectFields = { commentsAggregate: { select: { count: true } } };
`,
    );
    expect(errors).toEqual([]);
  });

  it('keeps the aggregation type names and every v2.6.3 member', async () => {
    // Additive: the names existing code imports are unchanged, every
    // member v2.6.3 declared is still there with a type assignable to its
    // v2.6.3 one (ID / String: supersets offering min / max too), and the
    // v2.6.3 list members keep their exact v2.6.3 type, deprecated.
    const { errors, generated } = await typecheckGenerated(
      typeDefs,
      `${PRELUDE}
declare const n: G.UserPostPostsNodeAggregateSelection;
declare const e: G.UserPostPostsEdgeAggregateSelection;
// v2.6.3 members of UserPostPostsNodeAggregateSelection, with v2.6.3 types.
const n1: G.IdAggregateSelection = n.id;
const n2: G.StringAggregateSelection = n.title;
const n3: G.IntAggregateSelection = n.views;
const n4: G.FloatAggregateSelection = n.rating;
const n5: G.DateTimeAggregateSelection = n.at;
type _nl = Expect<Equal<G.UserPostPostsNodeAggregateSelection['tags'], G.StringAggregateSelection>>;
// v2.6.3 members of UserPostPostsEdgeAggregateSelection.
const e1: G.IntAggregateSelection = e.weight;
const e2: G.FloatAggregateSelection = e.score;
const e3: G.StringAggregateSelection = e.note;
const e4: G.DateTimeAggregateSelection = e.at;
type _el = Expect<Equal<G.UserPostPostsEdgeAggregateSelection['marks'], G.IntAggregateSelection>>;
const mn: G.Maybe<string> | undefined = n.title.min;
type _i = G.UserPostsAggregateInput;
`,
    );
    expect(errors).toEqual([]);
    for (const member of [
      'tags: StringAggregateSelection;',
      'marks: IntAggregateSelection;',
    ])
      expect(generated).toContain(
        `  /** @deprecated List fields are not aggregated (never supported at runtime: selecting it throws). Removed in 3.0. */\n  ${member}`,
      );
  });
});

describe('generated where operators for list scalars', () => {
  // The runtime compares a list property as a whole: equality / _NOT take
  // the full list, _IN / _NOT_IN a list of lists. Through v2.4.7 the
  // generated operators were typed as the element type, so the forms that
  // work failed to compile and the ones that compiled never matched.
  it('types list operators as lists and drops element-only operators', async () => {
    const { generated, errors } = await typecheckGenerated(
      `
      type Post @node {
        id: ID! @id
        title: String
        tags: [String!]
        scores: [Int!]!
        seenAt: [DateTime!]
      }
    `,
      `${PRELUDE}
async function run() {
  const Post = ogm.model('Post');
  await Post.find({ where: { tags: ['a', 'b'], tags_NOT: ['c'] } });
  await Post.find({ where: { tags_IN: [['a'], ['b', 'c']], scores_NOT_IN: [[1]] } });
  await Post.find({ where: { scores: [1, 2] } });
  // @ts-expect-error a list property never equals a single element
  await Post.find({ where: { tags: 'a' } });
  // @ts-expect-error _IN takes a list of lists
  await Post.find({ where: { tags_IN: ['a'] } });
  // @ts-expect-error string operators never match a list property
  await Post.find({ where: { tags_CONTAINS: 'a' } });
  // @ts-expect-error comparison operators never match a list property
  await Post.find({ where: { scores_GT: 1 } });
  // Scalar (non-list) fields keep their full operator set.
  await Post.find({ where: { title_CONTAINS: 'x', title_IN: ['a'] } });
}
`,
    );
    expect(errors).toEqual([]);
    for (const op of ['STARTS_WITH', 'ENDS_WITH', 'MATCHES', 'LT', 'GTE'])
      expect(generated).not.toMatch(
        new RegExp(`\\b(tags|scores|seenAt)_${op}\\?`),
      );
  });
});
