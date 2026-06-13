import { Driver } from 'neo4j-driver';
import { OGMError } from '../../src/errors';
import { InterfaceModel } from '../../src/interface-model';
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

  it('deep-freezes nested ctx — policy callbacks cannot escalate shared state (v1.8.7)', async () => {
    // Pre-1.8.7 `withContext` shallow-froze the ctx spread, so a policy
    // callback could `ctx.user.roles.push('admin')` and every subsequent
    // policy decision in the same request saw the escalated context.
    const recorded: Recorded[] = [];
    let captured: unknown;
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: (c) => {
              captured = c;
              return { ownerId: (c as { uid: string }).uid };
            },
          }),
        ],
      },
    });

    const original = { uid: 'alex', user: { roles: ['viewer'] } };
    await ogm.withContext(original).model('Book').find({});

    // Nested state inside the snapshot is frozen all the way down…
    const snapshot = captured as { user: { roles: string[] } };
    expect(Object.isFrozen(snapshot.user)).toBe(true);
    expect(Object.isFrozen(snapshot.user.roles)).toBe(true);
    expect(() => {
      snapshot.user.roles.push('admin');
    }).toThrow(TypeError);

    // …while the caller's ORIGINAL objects stay untouched and mutable
    // (the snapshot clones; it does not freeze shared references).
    expect(Object.isFrozen(original.user)).toBe(false);
    original.user.roles.push('editor');
    expect(original.user.roles).toContain('editor');
  });
});

// v1.8.7 — the context wrapper kept the pre-1.8.3 interface fallthrough
// that the base OGM.model() already fixed: an interface name returned an
// InterfaceModel cast to `any`, so the first mutation call from typed
// code crashed with `TypeError: this.create is not a function`. The
// wrapper now enforces the same contract in BOTH directions.
describe('OGMWithContext.model/interfaceModel type-contract guard (v1.8.7)', () => {
  const interfaceSchema = `
    interface Entity {
      id: ID!
    }
    type Book implements Entity @node {
      id: ID! @id @unique
      title: String!
      ownerId: String
    }
  `;

  function buildWrapper() {
    const ogm = new OGM({
      typeDefs: interfaceSchema,
      driver: createMockDriver(),
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    return ogm.withContext({ uid: 'alex' });
  }

  it('model(interfaceName) throws OGMError naming the correct API', () => {
    const wrapper = buildWrapper();
    expect(() => wrapper.model('Entity')).toThrow(OGMError);
    expect(() => wrapper.model('Entity')).toThrow(
      /"Entity" is an interface, not a node type/,
    );
    expect(() => wrapper.model('Entity')).toThrow(/interfaceModel\('Entity'\)/);
  });

  it('interfaceModel(nodeName) throws instead of returning a type-lying Model', () => {
    const wrapper = buildWrapper();
    expect(() => wrapper.interfaceModel('Book')).toThrow(
      /Unknown interface type: Book/,
    );
  });

  it('interfaceModel(interfaceName) constructs and caches the InterfaceModel', () => {
    const wrapper = buildWrapper();
    const first = wrapper.interfaceModel('Entity');
    expect(first).toBeInstanceOf(InterfaceModel);
    // Cache hit — the pre-1.8.7 delegation through model() is gone, so
    // the wrapper must own its own construction + caching path.
    expect(wrapper.interfaceModel('Entity')).toBe(first);
  });

  it('model(unknownName) keeps the descriptive unknown-type error', () => {
    const wrapper = buildWrapper();
    expect(() => wrapper.model('Nope')).toThrow(
      'Unknown type: Nope. Not found in nodes or interfaces.',
    );
  });
});
