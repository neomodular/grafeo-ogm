/**
 * v2.20.1 — security: a `@cypher` field whose type is a node, interface or
 * union type, projected as a whole value (selected bare or with
 * `select: { f: true }`), is filtered by the target type's `read` policy.
 * Pre-2.20.1 it returned the statement's nodes with no policy at all.
 * Live coverage: tests/integration/nls-cypher-node-field.spec.ts.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { override, permissive } from '../../src/policy/types';

const typeDefs = `
type User @node {
  id: ID! @unique
  topPost: Post @cypher(statement: "MATCH (p:Post) RETURN p LIMIT 1", columnName: "p")
  posts: [Post!]! @cypher(statement: "MATCH (p:Post) RETURN p", columnName: "p")
  first: Content @cypher(statement: "MATCH (c:Post|Doc) RETURN c LIMIT 1", columnName: "c")
  items: [Item!]! @cypher(statement: "MATCH (c:Post|Doc) RETURN c", columnName: "c")
  label: String @cypher(statement: "RETURN 'x' AS v", columnName: "v")
  friends: [User!]! @relationship(type: "FRIEND", direction: OUT)
}
interface Content { id: ID! }
union Item = Post | Doc
type Post implements Content @node { id: ID! @unique ownerId: String }
type Doc implements Content @node {
  id: ID! @unique
  visible: Boolean
  lead: Post @cypher(statement: "MATCH (p:Post) RETURN p LIMIT 1", columnName: "p")
}
type Tag @node { id: ID! @unique }
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function mockDriver(records: Recorded[]): Driver {
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      records.push({ cypher, params });
      return Promise.resolve({ records: [], summary: { counters: {} } });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { session: jest.fn().mockReturnValue(session) } as unknown as Driver;
}

const policies = {
  Post: [
    permissive({
      operations: ['read'],
      when: (c) => ({ ownerId: c.userId as string }),
    }),
  ],
  Doc: [permissive({ operations: ['read'], when: () => ({ visible: true }) })],
};

async function compile(
  selectionSet: string | undefined,
  opts: {
    strict?: boolean;
    policies?: ConstructorParameters<typeof OGM>[0]['policies'];
    select?: Record<string, unknown>;
    model?: string;
    iface?: string;
  } = {},
): Promise<Recorded> {
  const records: Recorded[] = [];
  const ogm = new OGM({
    typeDefs,
    driver: mockDriver(records),
    strict: opts.strict,
    logger: { warn: () => undefined, debug: () => undefined },
    policies: opts.policies === undefined ? policies : opts.policies,
  });
  const bound = ogm.withContext({ userId: 'u1' });
  if (opts.iface) await bound.interfaceModel(opts.iface).find({ selectionSet });
  else if (opts.select)
    await bound.model(opts.model ?? 'User').find({ select: opts.select });
  else await bound.model(opts.model ?? 'User').find({ selectionSet });
  return records[0];
}

describe('policy: node-typed @cypher field projected bare (v2.20.1)', () => {
  it('single field: head of the value filtered by the read clause', async () => {
    const { cypher, params } = await compile('{ id topPost }');
    expect(cypher).toMatch(
      /`topPost`: head\(\[n__cfn IN \[__sel_n_topPost\] WHERE \(n__cfn\.`ownerId` = \$(\w+)\)\]\)/,
    );
    expect(Object.values(params)).toContain('u1');
  });

  it('select: { topPost: true } takes the same guard', async () => {
    const { cypher } = await compile(undefined, {
      select: { id: true, topPost: true },
    });
    expect(cypher).toContain('head([n__cfn IN [__sel_n_topPost] WHERE');
  });

  it('strict list field: hidden elements filtered out of the list', async () => {
    const { cypher } = await compile('{ posts }', { strict: true });
    expect(cypher).toMatch(
      /`posts`: \[n__cfn IN __sel_n_posts WHERE \(n__cfn\.`ownerId` = \$\w+\)\]/,
    );
  });

  it('default list field: the first row is filtered as a node or a list', async () => {
    const { cypher } = await compile('{ posts }');
    expect(cypher).toContain(
      '`posts`: head([n__cfv IN [__sel_n_posts] | head([n__cfl IN [[n__cfn IN CASE WHEN n__cfv IS :: LIST<ANY> THEN n__cfv ELSE [n__cfv] END WHERE',
    );
    expect(cypher).toContain(
      '| CASE WHEN n__cfv IS :: LIST<ANY> THEN n__cfl ELSE head(n__cfl) END])])',
    );
  });

  it('interface / union target: one guard per member', async () => {
    const { cypher } = await compile('{ first items }', { strict: true });
    for (const field of ['first', 'items']) {
      const m = cypher.match(new RegExp('`' + field + '`: (.*)'));
      expect(m).not.toBeNull();
      expect(m![1]).toContain('n__cfn:`Post`');
      expect(m![1]).toContain('n__cfn:`Doc`');
      expect(m![1]).toContain('`ownerId`');
      expect(m![1]).toContain('`visible`');
    }
  });

  it('nested inside a relationship: the inline value is guarded', async () => {
    const { cypher } = await compile('{ friends { topPost } }');
    expect(cypher).toMatch(
      /`topPost`: head\(\[n0__cfn IN \[head\(COLLECT \{ WITH n0 AS this[\s\S]*?\}\)\] WHERE \(n0__cfn\.`ownerId` = \$\w+\)\]\)/,
    );
  });

  it('a member fragment selecting the field bare (InterfaceModel)', async () => {
    const { cypher } = await compile('{ id ... on Doc { lead } }', {
      iface: 'Content',
    });
    expect(cypher).toMatch(
      /WHEN n:`Doc`[^]*?THEN head\(\[n__cfn IN \[__sel_n_Doc_lead\] WHERE \(n__cfn\.`ownerId` = \$\w+\)\]\)/,
    );
  });

  it('a scalar @cypher field is not wrapped', async () => {
    const { cypher } = await compile('{ label }');
    expect(cypher).toContain('`label`: __sel_n_label');
  });

  it('no guard when the target type has no read clause', async () => {
    const withPolicies = await compile('{ topPost posts first items }', {
      policies: {
        Tag: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    const without = await compile('{ topPost posts first items }', {
      policies: {},
    });
    expect(withPolicies.cypher).toBe(without.cypher);
    expect(withPolicies.cypher).not.toContain('__cfn');
  });

  it('an override short-circuits the guard', async () => {
    const records: Recorded[] = [];
    const ogm = new OGM({
      typeDefs,
      driver: mockDriver(records),
      policies: {
        Post: [
          override({ operations: ['*'], when: () => true }),
          ...policies.Post,
        ],
      },
    });
    await ogm
      .withContext({})
      .model('User')
      .find({ selectionSet: '{ topPost }' });
    expect(records[0].cypher).not.toContain('__cfn');
  });

  it('a target policy that needs a @cypher field throws (fail closed)', async () => {
    const records: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: typeDefs.replace(
        'type Post implements Content @node { id: ID! @unique ownerId: String }',
        'type Post implements Content @node { id: ID! @unique ownerId: String owner: String @cypher(statement: "RETURN this.ownerId AS o", columnName: "o") }',
      ),
      driver: mockDriver(records),
      policies: {
        Post: [
          permissive({
            operations: ['read'],
            when: (c) => ({ owner: c.userId as string }),
          }),
        ],
      },
    });
    await expect(
      ogm
        .withContext({ userId: 'u1' })
        .model('User')
        .find({ selectionSet: '{ topPost }' }),
    ).rejects.toThrow(/requires @cypher field projection/);
  });
});

/**
 * vNEXT — security: the same guard applies where the value is filtered or
 * sorted on. Live coverage: tests/integration/nls-cypher-node-filter-sort.spec.ts.
 */
