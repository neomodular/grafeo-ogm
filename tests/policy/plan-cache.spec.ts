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

describe('Plan cache / structural Cypher stability', () => {
  it('same ctx-shape with different values produces structurally identical Cypher', async () => {
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
    await ogm.withContext({ uid: 'u9' }).model('Book').find({});
    expect(recorded[0].cypher).toBe(recorded[1].cypher);
  });

  it('different param values do not affect the emitted Cypher', async () => {
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
      .withContext({ uid: 'aaa' })
      .model('Book')
      .find({ where: { id: 'b1' } });
    await ogm
      .withContext({ uid: 'bbb' })
      .model('Book')
      .find({ where: { id: 'b2' } });
    expect(recorded[0].cypher).toBe(recorded[1].cypher);
  });

  it('different ctx-shape MAY produce different Cypher (appliesWhen drops policies)', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            appliesWhen: (c) => Boolean((c as { extraKey?: boolean }).extraKey),
            when: () => ({ ownerId: 'u' }),
          }),
        ],
      },
    });
    await ogm.withContext({ uid: 'u1' }).model('Book').find({});
    await ogm.withContext({ uid: 'u1', extraKey: true }).model('Book').find({});
    expect(recorded[0].cypher).not.toBe(recorded[1].cypher);
  });

  it('appliesWhen=false drops the permissive entirely', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            appliesWhen: () => false,
            when: () => ({ ownerId: 'u' }),
          }),
        ],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    expect(recorded[0].cypher).toContain('false');
  });

  it('repeating identical calls produces identical params keys', async () => {
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
    await ogm.withContext({}).model('Book').find({});
    expect(Object.keys(recorded[0].params).sort()).toEqual(
      Object.keys(recorded[1].params).sort(),
    );
  });

  it('user where + same policy produces deterministic param ordering', async () => {
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
    await ogm
      .withContext({})
      .model('Book')
      .find({ where: { id: 'b1' } });
    await ogm
      .withContext({})
      .model('Book')
      .find({ where: { id: 'b2' } });
    expect(recorded[0].cypher).toBe(recorded[1].cypher);
    expect(Object.keys(recorded[0].params)).toEqual(
      Object.keys(recorded[1].params),
    );
  });

  it('two different operations produce different Cypher even with same ctx', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read', 'update'],
            when: () => ({ ownerId: 'u' }),
          }),
        ],
      },
    });
    await ogm
      .withContext({})
      .model('Book')
      .find({ where: { id: 'b' } });
    await ogm
      .withContext({})
      .model('Book')
      .update({ where: { id: 'b' }, update: { title: 'x' } });
    expect(recorded[0].cypher).not.toBe(recorded[1].cypher);
  });
});
