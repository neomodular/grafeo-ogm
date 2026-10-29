/**
 * v2.23.0 — strict item 43: node-level security on `connectOrCreate` in a
 * create field input (`create()` and every nested create), as for the
 * update item's (v2.22.0):
 *
 * - An existing node the MERGE finds is linked only when the target's
 *   `read` policy admits it, like a connect.
 * - The node it may create is checked before compile as a nested create:
 *   the target's `create` permissives (default-deny) and write
 *   restrictives (WITH CHECK) on `{ ...onCreate.node, ...where.node }`.
 * - Default mode ignores the key, so its policies are never evaluated.
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
  friends: [User!]! @relationship(type: "FRIEND", direction: OUT)
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
      User: [permissive({ operations: ['create'], when: () => ({}) })],
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

const create = (ownerId: string) => ({
  input: [{ name: 'me', books: { connectOrCreate: [coc(ownerId)] } }],
});

describe('create() connectOrCreate — target policies (strict)', () => {
  it('links an existing node only when the target read policy admits it', async () => {
    const records: Recorded[] = [];
    await policyOgm(records)
      .withContext({ uid: 'u1' })
      .model('User')
      .create(create('u1'));
    const { cypher, params } = records[0];
    expect(cypher).toContain(
      [
        'WITH n',
        'CALL {',
        'WITH n',
        'OPTIONAL MATCH (n_coc0_ex:`Book` { `isbn`: $create0_books_coc0_where_isbn })',
        'WITH n, count(n_coc0_ex) > 0 AS n_coc0_matched',
        'MERGE (n_coc0:`Book` { `isbn`: $create0_books_coc0_where_isbn })',
        'ON CREATE SET n_coc0 += { `id`: randomUUID(), `title`: $create0_books_coc0_create_title, `ownerId`: $create0_books_coc0_create_ownerId }',
        'WITH n, n_coc0, n_coc0_matched',
        'WHERE NOT n_coc0_matched OR ((n_coc0.`ownerId` = $param0))',
        'MERGE (n)-[:`OWNS`]->(n_coc0)',
        'RETURN count(*) AS _ccoc_create0_books_0',
        '}',
      ].join('\n'),
    );
    expect(params.param0).toBe('u1');
    expect(inputs).toEqual([{ title: 't', ownerId: 'u1', isbn: 'i1' }]);
  });

  it('a WITH CHECK that rejects the onCreate input throws before running', async () => {
    const records: Recorded[] = [];
    await expect(
      policyOgm(records)
        .withContext({ uid: 'u1' })
        .model('User')
        .create(create('someone-else')),
    ).rejects.toThrow(PolicyDeniedError);
    expect(records).toEqual([]);
  });

  it('the WITH CHECK also guards a connectOrCreate in a nested create', async () => {
    const records: Recorded[] = [];
    await expect(
      policyOgm(records)
        .withContext({ uid: 'u1' })
        .model('User')
        .create({
          input: [
            {
              name: 'me',
              friends: {
                create: [
                  {
                    node: {
                      name: 'f',
                      books: { connectOrCreate: [coc('someone-else')] },
                    },
                  },
                ],
              },
            },
          ],
        }),
    ).rejects.toThrow(PolicyDeniedError);
    expect(records).toEqual([]);
  });

  it('and in a nested create of an update item', async () => {
    const records: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(records),
      strict: true,
      policies: {
        User: [
          permissive({ operations: ['update', 'create'], when: () => ({}) }),
        ],
        Book: [
          permissive({ operations: ['read', 'create'], when: () => ({}) }),
          restrictive({
            operations: ['create'],
            when: (c, input) =>
              (input as { ownerId?: string }).ownerId === (c as Ctx).uid,
          }),
        ],
      },
    });
    await expect(
      ogm
        .withContext({ uid: 'u1' })
        .model('User')
        .update({
          where: { id: 'me' },
          update: {
            friends: [
              {
                create: [
                  {
                    node: {
                      name: 'f',
                      books: { connectOrCreate: [coc('someone-else')] },
                    },
                  },
                ],
              },
            ],
          },
        }),
    ).rejects.toThrow(PolicyDeniedError);
    expect(records).toEqual([]);
  });

  it('default mode ignores the key: no policy is evaluated for it', async () => {
    const records: Recorded[] = [];
    await policyOgm(records, { strict: false })
      .withContext({ uid: 'u1' })
      .model('User')
      .create(create('someone-else'));
    expect(records).toHaveLength(1);
    expect(inputs).toEqual([]);
    expect(records[0].cypher).not.toContain('MERGE');
  });
});

describe('create() connectOrCreate — byte-identical without a bound policy', () => {
  it('bypassPolicies() and per-call unsafe match a policy-free OGM; bare model() throws (strict item 50)', async () => {
    const a: Recorded[] = [];
    await new OGM({
      typeDefs: schema,
      driver: createMockDriver(a),
      strict: true,
    })
      .model('User')
      .create(create('u1'));
    expect(a[0].cypher).toContain('MERGE');
    expect(a[0].cypher).not.toContain('OPTIONAL MATCH');

    // v2.24.0 — strict item 50: a bare model() on a policy-configured
    // strict OGM throws instead of silently applying no policy.
    expect(() => policyOgm([]).model('User')).toThrow(/applies no policy/);
    const c: Recorded[] = [];
    await policyOgm(c)
      .unsafe.bypassPolicies()
      .model('User')
      .create(create('u1'));
    const d: Recorded[] = [];
    await policyOgm(d)
      .withContext({ uid: 'u1' })
      .model('User')
      .create({ ...create('u1'), unsafe: { bypassPolicies: true } });
    for (const other of [c, d]) expect(other[0].cypher).toBe(a[0].cypher);
  });
});
