/**
 * vNEXT — compile-only OGM (GitHub issue #3): `createCompileOnlyOgm()` +
 * `compile(model)` return the statement a model call would send, with no
 * driver, and reject with the error the real call throws before it reaches
 * the database.
 */
import { DateTime, int, Point } from 'neo4j-driver';
import * as main from '../src';
import { InterfaceModel } from '../src/interface-model';
import { Model } from '../src/model';
import { OGM } from '../src/ogm';
import { permissive, restrictive } from '../src/policy/types';
import * as testing from '../src/testing';
import {
  COMPILABLE_METHODS,
  compile,
  CompilableMethod,
  CompiledQuery,
  createCompileOnlyOgm,
  normalizeCompiled,
} from '../src/testing';
import { assertSafeRegexPattern } from '../src/utils/validation';

const typeDefs = /* GraphQL */ `
  interface Owned {
    id: ID!
    tenantId: String
  }
  type Wrote @relationshipProperties {
    role: String
  }
  type User implements Owned
    @node
    @fulltext(indexes: [{ indexName: "UserName", fields: ["name"] }])
    @vector(
      indexes: [
        {
          indexName: "UserEmb"
          queryName: "similarUsers"
          embeddingProperty: "embedding"
          provider: "OpenAI"
        }
      ]
    ) {
    id: ID! @id @unique
    name: String
    age: Int
    tenantId: String
    embedding: [Float!]
    pets: [Pet!]! @relationship(type: "HAS", direction: OUT)
    posts: [Post!]!
      @relationship(type: "WROTE", direction: OUT, properties: "Wrote")
  }
  type Pet implements Owned @node {
    id: ID! @id @unique
    name: String
    tenantId: String
  }
  type Post @node {
    id: ID! @id @unique
    title: String
  }
`;

const tenantPolicies = {
  User: [
    permissive({
      operations: ['read', 'update', 'delete', 'create', 'aggregate'],
      when: (ctx: { tenantId?: string }) => ({ tenantId: ctx.tenantId }),
    }),
  ],
  Pet: [
    permissive({
      operations: ['read', 'update', 'delete', 'create'],
      when: (ctx: { tenantId?: string }) => ({ tenantId: ctx.tenantId }),
    }),
  ],
};

const user = () => compile(createCompileOnlyOgm({ typeDefs }).model('User'));

