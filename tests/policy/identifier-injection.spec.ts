import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';
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

describe('Identifier injection — policy where-partial validation', () => {
  it('rejects unsafe key in permissive where partial', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({ ['ownerId; DROP TABLE Book; --']: 'x' }),
          }),
        ],
      },
    });
    await expect(
      ogm.withContext({}).model('Book').find({}),
    ).rejects.toBeInstanceOf(OGMError);
  });

  it('rejects __proto__ in permissive where partial', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({ ['__proto__']: 'x' }),
          }),
        ],
      },
    });
    await expect(
      ogm.withContext({}).model('Book').find({}),
    ).rejects.toBeInstanceOf(OGMError);
  });

  it('rejects "constructor" in permissive where partial', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({ ['constructor']: 'x' }),
          }),
        ],
      },
    });
    await expect(
      ogm.withContext({}).model('Book').find({}),
    ).rejects.toBeInstanceOf(OGMError);
  });

  it('rejects unsafe key in restrictive where partial', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [
          permissive({ operations: ['read'], when: () => ({}) }),
          restrictive({
            operations: ['read'],
            when: () => ({ ['bad; DROP--']: 'x' }),
          }),
        ],
      },
    });
    await expect(
      ogm.withContext({}).model('Book').find({}),
    ).rejects.toBeInstanceOf(OGMError);
  });

  it('rejects unsafe identifier in cypher.params key', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            cypher: {
              fragment: () => 'true',
              params: () => ({ ['bad name']: 1 }),
            },
          }),
        ],
      },
    });
    await expect(
      ogm.withContext({}).model('Book').find({}),
    ).rejects.toBeInstanceOf(OGMError);
  });
});
