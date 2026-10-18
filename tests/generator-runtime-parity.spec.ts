/**
 * Generated-types ↔ runtime parity. Each case generates types for a small
 * schema and type-checks real user code against them, so the assertion is
 * "this compiles" / "this is rejected" rather than a text match on the
 * emitter output.
 */
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
