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

describe('Escape-hatch logging', () => {
  it('logger.warn fires when ogm.unsafe.bypassPolicies() is called', () => {
    const warns: string[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      logger: {
        debug: () => {},
        warn: (msg: string) => warns.push(msg),
      },
    });
    ogm.unsafe.bypassPolicies();
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('bypassPolicies');
  });

  it('logger.warn fires on every per-call unsafe.bypassPolicies', async () => {
    const warns: string[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      logger: {
        debug: () => {},
        warn: (msg: string) => warns.push(msg),
      },
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm
      .withContext({})
      .model('Book')
      .find({ unsafe: { bypassPolicies: true } });
    expect(warns.some((w) => w.includes('unsafe.bypassPolicies'))).toBe(true);
  });

  it('logger.warn does NOT fire on normal queries', async () => {
    const warns: string[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      logger: {
        debug: () => {},
        warn: (msg: string) => warns.push(msg),
      },
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    expect(warns.length).toBe(0);
  });

  it('logger.warn does NOT fire when no logger is provided', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    // Should not throw or crash.
    await expect(
      ogm
        .withContext({})
        .model('Book')
        .find({ unsafe: { bypassPolicies: true } }),
    ).resolves.toBeDefined();
  });

  it('warn message includes type and operation context', async () => {
    const warns: string[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      logger: {
        debug: () => {},
        warn: (msg: string, ...args: unknown[]) =>
          warns.push(`${msg}|${args.join('|')}`),
      },
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm
      .withContext({})
      .model('Book')
      .find({ unsafe: { bypassPolicies: true } });
    const found = warns.find((w) => w.includes('Book') && w.includes('read'));
    expect(found).toBeDefined();
  });
});
