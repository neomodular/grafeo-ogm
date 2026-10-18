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

describe('generated types omit unsupported <rel>Aggregate fields', () => {
  // Through v2.4.7 every relationship produced a `<rel>Aggregate` field on
  // the node type and a `<rel>Aggregate` where key. The selection never
  // returns the field (always undefined) and the where compiler throws on
  // the key, so both are gone from the generated surface.
  it('rejects <rel>Aggregate in where and on the node type', async () => {
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
declare const author: G.Author;
// @ts-expect-error never populated by the runtime
author.booksAggregate;
`,
    );
    expect(errors).toEqual([]);
  });
});
