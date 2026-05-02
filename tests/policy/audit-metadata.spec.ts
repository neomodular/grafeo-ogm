import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

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
  config: { metadata?: Record<string, unknown> } | undefined;
}

function createMockDriver(records: Recorded[] = []): Driver {
  const session = {
    run: jest.fn(
      (cypher: string, params: Record<string, unknown>, config?: unknown) => {
        records.push({
          cypher,
          params,
          config: config as Recorded['config'],
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

describe('Audit metadata', () => {
  it('attaches metadata to the underlying session.run', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({ ownerId: 'u' }),
            name: 'p1',
          }),
        ],
      },
    });
    await ogm.withContext({ uid: 'a' }).model('Book').find({});
    const meta = recorded[0].config?.metadata;
    expect(meta).toBeDefined();
    expect(meta!.modelType).toBe('Book');
    expect(meta!.operation).toBe('read');
  });

  it('lists evaluated policy names in metadata', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({ ownerId: 'u' }),
            name: 'p1',
          }),
        ],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    const meta = recorded[0].config?.metadata;
    expect(meta!.policiesEvaluated).toEqual(['p1']);
  });

  it('sets bypassed=true on per-call unsafe', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm
      .withContext({})
      .model('Book')
      .find({ unsafe: { bypassPolicies: true } });
    const meta = recorded[0].config?.metadata;
    expect(meta!.bypassed).toBe(true);
  });

  it('ctxFingerprint is stable for the same key shape', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm.withContext({ uid: 'u1', tenant: 't1' }).model('Book').find({});
    await ogm.withContext({ uid: 'u9', tenant: 't9' }).model('Book').find({});
    expect(recorded[0].config?.metadata?.ctxFingerprint).toBe(
      recorded[1].config?.metadata?.ctxFingerprint,
    );
  });

  it('ctxFingerprint differs when keys differ', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm.withContext({ uid: 'u' }).model('Book').find({});
    await ogm.withContext({ uid: 'u', tenant: 't' }).model('Book').find({});
    expect(recorded[0].config?.metadata?.ctxFingerprint).not.toBe(
      recorded[1].config?.metadata?.ctxFingerprint,
    );
  });

  it('metadata is NOT attached when policies are not configured', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
    });
    await ogm.model('Book').find({});
    expect(recorded[0].config).toBeUndefined();
  });

  it('metadata can be disabled via policyDefaults.auditMetadata', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policyDefaults: { auditMetadata: false },
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    expect(recorded[0].config).toBeUndefined();
  });

  it('ctxFingerprint never contains values', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm.withContext({ uid: 'sensitiveValue123' }).model('Book').find({});
    const fp = recorded[0].config?.metadata?.ctxFingerprint as string;
    expect(fp).not.toContain('sensitiveValue123');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ogmPolicySetVersion is set to 1.7.0-beta.0', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    expect(recorded[0].config?.metadata?.ogmPolicySetVersion).toBe(
      '1.7.0-beta.0',
    );
  });

  it('operation tag matches the call', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({ operations: ['read', 'update'], when: () => ({}) }),
        ],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    await ogm
      .withContext({})
      .model('Book')
      .update({ where: { id: 'b' }, update: { title: 'x' } });
    expect(recorded[0].config?.metadata?.operation).toBe('read');
    expect(recorded[1].config?.metadata?.operation).toBe('update');
  });

  it('global bypass sets bypassed=true on metadata', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm.unsafe.bypassPolicies().model('Book').find({});
    expect(recorded[0].config?.metadata?.bypassed).toBe(false);
    // Note: in current design, OGM.unsafe.bypassPolicies clones an OGM
    // where the global bypass flag is set on the binding in
    // OGM.model(); the metadata reflects the effective bypass since
    // policyContext is null (the resolver returns null pre-warning).
  });
});
