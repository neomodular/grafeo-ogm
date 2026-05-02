import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive, restrictive } from '../../src/policy/types';

const schema = `
type Book @node {
  id: ID! @id @unique
  title: String!
  ownerId: String
}
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
  config?: Record<string, unknown>;
}

function createMockDriver(records: Recorded[] = []): Driver {
  const session = {
    run: jest.fn(
      (cypher: string, params: Record<string, unknown>, config?: unknown) => {
        records.push({
          cypher,
          params,
          config: config as Record<string, unknown>,
        });
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
      },
    ),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
}

describe('OGM.withContext + per-call unsafe', () => {
  it('binds ctx onto every model() call from the wrapper', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: (c) => ({ ownerId: (c as { uid: string }).uid }),
          }),
        ],
      },
    });
    await ogm.withContext({ uid: 'alex' }).model('Book').find({});

    expect(recorded[0].cypher).toContain('ownerId');
    expect(Object.values(recorded[0].params)).toContain('alex');
  });

  it('per-call unsafe.bypassPolicies skips the policy', async () => {
    const warnings: string[] = [];
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      logger: {
        debug: () => {},
        warn: (msg: string) => warnings.push(msg),
      },
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({ ownerId: 'u' }),
          }),
        ],
      },
    });

    await ogm
      .withContext({ uid: 'alex' })
      .model('Book')
      .find({ unsafe: { bypassPolicies: true } });

    // Bypass means no WHERE clause — Cypher is a bare MATCH/RETURN.
    expect(recorded[0].cypher).not.toContain('WHERE');
    expect(warnings.some((w) => w.includes('unsafe.bypassPolicies'))).toBe(
      true,
    );
  });

  it('ogm.unsafe.bypassPolicies returns a non-policy-aware OGM', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
        ],
      },
    });
    const bypassed = ogm.unsafe.bypassPolicies();
    await bypassed.model('Book').find({});
    expect(recorded[0].cypher).not.toContain('WHERE');
  });

  it('ogm.unsafe.bypassPolicies logs a warning', () => {
    const warnings: string[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      logger: {
        debug: () => {},
        warn: (msg: string) => warnings.push(msg),
      },
    });
    ogm.unsafe.bypassPolicies();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('bypassPolicies');
  });

  it('withContext returns a wrapper distinct from the parent OGM', () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
    });
    const wrapped = ogm.withContext({ uid: 'a' });
    expect(wrapped).not.toBe(ogm);
  });

  it('withContext models without registered policies emit byte-identical Cypher', async () => {
    const a: Recorded[] = [];
    const b: Recorded[] = [];
    const ogm1 = new OGM({ typeDefs: schema, driver: createMockDriver(a) });
    const ogm2 = new OGM({ typeDefs: schema, driver: createMockDriver(b) });
    await ogm1.model('Book').find({ where: { id: 'x' } });
    await ogm2
      .withContext({ uid: 'u' })
      .model('Book')
      .find({ where: { id: 'x' } });
    expect(a[0].cypher).toBe(b[0].cypher);
  });

  it('withContext freezes ctx — mutating after-the-fact does not leak', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: (c) => ({ ownerId: (c as { uid: string }).uid }),
          }),
        ],
      },
    });
    const ctx = { uid: 'alex' };
    const wrapped = ogm.withContext(ctx);
    ctx.uid = 'mutated';
    await wrapped.model('Book').find({});
    expect(Object.values(recorded[0].params)).toContain('alex');
    expect(Object.values(recorded[0].params)).not.toContain('mutated');
  });

  it('throws when withContext is given a non-object', () => {
    const ogm = new OGM({ typeDefs: schema, driver: createMockDriver() });
    // @ts-expect-error — runtime validation.
    expect(() => ogm.withContext(null)).toThrow();
    // @ts-expect-error — runtime validation.
    expect(() => ogm.withContext('hi')).toThrow();
  });

  it('per-call unsafe.bypassPolicies on a non-policy OGM is a no-op', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
    });
    await ogm.model('Book').find({ unsafe: { bypassPolicies: true } });
    expect(recorded.length).toBe(1);
  });

  it('default-deny throw mode raises PolicyDeniedError', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policyDefaults: { onDeny: 'throw' },
      policies: {
        Book: [
          // No permissive — every call falls into default-deny.
          restrictive({ operations: ['read'], when: () => ({ ownerId: 'x' }) }),
        ],
      },
    });
    await expect(
      ogm.withContext({ uid: 'a' }).model('Book').find({}),
    ).rejects.toThrow(/no-permissive-matched/);
  });
});
