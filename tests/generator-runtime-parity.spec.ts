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
