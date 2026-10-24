/**
 * vNEXT — strict item 45: node-level security on the @neo4j/graphql 5.x
 * update ops strict mode applies (nested / root `connectOrCreate`, root
 * `create` / `delete`).
 *
 * - An existing node a connectOrCreate MERGEs is linked only when the
 *   target's `read` policy admits it, like a connect.
 * - The node it may create is checked before compile as a nested create:
 *   the target's `create` permissives (default-deny) and write
 *   restrictives (WITH CHECK) on `{ ...onCreate.node, ...where.node }`.
 * - A root `create` is a nested create, a root `delete` a nested delete
 *   (target `delete` policy).
 * - Default mode ignores the ops, so their policies are never evaluated.
 * - Without a bound policy the Cypher is byte-identical to a policy-free OGM.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { PolicyDeniedError } from '../../src/policy/errors';
import { permissive, restrictive } from '../../src/policy/types';

const schema = `
type User @node {
  id: ID! @id @unique
  name: String
  books: [Book!]! @relationship(type: "OWNS", direction: OUT)
}
type Book @node {
  id: ID! @id @unique
  isbn: String @unique
  title: String
  ownerId: String
}
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function createMockDriver(records: Recorded[]): Driver {
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      records.push({ cypher, params });
      return Promise.resolve({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 0,
              nodesDeleted: 0,
              relationshipsCreated: 0,
              relationshipsDeleted: 0,
              propertiesSet: 0,
            }),
          },
        },
      });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
}

type Ctx = { uid: string };
const inputs: Record<string, unknown>[] = [];

function policyOgm(records: Recorded[], opts: { strict?: boolean } = {}): OGM {
  return new OGM({
    typeDefs: schema,
    driver: createMockDriver(records),
    strict: opts.strict ?? true,
    policies: {
      User: [permissive({ operations: ['update'], when: () => ({}) })],
      Book: [
        permissive({
          operations: ['read', 'delete'],
          when: (c) => ({ ownerId: (c as Ctx).uid }),
        }),
        permissive({ operations: ['create'], when: () => ({}) }),
        restrictive({
          operations: ['create'],
          when: (c, input) => {
            inputs.push(input as Record<string, unknown>);
            return (input as { ownerId?: string }).ownerId === (c as Ctx).uid;
          },
        }),
      ],
    },
  });
}

const coc = (ownerId: string) => ({
  where: { node: { isbn: 'i1' } },
  onCreate: { node: { title: 't', ownerId } },
});

beforeEach(() => {
  inputs.length = 0;
});

describe('connectOrCreate — target policies (strict)', () => {
  it('links an existing node only when the target read policy admits it', async () => {
    const records: Recorded[] = [];
    await policyOgm(records)
      .withContext({ uid: 'u1' })
      .model('User')
      .update({
        where: { id: 'me' },
        update: { books: [{ connectOrCreate: [coc('u1')] }] },
      });
    const { cypher, params } = records[0];
    expect(cypher).toContain(
      [
        'WITH n',
        'CALL {',
        'WITH n',
        'OPTIONAL MATCH (n_coc0_ex:`Book` { `isbn`: $update_books_0_coc0_where_isbn })',
        'WITH n, count(n_coc0_ex) > 0 AS n_coc0_matched',
        'MERGE (n_coc0:`Book` { `isbn`: $update_books_0_coc0_where_isbn })',
        'ON CREATE SET n_coc0 += { `id`: randomUUID(), `title`: $update_books_0_coc0_create_title, `ownerId`: $update_books_0_coc0_create_ownerId }',
        'WITH n, n_coc0, n_coc0_matched',
        'WHERE NOT n_coc0_matched OR ((n_coc0.`ownerId` = $param1))',
        'MERGE (n)-[:`OWNS`]->(n_coc0)',
        'RETURN count(*) AS _coc_books_0',
        '}',
      ].join('\n'),
    );
    expect(params.param1).toBe('u1');
  });

  it('evaluates the target create policies on the node it may create', async () => {
    const records: Recorded[] = [];
    await policyOgm(records)
      .withContext({ uid: 'u1' })
      .model('User')
      .update({
        where: { id: 'me' },
        connectOrCreate: { books: [coc('u1')] },
      });
    expect(records).toHaveLength(1);
    expect(inputs).toEqual([{ title: 't', ownerId: 'u1', isbn: 'i1' }]);
  });

  it('a WITH CHECK that rejects the onCreate input throws before running', async () => {
    const records: Recorded[] = [];
    await expect(
      policyOgm(records)
        .withContext({ uid: 'u1' })
        .model('User')
        .update({
          where: { id: 'me' },
          update: { books: [{ connectOrCreate: [coc('someone-else')] }] },
        }),
    ).rejects.toThrow(PolicyDeniedError);
    expect(records).toEqual([]);
  });

  it('the WITH CHECK also guards a root connectOrCreate and a root create', async () => {
    for (const params of [
      { connectOrCreate: { books: [coc('someone-else')] } },
      {
        create: { books: [{ node: { title: 't', ownerId: 'someone-else' } }] },
      },
    ]) {
      const records: Recorded[] = [];
      await expect(
        policyOgm(records)
          .withContext({ uid: 'u1' })
          .model('User')
          .update({ where: { id: 'me' }, ...params }),
      ).rejects.toThrow(PolicyDeniedError);
      expect(records).toEqual([]);
    }
  });

  it('a root delete is gated by the target delete policy', async () => {
    const records: Recorded[] = [];
    await policyOgm(records)
      .withContext({ uid: 'u1' })
      .model('User')
      .update({
        where: { id: 'me' },
        delete: { books: [{ where: { node: { isbn: 'i1' } } }] },
      });
    expect(records[0].cypher).toContain(
      'WHERE n_del0.`isbn` = $param1 AND (n_del0.`ownerId` = $param2)',
    );
    expect(records[0].params.param2).toBe('u1');
  });

  it('default mode ignores the ops: no policy is evaluated for them', async () => {
    const records: Recorded[] = [];
    await policyOgm(records, { strict: false })
      .withContext({ uid: 'u1' })
      .model('User')
      .update({
        where: { id: 'me' },
        update: { books: [{ connectOrCreate: [coc('someone-else')] }] },
        connectOrCreate: { books: [coc('someone-else')] },
        create: { books: [{ node: { title: 't' } }] },
      });
    expect(records).toHaveLength(1);
    expect(inputs).toEqual([]);
    expect(records[0].cypher).not.toContain('MERGE');
    expect(records[0].cypher).not.toContain('CREATE');
  });
});

describe('connectOrCreate — byte-identical without a bound policy', () => {
  const run = (ogm: { model: OGM['model'] }) =>
    ogm.model('User').update({
      where: { id: 'me' },
      update: { books: [{ connectOrCreate: [coc('u1')] }] },
      connectOrCreate: { books: [coc('u1')] },
      create: { books: [{ node: { title: 't' } }] },
      delete: { books: [{ where: { node: { isbn: 'i2' } } }] },
    });

  it('bare model(), bypassPolicies() and per-call unsafe match a policy-free OGM', async () => {
    const a: Recorded[] = [];
    await run(
      new OGM({ typeDefs: schema, driver: createMockDriver(a), strict: true }),
    );
    expect(a[0].cypher).not.toContain('OPTIONAL MATCH');

    const b: Recorded[] = [];
    await run(policyOgm(b));
    const c: Recorded[] = [];
    await run(policyOgm(c).unsafe.bypassPolicies());
    const d: Recorded[] = [];
    await policyOgm(d)
      .withContext({ uid: 'u1' })
      .model('User')
      .update({
        where: { id: 'me' },
        update: { books: [{ connectOrCreate: [coc('u1')] }] },
        connectOrCreate: { books: [coc('u1')] },
        create: { books: [{ node: { title: 't' } }] },
        delete: { books: [{ where: { node: { isbn: 'i2' } } }] },
        unsafe: { bypassPolicies: true },
      });
    for (const other of [b, c, d]) expect(other[0].cypher).toBe(a[0].cypher);
  });
});