describe('compile-only OGM — every compilable method (Model)', () => {
  const where = { id: 'u1' };
  const cases: Array<
    [CompilableMethod, (m: ReturnType<typeof user>) => Promise<CompiledQuery>]
  > = [
    ['find', (m) => m.find({ where: { name_CONTAINS: 'al' } })],
    ['findFirst', (m) => m.findFirst({ where })],
    ['findUnique', (m) => m.findUnique({ where })],
    ['findFirstOrThrow', (m) => m.findFirstOrThrow({ where })],
    ['findUniqueOrThrow', (m) => m.findUniqueOrThrow({ where })],
    ['count', (m) => m.count({ where: { age_GT: 3 } })],
    [
      'aggregate',
      (m) => m.aggregate({ where: {}, aggregate: { count: true, age: true } }),
    ],
    ['create', (m) => m.create({ input: [{ name: 'a' }] })],
    [
      'createMany',
      (m) => m.createMany({ data: [{ name: 'a' }, { name: 'b' }] }),
    ],
    [
      'update',
      (m) =>
        m.update({
          where,
          update: { name: 'x' },
          connect: { pets: [{ where: { node: { id: 'p1' } } }] },
          disconnect: { pets: [{ where: { node: { id: 'p2' } } }] },
        }),
    ],
    ['updateMany', (m) => m.updateMany({ where, data: { name: 'x' } })],
    ['delete', (m) => m.delete({ where, delete: { pets: [{}] } })],
    ['deleteMany', (m) => m.deleteMany({ where })],
    [
      'upsert',
      (m) => m.upsert({ where, create: { name: 'a' }, update: { name: 'b' } }),
    ],
    ['setLabels', (m) => m.setLabels({ where, addLabels: ['Vip'] })],
    [
      'searchByVector',
      (m) =>
        m.searchByVector({ indexName: 'UserEmb', vector: [0.1, 0.2], k: 3 }),
    ],
    [
      'searchByPhrase',
      (m) =>
        m.searchByPhrase({
          indexName: 'UserEmb',
          phrase: 'hello',
          k: 3,
          providerConfig: { token: 'x' },
        }),
    ],
  ];

  it('covers every compilable method except explainPolicies (policy-bound, below)', () => {
    expect(cases.map(([name]) => name).sort()).toEqual(
      COMPILABLE_METHODS.filter((m) => m !== 'explainPolicies').sort(),
    );
  });

  it.each(cases)(
    '%s returns the statement the real call sends',
    async (name, run) => {
      const recorded: Array<{
        cypher: string;
        params: Record<string, unknown>;
      }> = [];
      const real = new OGM({ typeDefs, driver: recordingDriver(recorded) });
      const realModel = real.model('User') as unknown as Record<
        string,
        (p: unknown) => Promise<unknown>
      >;
      const q = await run(user());
      // Same call on a real OGM over a recording driver: identical statement.
      const params = paramsOf(run);
      await realModel[name](params).catch(() => undefined);
      expect(recorded).toHaveLength(1);
      expect(q.cypher).toBe(recorded[0].cypher);
      expect(q.params).toEqual(recorded[0].params);
      expect(q.warnings).toEqual([]);
    },
  );

  it('find compiles where, mode and paging', async () => {
    const q = await user().find({
      where: { name_CONTAINS: 'al', mode: 'insensitive' },
      options: { limit: 5 },
    });
    expect(q.cypher).toBe(
      'MATCH (n:`User`)\nWHERE toLower(n.`name`) CONTAINS toLower($param0)\nWITH *\nLIMIT $options_limit\n' +
        "RETURN n { __typename: 'User', .`id`, .`name`, .`age`, .`tenantId`, .`embedding` }",
    );
    expect(q.params).toEqual({ param0: 'al', options_limit: int(5) });
    expect(q.metadata).toBeUndefined();
    expect(q.accessMode).toBeUndefined();
  });

  it('findFirstOrThrow resolves to the statement (RecordNotFoundError needs a result)', async () => {
    const q = await user().findFirstOrThrow({ where: { id: 'nope' } });
    expect(q.cypher).toContain('LIMIT $options_limit');
  });

  it('update compiles nested connect / disconnect at any depth', async () => {
    const q = await user().update({
      where: { id: 'u1' },
      update: {
        pets: [
          { where: { node: { id: 'p1' } }, update: { node: { name: 'n' } } },
        ],
      },
      connect: {
        posts: [{ where: { node: { id: 'b1' } }, edge: { role: 'r' } }],
      },
      disconnect: { pets: [{ where: { node: { id: 'p2' } } }] },
    });
    expect(q.cypher).toContain('MERGE (n)-[r:`WROTE`]->(target)');
    expect(q.cypher).toContain(
      'OPTIONAL MATCH (n)-[r_pets_0:`HAS`]->(target_pets_0:`Pet`)',
    );
  });

  it('fulltext reads compile', async () => {
    const q = await user().find({ fulltext: { UserName: { phrase: 'al*' } } });
    expect(q.cypher).toContain('db.index.fulltext.queryNodes');
  });

  it('searchByPhrase passes providerConfig as a parameter', async () => {
    const q = await user().searchByPhrase({
      indexName: 'UserEmb',
      phrase: 'hi',
      k: 2,
      providerConfig: { token: 'secret' },
    });
    expect(q.cypher).toContain('genai.vector.encode');
    expect(q.cypher).not.toContain('secret');
    expect(Object.values(q.params)).toContainEqual({ token: 'secret' });
  });
});

describe('compile-only OGM — InterfaceModel', () => {
  const owned = () =>
    compile(createCompileOnlyOgm({ typeDefs }).interfaceModel('Owned'));

  it('wraps exactly the read methods an InterfaceModel has', () => {
    expect(Object.keys(owned()).sort()).toEqual(
      [
        'aggregate',
        'count',
        'find',
        'findFirst',
        'findFirstOrThrow',
        'findUnique',
        'findUniqueOrThrow',
      ].sort(),
    );
  });

  it.each([
    ['find', (m: ReturnType<typeof owned>) => m.find({ where: { id: '1' } })],
    [
      'findFirst',
      (m: ReturnType<typeof owned>) => m.findFirst({ where: { id: '1' } }),
    ],
    [
      'findUnique',
      (m: ReturnType<typeof owned>) => m.findUnique({ where: { id: '1' } }),
    ],
    [
      'findFirstOrThrow',
      (m: ReturnType<typeof owned>) =>
        m.findFirstOrThrow({ where: { id: '1' } }),
    ],
    [
      'findUniqueOrThrow',
      (m: ReturnType<typeof owned>) =>
        m.findUniqueOrThrow({ where: { id: '1' } }),
    ],
    ['count', (m: ReturnType<typeof owned>) => m.count({ where: { id: '1' } })],
    [
      'aggregate',
      (m: ReturnType<typeof owned>) =>
        m.aggregate({ where: { id: '1' }, aggregate: { count: true } }),
    ],
  ])('%s compiles across the implementors', async (_name, run) => {
    const q = await run(owned());
    expect(q.cypher).toContain('MATCH (n:(`User`|`Pet`))');
  });
});

