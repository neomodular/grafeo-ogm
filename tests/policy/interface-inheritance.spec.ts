import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { override, permissive, restrictive } from '../../src/policy/types';

const schema = `
interface Resource {
  id: ID!
  tenantId: String
}
type Book implements Resource @node(labels: ["Resource", "Book"]) {
  id: ID! @id @unique
  title: String!
  tenantId: String
  ownerId: String
}
type Article implements Resource @node(labels: ["Resource", "Article"]) {
  id: ID! @id @unique
  body: String!
  tenantId: String
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

describe('Interface inheritance', () => {
  it('interface-only policy applies to a concrete model', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Resource: [
          restrictive({
            operations: ['read'],
            when: (c) => ({ tenantId: (c as { tid: string }).tid }),
          }),
          permissive({ operations: ['read'], when: () => ({}) }),
        ],
      },
    });
    await ogm.withContext({ tid: 't1' }).model('Book').find({});
    expect(recorded[0].cypher).toContain('tenantId');
  });

  it('concrete-only policy applies to that concrete model only', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({ ownerId: 'u' }),
          }),
        ],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    expect(recorded[0].cypher).toContain('ownerId');
  });

  it('interface + concrete restrictives AND together', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Resource: [
          permissive({ operations: ['read'], when: () => ({}) }),
          restrictive({
            operations: ['read'],
            when: () => ({ tenantId: 't' }),
          }),
        ],
        Book: [
          restrictive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
        ],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    expect(recorded[0].cypher).toContain('tenantId');
    expect(recorded[0].cypher).toContain('ownerId');
  });

  it('override on concrete bypasses interface policies', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Resource: [
          restrictive({
            operations: ['read'],
            when: () => ({ tenantId: 't' }),
          }),
        ],
        Book: [override({ operations: ['read'], when: () => true })],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    expect(recorded[0].cypher).not.toContain('WHERE');
  });

  it('InterfaceModel.find emits CASE-per-label when concrete policies differ', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Resource: [permissive({ operations: ['read'], when: () => ({}) })],
        Book: [
          permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
        ],
        Article: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm.withContext({}).interfaceModel('Resource').find({});
    // CASE-per-label fragment in the WHERE clause.
    expect(recorded[0].cypher).toContain('CASE');
    expect(recorded[0].cypher).toContain('Book');
    expect(recorded[0].cypher).toContain('Article');
  });

  it('InterfaceModel.find with only interface policies works', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Resource: [
          permissive({ operations: ['read'], when: () => ({ tenantId: 't' }) }),
        ],
      },
    });
    await ogm.withContext({}).interfaceModel('Resource').find({});
    expect(recorded[0].cypher).toContain('tenantId');
  });

  it('concrete policy applies on the concrete model when also implementing interface', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Resource: [
          permissive({ operations: ['read'], when: () => ({ tenantId: 't' }) }),
        ],
        Book: [
          permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
        ],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    // Both fragments should be OR'd in the permissive composition.
    expect(recorded[0].cypher).toContain('tenantId');
    expect(recorded[0].cypher).toContain('ownerId');
    expect(recorded[0].cypher).toContain(' OR ');
  });

  it('interface policy fires on Article too', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Resource: [
          permissive({ operations: ['read'], when: () => ({ tenantId: 't' }) }),
        ],
      },
    });
    await ogm.withContext({}).model('Article').find({});
    expect(recorded[0].cypher).toContain('tenantId');
  });

  it('concrete policy NOT applied on a sibling concrete type', async () => {
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
    await ogm.withContext({}).model('Article').find({});
    expect(recorded[0].cypher).not.toContain('ownerId');
  });

  it('InterfaceModel.aggregate honours composed interface+concrete policies', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Resource: [
          permissive({ operations: ['read'], when: () => ({ tenantId: 't' }) }),
        ],
        Book: [
          permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
        ],
      },
    });
    await ogm
      .withContext({})
      .interfaceModel('Resource')
      .aggregate({ aggregate: { count: true } });
    expect(recorded[0].cypher).toContain('CASE');
    expect(recorded[0].cypher).toContain('count');
  });

  it('warns at OGM init when interface has policies but an implementer does not', () => {
    const warn = jest.fn();
    new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      logger: { debug: () => {}, warn },
      policies: {
        Resource: [
          permissive({ operations: ['read'], when: () => ({ tenantId: 't' }) }),
        ],
        // Book is registered (no warning for it).
        Book: [
          permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
        ],
        // Article is intentionally NOT registered → warning expected.
      },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, typeName, missing] = warn.mock.calls[0];
    expect(message).toContain('interface');
    expect(typeName).toBe('Resource');
    expect(missing).toContain('Article');
  });

  it('does NOT warn when every implementer is registered', () => {
    const warn = jest.fn();
    new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      logger: { debug: () => {}, warn },
      policies: {
        Resource: [
          permissive({ operations: ['read'], when: () => ({ tenantId: 't' }) }),
        ],
        Book: [
          permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
        ],
        Article: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
