/**
 * v2.27.0 — `compile(model)` takes the same, generated-typed params as the
 * real model methods (with `context` limited to `metadata`), compiled as
 * real user code against generated types.
 */
import { typecheckGenerated } from './helpers/generated-typecheck';

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  interface Named {
    name: String
  }
  type User implements Named @node {
    id: ID! @id
    name: String
    age: Int
    pets: [Pet!]! @relationship(type: "HAS", direction: OUT)
  }
  type Pet implements Named @node {
    id: ID! @id
    name: String
  }
`;

const usage = `
import { compile, createCompileOnlyOgm, normalizeCompiled } from 'grafeo-ogm';
import type { CompiledQuery } from 'grafeo-ogm';
import type { ModelMap, InterfaceModelMap } from './generated';

const ogm = createCompileOnlyOgm<ModelMap, InterfaceModelMap>({ typeDefs: '', strict: true });
const user = compile(ogm.model('User'));
const named = compile(ogm.interfaceModel('Named'));
const scoped = compile(ogm.withContext({ tenantId: 't' }).model('Pet'));

export async function ok(): Promise<CompiledQuery[]> {
  return [
    await user.find(),
    await user.find({ where: { name_CONTAINS: 'a', age_GT: 1 }, options: { limit: 1 } }),
    await user.find({ select: { id: true, pets: { select: { name: true } } } }),
    await user.find({ context: { metadata: { app: 'x' } } }),
    await user.update({
      where: { id: '1' },
      connect: { pets: [{ where: { node: { id: 'p' } } }] },
      disconnect: { pets: [{ where: { node: { id: 'q' } } }] },
    }),
    await user.delete({ where: { id: '1' }, delete: { pets: [{}] } }),
    await user.count(),
    await user.aggregate({ aggregate: { count: true } }),
    await named.find({ where: { name: 'a' } }),
    await scoped.findFirstOrThrow({ where: { id: 'p' } }),
    normalizeCompiled(await user.findUnique({ where: { id: '1' } })),
  ];
}

export async function bad(tx: import('neo4j-driver').Transaction): Promise<void> {
  // @ts-expect-error typo'd where field
  await user.find({ where: { nmae: 'a' } });
  // @ts-expect-error a transaction would run the statement
  await user.find({ context: { transaction: tx } });
  // @ts-expect-error update requires params
  await user.update();
  // @ts-expect-error unknown nested connect key
  await user.update({ where: { id: '1' }, connect: { toys: [] } });
  // @ts-expect-error interface models have no mutations
  await named.update({ where: {} });
  // @ts-expect-error not a compilable method
  user.selectionSet;
}
`;

describe('compile() keeps the generated param types', () => {
  it('type-checks real user code', async () => {
    const { errors } = await typecheckGenerated(typeDefs, usage);
    expect(errors).toEqual([]);
  });
});
