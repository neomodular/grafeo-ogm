/**
 * v2.6.2 — the abstract-target write shapes the runtime now accepts are
 * exactly what the generated types offer (compiler invariant 5): the inputs
 * of the live specs compile against the generated types.
 */
import { typeDefs } from './integration/properties/schema';
import { typecheckGenerated } from './helpers/generated-typecheck';

jest.setTimeout(60_000);

const usage = (body: string) => `
import type { ItPTagDeleteInput, ItPTagUpdateInput } from './generated';
${body}
`;

describe('abstract-target write shapes typecheck against the generated types', () => {
  it('F4: union cascade delete keyed per member', async () => {
    const { errors } = await typecheckGenerated(
      typeDefs,
      usage(`
const del: ItPTagDeleteInput = {
  items: {
    ItPChart: [{ where: { node: { id: 'c1' } } }],
    ItPDoc: [{ where: { node: { name: 'b' } } }],
  },
};
void del;
`),
    );
    expect(errors).toEqual([]);
  });

  it('F3: interface nested update with node keyed per member', async () => {
    const { errors } = await typecheckGenerated(
      typeDefs,
      usage(`
const upd: ItPTagUpdateInput = {
  resources: [
    {
      update: {
        node: {
          ItPChart: {
            name: 'chart',
            categories: [{ disconnect: [{ where: { node: { id: 'k2' } } }] }],
          },
        },
      },
    },
    { where: { node: { name: 'a' } }, update: { node: { ItPDrug: { rank: 9 } } } },
  ],
};
void upd;
`),
    );
    expect(errors).toEqual([]);
  });
});
