/**
 * v2.22.0 — strict item 43 (compiler invariant 5): the generated types offer
 * the @neo4j/graphql 5.x update ops strict mode applies — `connectOrCreate`
 * in a nested update item (when the target has a @unique / @id field) and
 * a root `create` / `connectOrCreate` / `delete` on `update()` — and
 * reject the shapes strict mode rejects.
 */
import { typecheckGenerated } from './helpers/generated-typecheck';
import { rootOpsTypeDefs } from './strict-mode.update-root-ops.cases';

jest.setTimeout(60_000);

describe('item 43 — generated types for the update ops', () => {
  let generated = '';
  let errors: string[] = [];

  beforeAll(async () => {
    ({ generated, errors } = await typecheckGenerated(
      rootOpsTypeDefs,
      `
import type { OGM } from 'grafeo-ogm';
import type { ModelMap, InterfaceModelMap } from './generated';
declare const ogm: OGM<ModelMap, InterfaceModelMap>;
const users = ogm.model('User');

async function run() {
  await users.update({
    where: { id: 'u1' },
    update: {
      posts: [
        {
          connectOrCreate: [
            {
              where: { node: { slug: 's' } },
              onCreate: { node: { title: 't' }, edge: { role: 'r' } },
            },
          ],
        },
      ],
      best: {
        connectOrCreate: {
          where: { node: { id: 'p1' } },
          onCreate: { node: {} },
        },
      },
      media: {
        Tag: [
          {
            connectOrCreate: [
              { where: { node: { name: 'go' } }, onCreate: { node: { name: 'go' } } },
            ],
          },
        ],
      },
    },
    create: {
      posts: [{ node: { title: 't' }, edge: { role: 'r' } }],
      best: { node: { title: 'b' } },
      media: { Tag: [{ node: { name: 'x' } }] },
    },
    connectOrCreate: {
      posts: [{ where: { node: { slug: 's' } }, onCreate: { node: {} } }],
      media: {
        Post: [{ where: { node: { id: 'p' } }, onCreate: { node: {} } }],
      },
    },
    delete: { posts: [{ where: { node: { slug: 's' } } }] },
  });

  await users.update({
    where: { id: 'u1' },
    update: {
      posts: [
        {
          connectOrCreate: [
            // @ts-expect-error — "title" is not a @unique / @id field
            { where: { node: { title: 't' } }, onCreate: { node: {} } },
          ],
        },
      ],
    },
  });

  await users.update({
    where: { id: 'u1' },
    // @ts-expect-error — "name" is not a relationship field
    create: { name: 'x' },
  });

  await users.update({
    where: { id: 'u1' },
    // @ts-expect-error — no connectOrCreate on an interface target
    connectOrCreate: { animals: [{ where: { node: { name: 'rex' } }, onCreate: { node: {} } }] },
  });

  await users.update({
    where: { id: 'u1' },
    update: {
      posts: [
        {
          connectOrCreate: [
            // @ts-expect-error — onCreate.node takes no relationship
            { where: { node: { slug: 's' } }, onCreate: { node: { tags: {} } } },
          ],
        },
      ],
    },
  });
}
void run;
`,
    ));
  });

  it('the inputs strict mode applies compile; the invalid ones do not', () => {
    expect(errors).toEqual([]);
  });

  it('names the types as @neo4j/graphql 5.x does', () => {
    for (const name of [
      'PostUniqueWhere',
      'PostConnectOrCreateWhere',
      'PostOnCreateInput',
      'UserPostsConnectOrCreateFieldInput',
      'UserPostsConnectOrCreateFieldInputOnCreate',
      'UserMediaTagConnectOrCreateFieldInput',
    ])
      expect(generated).toContain(`export type ${name} =`);
    expect(generated).not.toContain('UserAnimalsConnectOrCreateFieldInput');
    expect(generated).not.toContain('DogConnectOrCreateWhere = never');
  });
});