describe('compile-only OGM — errors and warnings the real call raises', () => {
  it('rejects a pattern the _MATCHES guard refuses', async () => {
    await expect(
      user().find({ where: { name_MATCHES: '(a+)+' } }),
    ).rejects.toThrow(/Unsafe `_MATCHES` pattern/);
  });

  it('strict mode rejects; default mode returns the warning on every call', async () => {
    const strict = compile(
      createCompileOnlyOgm({ typeDefs, strict: true }).model('User'),
    );
    await expect(strict.find({ wehre: { id: '1' } } as never)).rejects.toThrow(
      /Unknown parameter "wehre"/,
    );

    const lenient = user();
    for (let i = 0; i < 2; i++) {
      const q = await lenient.find({ wehre: { id: '1' } } as never);
      expect(q.warnings).toEqual([
        expect.stringContaining(
          'Unknown parameter "wehre" of User.find() is ignored',
        ),
      ]);
    }
    // A clean call right after carries no warning.
    expect((await lenient.find()).warnings).toEqual([]);
  });

  it('shows a filter dropped by an empty AND', async () => {
    const q = await user().find({ where: { AND: [] } });
    expect(q.cypher).not.toContain('WHERE');
    expect(q.warnings).toEqual([
      expect.stringContaining('AND has zero effective conditions'),
    ]);
  });

  it('still logs every warning to a logger the caller passes', async () => {
    const warn = jest.fn();
    const m = compile(
      createCompileOnlyOgm({
        typeDefs,
        logger: { debug: () => {}, warn },
      }).model('User'),
    );
    await m.find({ wehre: {} } as never);
    await m.find({ wehre: {} } as never);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('rejects a context transaction / session, which would run the statement', async () => {
    const tx = { run: jest.fn() };
    for (const key of ['transaction', 'executionContext', 'session'])
      await expect(
        user().find({ context: { [key]: tx } } as never),
      ).rejects.toThrow(
        new RegExp(`"context\\.${key}" would run the statement`),
      );
    expect(tx.run).not.toHaveBeenCalled();
  });

  it('passes context.metadata through to the statement metadata', async () => {
    const q = await user().find({ context: { metadata: { app: 'x' } } });
    expect(q.metadata).toEqual({ app: 'x' });
    expect((await user().find({ context: {} })).metadata).toBeUndefined();
  });
});

describe('compile-only OGM — policies', () => {
  const ogm = () =>
    createCompileOnlyOgm({ typeDefs, policies: tenantPolicies as never });

  it('withContext stitches the policy predicate and returns the audit metadata', async () => {
    const q = await compile(
      ogm().withContext({ tenantId: 't1' }).model('User'),
    ).find({
      where: { name: 'a' },
    });
    expect(q.cypher).toContain(
      'WHERE (n.`name` = $param0) AND (n.`tenantId` = $param1)',
    );
    expect(q.params).toEqual({ param0: 'a', param1: 't1' });
    expect(q.metadata).toMatchObject({
      modelType: 'User',
      operation: 'read',
      bypassed: false,
    });
  });

  it("applies the target type's policy to a nested connect", async () => {
    const q = await compile(
      ogm().withContext({ tenantId: 't1' }).model('User'),
    ).update({
      where: { id: 'u1' },
      connect: { pets: [{ where: { node: { id: 'p1' } } }] },
    });
    // The Pet read policy is ANDed onto the connect target MATCH.
    expect(q.cypher).toMatch(/target\.`tenantId` = \$param\d+/);
  });

  it("default-deny 'throw' rejects at compile", async () => {
    const strictDeny = createCompileOnlyOgm({
      typeDefs,
      policies: {
        User: [
          restrictive({ operations: ['read'], when: () => ({ age_GT: 1 }) }),
        ],
      } as never,
      policyDefaults: { onDeny: 'throw' },
    });
    await expect(
      compile(strictDeny.withContext({}).model('User')).find(),
    ).rejects.toThrow(/no-permissive-matched|denied/i);
  });

  it('unsafe.bypassPolicies() compiles without the predicate and warns', async () => {
    const o = ogm();
    const m = compile(o.unsafe.bypassPolicies().model('User'));
    const q = await m.find({ where: { name: 'a' } });
    expect(q.cypher).not.toContain('tenantId` =');
    expect(q.warnings).toEqual([
      expect.stringContaining(
        'policies bypassed via unsafe.bypassPolicies on type "User" op "read"',
      ),
    ]);
  });

  it('explainPolicies compiles with a READ session and explain metadata', async () => {
    const q = await compile(
      ogm().withContext({ tenantId: 't1' }).model('User'),
    ).explainPolicies({
      where: { id: 'u1' },
    });
    expect(q.accessMode).toBe('READ');
    expect(q.metadata).toMatchObject({ explain: true });
    expect(q.warnings).toEqual([
      expect.stringContaining('explainPolicies on type "User"'),
    ]);
  });
});

describe('compile-only OGM — what it refuses', () => {
  it('a plain model call rejects with an OGMError naming compile()', async () => {
    const o = createCompileOnlyOgm({ typeDefs });
    const err = await o
      .model('User')
      .find()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(main.OGMError);
    expect((err as Error).message).toMatch(/compile\(model\)/);
  });

  it.each([
    ['$queryRaw', (o: OGM) => o.$queryRaw('RETURN 1')],
    ['$executeRaw', (o: OGM) => o.$executeRaw('RETURN 1')],
    ['$transaction', (o: OGM) => o.$transaction(async () => 1)],
    ['$cloneSubgraph', (o: OGM) => o.$cloneSubgraph('x', {} as never)],
    ['$deleteSubgraph', (o: OGM) => o.$deleteSubgraph('x', {} as never)],
    [
      'assertIndexesAndConstraints',
      (o: OGM) => o.assertIndexesAndConstraints({ options: { create: true } }),
    ],
  ])('%s rejects with an OGMError', async (name, run) => {
    const o = createCompileOnlyOgm({ typeDefs });
    for (const target of [o, o.unsafe.bypassPolicies()])
      await expect(run(target)).rejects.toThrow(
        new RegExp(
          `ogm\\.\\${name}\\(\\) is not supported on a compile-only OGM`,
        ),
      );
  });

  it('compile() refuses a model that can reach a database', () => {
    const real = new OGM({ typeDefs, driver: recordingDriver([]) });
    expect(() => compile(real.model('User'))).toThrow(
      /refuses a model that can reach a database/,
    );
    expect(() => compile(real.interfaceModel('Owned'))).toThrow(main.OGMError);
    expect(() => compile({ find: async () => [] })).toThrow(main.OGMError);
  });

  it('createCompileOnlyOgm() refuses a driver or database', () => {
    expect(() =>
      createCompileOnlyOgm({ typeDefs, driver: recordingDriver([]) } as never),
    ).toThrow(/takes no "driver"/);
    expect(() =>
      createCompileOnlyOgm({ typeDefs, database: 'neo4j' } as never),
    ).toThrow(/takes no "database"/);
  });
});

describe('every public Model / InterfaceModel method is compilable or out of scope', () => {
  // Compile-time half: a new public method fails to type-check here until
  // it is added to COMPILABLE_METHODS or to the out-of-scope list.
  type PublicMethods<T> = {
    [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
  }[keyof T];
  type ModelOutOfScope = never;
  type Unlisted =
    | Exclude<PublicMethods<Model>, CompilableMethod | ModelOutOfScope>
    | Exclude<PublicMethods<InterfaceModel>, CompilableMethod>;
  const none: [Unlisted] extends [never] ? true : false = true;

  it('holds at runtime too', () => {
    expect(none).toBe(true);
    const own = (proto: object) =>
      Object.getOwnPropertyNames(proto).filter((n) => {
        const d = Object.getOwnPropertyDescriptor(proto, n);
        return n !== 'constructor' && typeof d?.value === 'function';
      });
    // Every compilable name is a real method of Model.
    for (const name of COMPILABLE_METHODS)
      expect(own(Model.prototype)).toContain(name);
    const im = own(InterfaceModel.prototype);
    for (const name of [
      'find',
      'findFirst',
      'findUnique',
      'findFirstOrThrow',
      'findUniqueOrThrow',
      'count',
      'aggregate',
    ])
      expect(im).toContain(name);
  });
});

describe('normalizeCompiled', () => {
  const base: CompiledQuery = { cypher: '', params: {}, warnings: [] };

  it('turns driver values into snapshot-friendly ones and sorts keys', () => {
    const n = normalizeCompiled({
      ...base,
      cypher: 'MATCH (n)  \nRETURN n ',
      params: {
        z: int(5),
        big: int('9007199254740993'),
        b: 10n,
        d: new Date('2026-01-02T03:04:05.000Z'),
        dt: new DateTime(2026, 1, 2, 3, 4, 5, 0, 0),
        pt: new Point(int(7203), 1, 2),
        list: [int(1), { y: int(2), x: 'a' }],
        a: 'text',
        nil: null,
      },
      metadata: { operation: 'read', policiesEvaluated: ['p'] },
    });
    expect(n.cypher).toBe('MATCH (n)\nRETURN n');
    expect(Object.keys(n.params)).toEqual([
      'a',
      'b',
      'big',
      'd',
      'dt',
      'list',
      'nil',
      'pt',
      'z',
    ]);
    expect(n.params).toEqual({
      a: 'text',
      b: '10',
      big: '9007199254740993',
      d: '2026-01-02T03:04:05.000Z',
      dt: '2026-01-02T03:04:05Z',
      list: [1, { x: 'a', y: 2 }],
      nil: null,
      pt: 'Point{srid=7203, x=1.0, y=2.0}',
      z: 5,
    });
    expect(n.metadata).toEqual({ operation: 'read', policiesEvaluated: ['p'] });
  });

  it('is stable across calls and does not mutate its input', async () => {
    const q = await user().find({
      where: { age_GT: 3 },
      options: { limit: 2 },
    });
    const copy = JSON.parse(JSON.stringify(q));
    expect(normalizeCompiled(q)).toEqual(normalizeCompiled(q));
    expect(JSON.parse(JSON.stringify(q))).toEqual(copy);
    expect(normalizeCompiled(q).params).toEqual({
      options_limit: 2,
      param0: 3,
    });
  });
});

describe('public exports', () => {
  it('main entry and grafeo-ogm/testing export the compile-only API and the regex guard', () => {
    for (const entry of [main, testing] as Array<Record<string, unknown>>) {
      expect(entry.createCompileOnlyOgm).toBe(createCompileOnlyOgm);
      expect(entry.compile).toBe(compile);
      expect(entry.normalizeCompiled).toBe(normalizeCompiled);
      expect(entry.COMPILABLE_METHODS).toBe(COMPILABLE_METHODS);
      expect(entry.assertSafeRegexPattern).toBe(assertSafeRegexPattern);
      expect(typeof entry.isSafeRegexPattern).toBe('function');
    }
  });

  it('isSafeRegexPattern agrees with assertSafeRegexPattern', () => {
    for (const pattern of [
      'abc',
      '^[a-z]+$',
      '(a+)+',
      '.*a.*'.repeat(1),
      'x'.repeat(2000),
    ]) {
      let accepted = true;
      try {
        assertSafeRegexPattern(pattern, 't');
      } catch {
        accepted = false;
      }
      expect(main.isSafeRegexPattern(pattern)).toBe(accepted);
    }
    expect(main.isSafeRegexPattern('(a+)+')).toBe(false);
    expect(main.isSafeRegexPattern('abc')).toBe(true);
  });
});

// --- helpers -----------------------------------------------------------------

function recordingDriver(
  records: Array<{ cypher: string; params: Record<string, unknown> }>,
): import('neo4j-driver').Driver {
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
  } as unknown as import('neo4j-driver').Driver;
}

/** The params object a case passes, captured by running it against a stub. */
function paramsOf(
  run: (m: ReturnType<typeof user>) => Promise<CompiledQuery>,
): unknown {
  let captured: unknown;
  const stub = new Proxy(
    {},
    {
      get: () => (p: unknown) => {
        captured = p;
        return Promise.resolve({} as CompiledQuery);
      },
    },
  );
  void run(stub as ReturnType<typeof user>);
  return captured;
}
