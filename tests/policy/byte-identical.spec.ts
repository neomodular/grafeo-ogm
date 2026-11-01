import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { override, permissive } from '../../src/policy/types';

const schema = `
type Book @node {
  id: ID! @id @unique
  title: String!
  ownerId: String
  tenantId: String
}
type User @node {
  id: ID! @id @unique
  name: String!
}
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function createMockDriver(records: Recorded[] = []): Driver {
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

/**
 * Byte-identical regression suite. Asserts that every covered v1.6.0
 * Cypher emission stays byte-equivalent when:
 *
 *   - The OGM is constructed WITHOUT a `policies` config.
 *   - The OGM is constructed WITH a `policies` config but the call
 *     site uses the bare `OGM.model()` path (no `withContext`).
 *   - The call site uses `withContext` but an `override` short-
 *     circuits all policies.
 *   - The call site uses `withContext` + per-call
 *     `unsafe.bypassPolicies`.
 *
 * If the implementation accidentally adds a no-op clause or reorders
 * existing emissions, this suite fails immediately.
 */
describe('byte-identical Cypher regression', () => {
  function compareCases(args: {
    label: string;
    run: (ogm: OGM) => Promise<unknown>;
  }) {
    return async () => {
      // Baseline: no policies, no withContext.
      const a: Recorded[] = [];
      const ogmA = new OGM({ typeDefs: schema, driver: createMockDriver(a) });
      await args.run(ogmA);

      // With policies registered but invoked via bare model() (no ctx).
      const b: Recorded[] = [];
      const ogmB = new OGM({
        typeDefs: schema,
        driver: createMockDriver(b),
        policies: {
          Book: [permissive({ operations: ['read'], when: () => ({}) })],
        },
      });
      await args.run(ogmB);

      // With override that short-circuits.
      const c: Recorded[] = [];
      const ogmC = new OGM({
        typeDefs: schema,
        driver: createMockDriver(c),
        policies: {
          Book: [
            override({ operations: ['*'], when: () => true }),
            permissive({
              operations: ['read'],
              when: () => ({ ownerId: 'u' }),
            }),
          ],
        },
      });
      // Use withContext so policies actually resolve.
      const wrappedC = ogmC.withContext({});
      // Call via the wrapper for the override path.
      const fakeOgmC = {
        model: (n: string) => wrappedC.model(n),
      } as unknown as OGM;
      await args.run(fakeOgmC);

      expect(a[0].cypher).toBe(b[0].cypher);
      expect(a[0].cypher).toBe(c[0].cypher);
    };
  }

  it(
    'find({ where: { id } }) is byte-identical',
    compareCases({
      label: 'find',
      run: (ogm) => ogm.model('Book').find({ where: { id: 'b1' } }),
    }),
  );

  it(
    'find() bare is byte-identical',
    compareCases({
      label: 'find()',
      run: (ogm) => ogm.model('Book').find(),
    }),
  );

  it(
    'update is byte-identical',
    compareCases({
      label: 'update',
      run: (ogm) =>
        ogm
          .model('Book')
          .update({ where: { id: 'b1' }, update: { title: 'X' } }),
    }),
  );

  it(
    'delete is byte-identical',
    compareCases({
      label: 'delete',
      run: (ogm) => ogm.model('Book').delete({ where: { id: 'b1' } }),
    }),
  );

  it(
    'count is byte-identical',
    compareCases({
      label: 'count',
      run: (ogm) => ogm.model('Book').count(),
    }),
  );

  it(
    'aggregate(count) is byte-identical',
    compareCases({
      label: 'aggregate',
      run: (ogm) => ogm.model('Book').aggregate({ aggregate: { count: true } }),
    }),
  );

  it(
    'updateMany is byte-identical',
    compareCases({
      label: 'updateMany',
      run: (ogm) =>
        ogm
          .model('Book')
          .updateMany({ where: { id: 'b1' }, data: { title: 'X' } }),
    }),
  );

  it(
    'deleteMany is byte-identical',
    compareCases({
      label: 'deleteMany',
      run: (ogm) => ogm.model('Book').deleteMany({}),
    }),
  );

  it('ogm.unsafe.bypassPolicies emits identical Cypher to no-policy OGM', async () => {
    const a: Recorded[] = [];
    const ogmA = new OGM({ typeDefs: schema, driver: createMockDriver(a) });
    await ogmA.model('Book').find({ where: { id: 'b1' } });

    const b: Recorded[] = [];
    const ogmB = new OGM({
      typeDefs: schema,
      driver: createMockDriver(b),
      policies: {
        Book: [
          permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
        ],
      },
    });
    await ogmB.unsafe
      .bypassPolicies()
      .model('Book')
      .find({ where: { id: 'b1' } });

    expect(a[0].cypher).toBe(b[0].cypher);
  });

  it('per-call unsafe emits identical Cypher to no-policy OGM', async () => {
    const a: Recorded[] = [];
    const ogmA = new OGM({ typeDefs: schema, driver: createMockDriver(a) });
    await ogmA.model('Book').find({ where: { id: 'b1' } });

    const b: Recorded[] = [];
    const ogmB = new OGM({
      typeDefs: schema,
      driver: createMockDriver(b),
      policies: {
        Book: [
          permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
        ],
      },
    });
    await ogmB
      .withContext({})
      .model('Book')
      .find({ where: { id: 'b1' }, unsafe: { bypassPolicies: true } });

    expect(a[0].cypher).toBe(b[0].cypher);
  });
});

/**
 * v2.20.1 — security: a node-typed `@cypher` field projected bare is
 * filtered by the target's read policy. Without `policies`, with a
 * bypass, an override, or no read clause on the target, the Cypher stays
 * byte for byte what v2.20.0 emitted (goldens captured on 6c556de).
 */
describe('byte-identical: node-typed @cypher field projected bare', () => {
  const cypherSchema = `
