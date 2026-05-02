import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { override, permissive, restrictive } from '../../src/policy/types';

const schema = `
type Book @node {
  id: ID! @id @unique
  title: String!
  ownerId: String
  tenantId: String
}
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
  config?: unknown;
}

function createMockDriver(records: Recorded[] = []): Driver {
  const session = {
    run: jest.fn(
      (cypher: string, params: Record<string, unknown>, config?: unknown) => {
        records.push({ cypher, params, config });
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

describe('Model.find — policy integration', () => {
  it('emits a permissive predicate in WHERE', async () => {
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
    await ogm.withContext({ uid: 'u1' }).model('Book').find({});
    expect(recorded[0].cypher).toContain('ownerId');
  });

  it('AND-combines permissive with user where', async () => {
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
    await ogm
      .withContext({ uid: 'u1' })
      .model('Book')
      .find({ where: { id: 'b1' } });
    expect(recorded[0].cypher).toMatch(/n\.`id` = .* AND/);
    expect(recorded[0].cypher).toContain('ownerId');
  });

  it('emits restrictive AND', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({ operations: ['read'], when: () => ({}) }),
          restrictive({
            operations: ['read'],
            when: (c) => ({ tenantId: (c as { tid: string }).tid }),
          }),
        ],
      },
    });
    await ogm.withContext({ tid: 't1' }).model('Book').find({});
    expect(recorded[0].cypher).toContain('tenantId');
  });

  it('default-deny: no permissive emits WHERE false', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          restrictive({
            operations: ['read'],
            when: () => ({ tenantId: 't' }),
          }),
        ],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    expect(recorded[0].cypher).toContain('false');
  });

  it('override emits no policy clause', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          override({ operations: ['read'], when: () => true }),
          permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
        ],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    // No WHERE clause when overridden — RETURN may still project the field.
    expect(recorded[0].cypher).not.toContain('WHERE');
  });

  it('findFirst applies policy via find', async () => {
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
    await ogm.withContext({}).model('Book').findFirst({});
    expect(recorded[0].cypher).toContain('ownerId');
    expect(recorded[0].cypher).toContain('LIMIT');
  });

  it('findUnique routes through findFirst', async () => {
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
    await ogm
      .withContext({})
      .model('Book')
      .findUnique({ where: { id: 'x' } });
    expect(recorded[0].cypher).toContain('ownerId');
  });

  it('count uses aggregate (which falls back to read policies)', async () => {
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
    await ogm.withContext({}).model('Book').count({});
    expect(recorded[0].cypher).toContain('count(n)');
    expect(recorded[0].cypher).toContain('ownerId');
  });

  it('aggregate uses aggregate-specific policy when registered', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({ ownerId: 'r-only' }),
          }),
          permissive({
            operations: ['aggregate'],
            when: () => ({ tenantId: 'agg-only' }),
          }),
        ],
      },
    });
    await ogm
      .withContext({})
      .model('Book')
      .aggregate({ aggregate: { count: true } });
    // The aggregate policy uses tenantId; the read policy uses ownerId.
    // Aggregate-specific policy should take precedence when present.
    expect(recorded[0].cypher).toContain('tenantId');
    expect(recorded[0].cypher).not.toContain('ownerId');
    expect(Object.values(recorded[0].params)).toContain('agg-only');
  });

  it('without ctx → no policies applied (model() not via wrapper)', async () => {
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
    await ogm.model('Book').find({});
    // No WHERE clause without ctx (no withContext) means no policy applied.
    expect(recorded[0].cypher).not.toContain('WHERE');
  });

  it('per-call unsafe bypasses policy on find', async () => {
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
    await ogm
      .withContext({})
      .model('Book')
      .find({ unsafe: { bypassPolicies: true } });
    expect(recorded[0].cypher).not.toContain('WHERE');
  });

  it('search by vector applies read policy', async () => {
    const recorded: Recorded[] = [];
    const vectorSchema = `
type Doc @node @vector(indexes: [{ indexName: "DocEmbedding", queryName: "qDoc", embeddingProperty: "embedding" }]) {
  id: ID! @id @unique
  embedding: [Float!]
  ownerId: String
}
`;
    const ogm = new OGM({
      typeDefs: vectorSchema,
      driver: createMockDriver(recorded),
      policies: {
        Doc: [
          permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
        ],
      },
    });
    await ogm
      .withContext({})
      .model('Doc')
      .searchByVector({ indexName: 'DocEmbedding', vector: [0, 0, 0], k: 5 });
    expect(recorded[0].cypher).toContain('ownerId');
  });

  it('byte-identical Cypher when withContext called but no policy registered for type', async () => {
    const a: Recorded[] = [];
    const b: Recorded[] = [];
    const ogm1 = new OGM({ typeDefs: schema, driver: createMockDriver(a) });
    const ogm2 = new OGM({
      typeDefs: schema,
      driver: createMockDriver(b),
      policies: {},
    });
    await ogm1.model('Book').find({ where: { id: 'b1' } });
    await ogm2
      .withContext({ uid: 'u' })
      .model('Book')
      .find({ where: { id: 'b1' } });
    expect(a[0].cypher).toBe(b[0].cypher);
  });

  it('byte-identical Cypher when override matches', async () => {
    const a: Recorded[] = [];
    const b: Recorded[] = [];
    const ogm1 = new OGM({ typeDefs: schema, driver: createMockDriver(a) });
    const ogm2 = new OGM({
      typeDefs: schema,
      driver: createMockDriver(b),
      policies: {
        Book: [
          override({ operations: ['read'], when: () => true }),
          permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
        ],
      },
    });
    await ogm1.model('Book').find({ where: { id: 'b1' } });
    await ogm2
      .withContext({})
      .model('Book')
      .find({ where: { id: 'b1' } });
    expect(a[0].cypher).toBe(b[0].cypher);
  });
});