describe('policy: node-typed @cypher field in where / sort (vNEXT)', () => {
  type UserModel = ReturnType<ReturnType<OGM['withContext']>['model']>;
  const run = async (
    call: (m: UserModel) => Promise<unknown>,
    opts: {
      strict?: boolean;
      typeDefs?: string;
      policies?: ConstructorParameters<typeof OGM>[0]['policies'];
    } = {},
  ): Promise<Recorded> => {
    const records: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: opts.typeDefs ?? typeDefs,
      driver: mockDriver(records),
      strict: opts.strict,
      logger: { warn: () => undefined, debug: () => undefined },
      policies: opts.policies ?? policies,
    });
    await call(ogm.withContext({ userId: 'u1' }).model('User'));
    return records[0];
  };

  it('where: null checks read the guarded value', async () => {
    const { cypher, params } = await run((m) =>
      m.find({ where: { topPost_NOT: null }, selectionSet: '{ id }' }),
    );
    expect(cypher).toMatch(
      /WHERE head\(\[n__cfn IN \[__where_n_topPost\] WHERE \(n__cfn\.`ownerId` = \$(\w+)\)\]\) IS NOT NULL/,
    );
    expect(Object.values(params)).toContain('u1');
  });

  it('where: a valued operator reads the guarded value, user params keep their numbers', async () => {
    const { cypher, params } = await run(
      (m) => m.find({ where: { posts: [] }, selectionSet: '{ id }' }),
      { strict: true },
    );
    expect(cypher).toContain(
      'WHERE [n__cfn IN __where_n_posts WHERE (n__cfn.`ownerId` = $param1)] = $param0',
    );
    expect(params.param0).toEqual([]);
  });

  it('where: an interface / union target is guarded per member', async () => {
    const { cypher } = await run((m) =>
      m.find({ where: { first_NOT: null }, selectionSet: '{ id }' }),
    );
    expect(cypher).toContain('n__cfn:`Post`');
    expect(cypher).toContain('n__cfn:`Doc`');
  });

  it('where: a scalar @cypher field is not wrapped', async () => {
    const { cypher } = await run((m) =>
      m.find({ where: { label: 'x' }, selectionSet: '{ id }' }),
    );
    expect(cypher).not.toContain('__cfn');
  });

  it('sort: the ORDER BY key is the guarded value', async () => {
    const { cypher } = await run((m) =>
      m.find({
        selectionSet: '{ id }',
        options: { sort: [{ topPost: 'ASC' }] },
      }),
    );
    expect(cypher).toMatch(
      /ORDER BY head\(\[n__cfn IN \[__sort_topPost\] WHERE \(n__cfn\.`ownerId` = \$\w+\)\]\) ASC/,
    );
  });

  it('a target policy that needs a @cypher field throws (fail closed)', async () => {
    const opts = {
      typeDefs: typeDefs.replace(
        'type Post implements Content @node { id: ID! @unique ownerId: String }',
        'type Post implements Content @node { id: ID! @unique ownerId: String owner: String @cypher(statement: "RETURN this.ownerId AS o", columnName: "o") }',
      ),
      policies: {
        ...policies,
        Post: [
          permissive({
            operations: ['read'],
            when: (c) => ({ owner: c.userId as string }),
          }),
        ],
      },
    };
    const message = /filtering or sorting by the @cypher field "User\.topPost"/;
    await expect(
      run(
        (m) => m.find({ where: { topPost: null }, selectionSet: '{ id }' }),
        opts,
      ),
    ).rejects.toThrow(message);
    await expect(
      run(
        (m) =>
          m.find({
            selectionSet: '{ id }',
            options: { sort: [{ topPost: 'ASC' }] },
          }),
        opts,
      ),
    ).rejects.toThrow(message);
  });
});
