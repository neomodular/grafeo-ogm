/**
 * v2.10.0 — strict item 22 (compiler invariant 5): the keys strict mode
 * accepts in each nested write object are exactly the keys its generated
 * input type offers, so no typed input is rejected and every key the
 * runtime reads is typed.
 */
import { typecheckGenerated } from './helpers/generated-typecheck';
import { nestedKeyTypeDefs } from './strict-mode.nested-write-keys.cases';

jest.setTimeout(60_000);

/** Member names of `export type <name> = { … };` in the generated source. */
function members(generated: string, name: string): string[] {
  const m = new RegExp(`export type ${name} = \\{([^}]*)\\};`).exec(generated);
  if (!m) throw new Error(`type ${name} not generated`);
  return m[1]
    .split('\n')
    .map((l) => /^\s*(\w+)\??:/.exec(l)?.[1])
    .filter((k): k is string => Boolean(k))
    .sort();
}

const ITEM = ['connect', 'create', 'delete', 'disconnect', 'update', 'where'];
/**
 * v2.22.0 — strict item 43: strict mode also applies `connectOrCreate`,
 * offered when the target type has a @unique / @id field (not for an
 * interface target, where strict mode rejects it).
 */
const ITEM_COC = [...ITEM, 'connectOrCreate'].sort();
const FIELD_INPUT = ['connect', 'create'];
const WRAPPER = ['edge', 'node'];

describe('item 22 key sets match the generated input types', () => {
  let generated = '';
  let errors: string[] = [];

  beforeAll(async () => {
    ({ generated, errors } = await typecheckGenerated(
      nestedKeyTypeDefs,
      `
import type { UserCreateInput, UserUpdateInput } from './generated';
const upd: UserUpdateInput = {
  posts: [
    {
      where: { node: { id: 'p1' } },
      update: { node: { title: 'x' }, edge: { role: 'r' } },
      disconnect: [{ where: { node: { id: 'p2' } } }],
      delete: [{ where: { node: { id: 'p3' } } }],
    },
    {
      connect: [{ where: { node: { id: 'p4' } }, edge: { role: 'c' } }],
      create: [{ node: { title: 'n' }, edge: { role: 'n' } }],
    },
    // @ts-expect-error — "wher" is not a key of the update item
    { wher: { node: { id: 'p1' } } },
    // @ts-expect-error — node fields go inside "node" when "edge" is given
    { update: { edge: { role: 'r' }, title: 'x' } },
  ],
  media: {
    Post: [{ where: { node: { id: 'p1' } }, update: { node: { title: 'x' } } }],
    Tag: [{ create: [{ node: { name: 't' } }] }],
  },
};
const crt: UserCreateInput = {
  name: 'a',
  posts: {
    create: [{ node: { title: 't' }, edge: { role: 'r' } }],
    connect: [{ where: { node: { id: 'p1' } } }],
  },
  // @ts-expect-error — "creat" is not a key of the relationship field input
  media: { Post: { creat: [] } },
};
void upd;
void crt;
`,
    ));
  });

  it('the inputs strict mode accepts compile; the typos do not', () => {
    expect(errors).toEqual([]);
  });

  it.each([
    ['UserPostsUpdateFieldInput', ITEM_COC],
    ['UserMediaPostUpdateFieldInput', ITEM_COC],
    ['UserAnimalsUpdateFieldInput', ITEM],
    ['UserPostsFieldInput', FIELD_INPUT],
    ['UserMediaTagFieldInput', FIELD_INPUT],
    ['UserPostsCreateFieldInput', WRAPPER],
    ['UserMediaTagCreateFieldInput', ['node']],
    ['UserPostsUpdateConnectionInput', WRAPPER],
    ['UserMediaPostUpdateConnectionInput', ['node']],
  ])('%s offers %j', (name, keys) => {
    expect(members(generated, name)).toEqual(keys);
  });
});