type User @node {
  id: ID! @unique
  topPost: Post @cypher(statement: "MATCH (p:Post) RETURN p LIMIT 1", columnName: "p")
  posts: [Post!]! @cypher(statement: "MATCH (p:Post) RETURN p", columnName: "p")
  friends: [User!]! @relationship(type: "FRIEND", direction: OUT)
}
type Post @node { id: ID! @unique ownerId: String }
type Tag @node { id: ID! @unique }
`;
  const selectionSet = '{ id topPost posts friends { topPost posts } }';
  const GOLDEN = {
    default:
      'MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __sel_n_topPost\n}\nWITH n, __sel_n_topPost\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p\n  }\n  RETURN head(collect(`p`)) AS __sel_n_posts\n}\nWITH n, __sel_n_topPost, __sel_n_posts\nRETURN n { .`id`, `topPost`: __sel_n_topPost, `posts`: __sel_n_posts, friends: [(n)-[:`FRIEND`]->(n0:`User`) | n0 { `topPost`: head(COLLECT { WITH n0 AS this\n  MATCH (p:Post) RETURN p LIMIT 1\n}), `posts`: head(COLLECT { WITH n0 AS this\n  MATCH (p:Post) RETURN p\n}) }] }',
    strict:
      'MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __sel_n_topPost\n}\nWITH n, __sel_n_topPost\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p\n  }\n  UNWIND `p` AS `__sel_n_posts__cf_el`\n  RETURN collect(`__sel_n_posts__cf_el`) AS __sel_n_posts\n}\nWITH n, __sel_n_topPost, __sel_n_posts\nRETURN n { .`id`, `topPost`: __sel_n_topPost, `posts`: __sel_n_posts, friends: [(n)-[:`FRIEND`]->(n0:`User`) | n0 { `topPost`: head(COLLECT { WITH n0 AS this\n  MATCH (p:Post) RETURN p LIMIT 1\n}), `posts`: COLLECT { WITH n0 AS this\n  CALL {\n    WITH this\n    MATCH (p:Post) RETURN p\n  }\n  UNWIND `p` AS `p__cf_el`\n  WITH `p__cf_el` WHERE `p__cf_el` IS NOT NULL\n  RETURN `p__cf_el`\n} }] }',
  };
  const quiet = { warn: () => undefined, debug: () => undefined };
  const postPolicy = [
    permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
  ];

  describe.each([
    ['default', undefined],
    ['strict', true],
  ] as const)('%s mode', (mode, strict) => {
    const golden = GOLDEN[mode];
    const emit = async (
      run: (driver: Driver) => Promise<unknown>,
    ): Promise<string> => {
      const r: Recorded[] = [];
      await run(createMockDriver(r));
      return r[0].cypher;
    };

    it('no policies', async () => {
      expect(
        await emit((driver) =>
          new OGM({ typeDefs: cypherSchema, driver, strict, logger: quiet })
            .model('User')
            .find({ selectionSet }),
        ),
      ).toBe(golden);
    });

    it('policies on another type only (no read clause on the target)', async () => {
      expect(
        await emit((driver) =>
          new OGM({
            typeDefs: cypherSchema,
            driver,
            strict,
            logger: quiet,
            policies: {
              Tag: [permissive({ operations: ['read'], when: () => ({}) })],
            },
          })
            .withContext({})
            .model('User')
            .find({ selectionSet }),
        ),
      ).toBe(golden);
    });

    it('ogm.unsafe.bypassPolicies() and per-call unsafe', async () => {
      const make = (driver: Driver) =>
        new OGM({
          typeDefs: cypherSchema,
          driver,
          strict,
          logger: quiet,
          policies: { Post: postPolicy },
        });
      expect(
        await emit((driver) =>
          make(driver)
            .unsafe.bypassPolicies()
            .model('User')
            .find({ selectionSet }),
        ),
      ).toBe(golden);
      expect(
        await emit((driver) =>
          make(driver)
            .withContext({})
            .model('User')
            .find({ selectionSet, unsafe: { bypassPolicies: true } }),
        ),
      ).toBe(golden);
    });

    it('an override that short-circuits the target policy', async () => {
      expect(
        await emit((driver) =>
          new OGM({
            typeDefs: cypherSchema,
            driver,
            strict,
            logger: quiet,
            policies: {
              Post: [
                override({ operations: ['*'], when: () => true }),
                ...postPolicy,
              ],
            },
          })
            .withContext({})
            .model('User')
            .find({ selectionSet }),
        ),
      ).toBe(golden);
    });

    it('a read clause on the target guards the value', async () => {
      const cypher = await emit((driver) =>
        new OGM({
          typeDefs: cypherSchema,
          driver,
          strict,
          logger: quiet,
          policies: { Post: postPolicy },
        })
          .withContext({})
          .model('User')
          .find({ selectionSet }),
      );
      expect(cypher).not.toBe(golden);
      expect(cypher).toContain('n__cfn');
      expect(cypher).toContain('n0__cfn');
    });
  });
});

/**
 * v2.22.1 — security: a node-typed `@cypher` field used in a where filter
 * (root, relationship quantifier, `count`) or as a sort key (root
 * `options.sort`, nested `sort`) is read through the target's read policy.
 * Without `policies`, with a bypass, an override, or no read clause on the
 * target, the Cypher stays byte for byte what v2.22.0 emitted (goldens
 * captured on ad90081).
 */
describe('byte-identical: node-typed @cypher field in where / sort', () => {
  const cypherSchema = `
type User @node {
  id: ID! @unique
  topPost: Post @cypher(statement: "MATCH (p:Post) RETURN p LIMIT 1", columnName: "p")
  posts: [Post!]! @cypher(statement: "MATCH (p:Post) RETURN p", columnName: "p")
  friends: [User!]! @relationship(type: "FRIEND", direction: OUT)
}
type Post @node { id: ID! @unique ownerId: String }
type Tag @node { id: ID! @unique }
`;
  const where = {
    topPost_NOT: null,
    posts_NOT: [],
    friends_SOME: { topPost: null },
  };
  // v2.26.0 — strict item 47 (root sort): a root sort by a node-typed @cypher
  // field throws in strict mode, so the strict golden sorts by `id` only.
  const options = (
    strict?: boolean,
  ): { sort: Record<string, 'ASC' | 'DESC'>[] } => ({
    sort: strict ? [{ id: 'ASC' }] : [{ topPost: 'DESC' }, { id: 'ASC' }],
  });
  // v2.25.0 — strict item 47: a nested sort by a node-typed @cypher field
  // sorts as null by default (it failed in apoc.coll.sortMulti whenever a
  // value was a node) and throws in strict mode, so the strict golden
  // selects the relationship unsorted.
  const selectionSet = (strict?: boolean) =>
    strict
      ? '{ id friends { id } }'
      : '{ id friends(options: { sort: [{ topPost: DESC }] }) { id } }';
  let emitStrict: boolean | undefined;
  // [find, count]
  const GOLDEN: Record<'default' | 'strict', string[]> = {
    default: [
      "MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __where_n_topPost\n}\nWITH n, __where_n_topPost\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p\n  }\n  RETURN head(collect(`p`)) AS __where_n_posts\n}\nWITH n, __where_n_topPost, __where_n_posts\nWHERE __where_n_topPost IS NOT NULL AND __where_n_posts <> $param0 AND EXISTS { MATCH (n)-[:`FRIEND`]->(r1:`User`) CALL {\n  WITH r1\n  CALL {\n    WITH r1\n    WITH r1 AS this\n    MATCH (p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __where_r1_topPost\n} WITH r1, __where_r1_topPost WHERE __where_r1_topPost IS NULL }\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __sort_topPost\n}\nWITH n, __sort_topPost\nWITH *\nORDER BY __sort_topPost DESC, n.`id` ASC\nRETURN n { .`id`, friends: [__sk IN apoc.coll.sortMulti([(n)-[:`FRIEND`]->(n0:`User`) | { __node: n0 { .`id` }, __sk0: null }], ['__sk0']) | __sk.__node] }",
      'MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __where_n_topPost\n}\nWITH n, __where_n_topPost\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p\n  }\n  RETURN head(collect(`p`)) AS __where_n_posts\n}\nWITH n, __where_n_topPost, __where_n_posts\nWHERE __where_n_topPost IS NOT NULL AND __where_n_posts <> $param0 AND EXISTS { MATCH (n)-[:`FRIEND`]->(r1:`User`) CALL {\n  WITH r1\n  CALL {\n    WITH r1\n    WITH r1 AS this\n    MATCH (p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __where_r1_topPost\n} WITH r1, __where_r1_topPost WHERE __where_r1_topPost IS NULL }\nRETURN count(n) AS count',
    ],
    strict: [
      'MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __where_n_topPost\n}\nWITH n, __where_n_topPost\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p\n  }\n  UNWIND `p` AS `__where_n_posts__cf_el`\n  RETURN collect(`__where_n_posts__cf_el`) AS __where_n_posts\n}\nWITH n, __where_n_topPost, __where_n_posts\nWHERE __where_n_topPost IS NOT NULL AND __where_n_posts <> $param0 AND EXISTS { MATCH (n)-[:`FRIEND`]->(r1:`User`) CALL {\n  WITH r1\n  CALL {\n    WITH r1\n    WITH r1 AS this\n    MATCH (p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __where_r1_topPost\n} WITH r1, __where_r1_topPost WHERE __where_r1_topPost IS NULL }\nWITH *\nORDER BY n.`id` ASC\nRETURN n { .`id`, friends: [(n)-[:`FRIEND`]->(n0:`User`) | n0 { .`id` }] }',
      'MATCH (n:`User`)\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __where_n_topPost\n}\nWITH n, __where_n_topPost\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (p:Post) RETURN p\n  }\n  UNWIND `p` AS `__where_n_posts__cf_el`\n  RETURN collect(`__where_n_posts__cf_el`) AS __where_n_posts\n}\nWITH n, __where_n_topPost, __where_n_posts\nWHERE __where_n_topPost IS NOT NULL AND __where_n_posts <> $param0 AND EXISTS { MATCH (n)-[:`FRIEND`]->(r1:`User`) CALL {\n  WITH r1\n  CALL {\n    WITH r1\n    WITH r1 AS this\n    MATCH (p:Post) RETURN p LIMIT 1\n  }\n  RETURN head(collect(`p`)) AS __where_r1_topPost\n} WITH r1, __where_r1_topPost WHERE __where_r1_topPost IS NULL }\nRETURN count(n) AS count',
    ],
  };
  const quiet = { warn: () => undefined, debug: () => undefined };
  const postPolicy = [
    permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
  ];
  type Bound = Pick<OGM, 'model'>;
  const emit = async (
    bind: (driver: Driver) => Bound,
    unsafe?: { bypassPolicies: true },
  ): Promise<string[]> => {
    const r: Recorded[] = [];
    const model = bind(createMockDriver(r)).model('User');
    await model.find({
      where,
      options: options(emitStrict),
      selectionSet: selectionSet(emitStrict),
      unsafe,
    });
    await model.count({ where, unsafe });
    return r.map((x) => x.cypher);
  };

  describe.each([
    ['default', undefined],
    ['strict', true],
  ] as const)('%s mode', (mode, strict) => {
    const golden = GOLDEN[mode];
    beforeEach(() => {
      emitStrict = strict;
    });
    const make = (
      driver: Driver,
      policies?: ConstructorParameters<typeof OGM>[0]['policies'],
    ) =>
      new OGM({
        typeDefs: cypherSchema,
        driver,
        strict,
        logger: quiet,
        policies,
      });

    it('no policies', async () => {
      expect(await emit((d) => make(d))).toEqual(golden);
    });

    it('policies on another type only (no read clause on the target)', async () => {
      expect(
        await emit((d) =>
          make(d, {
            Tag: [permissive({ operations: ['read'], when: () => ({}) })],
          }).withContext({}),
        ),
      ).toEqual(golden);
    });

    it('ogm.unsafe.bypassPolicies() and per-call unsafe', async () => {
      expect(
        await emit((d) =>
          make(d, { Post: postPolicy }).unsafe.bypassPolicies(),
        ),
      ).toEqual(golden);
      expect(
        await emit((d) => make(d, { Post: postPolicy }).withContext({}), {
          bypassPolicies: true,
        }),
      ).toEqual(golden);
    });

    it('an override that short-circuits the target policy', async () => {
      expect(
        await emit((d) =>
          make(d, {
            Post: [
              override({ operations: ['*'], when: () => true }),
              ...postPolicy,
            ],
          }).withContext({}),
        ),
      ).toEqual(golden);
    });

    it('a read clause on the target guards every reference', async () => {
      const [find, count] = await emit((d) =>
        make(d, { Post: postPolicy }).withContext({}),
      );
      expect(find).toContain(
        'head([n__cfn IN [__where_n_topPost] WHERE (n__cfn.`ownerId` = ',
      );
      expect(find).toMatch(
        /WHERE head\(\[(r\d+)__cfn IN \[__where_\1_topPost\] WHERE \(\1__cfn\.`ownerId` = /,
      );
      if (!strict)
        expect(find).toContain(
          'ORDER BY head([n__cfn IN [__sort_topPost] WHERE (n__cfn.`ownerId` = ',
        );
      // v2.25.0 — the nested node-typed sort key reads no node at all.
      if (!strict) expect(find).toContain('__sk0: null }');
      expect(count).toContain('head([n__cfn IN [__where_n_topPost] WHERE');
    });
  });
});
