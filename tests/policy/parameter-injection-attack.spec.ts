import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';
import { permissive } from '../../src/policy/types';

const schema = `
type Book @node {
  id: ID! @id @unique
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

describe('Parameter injection attack surface', () => {
  it('ctx values flow as params, never interpolated', async () => {
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
    await ogm.withContext({ uid: "x' OR '1'='1" }).model('Book').find({});
    // The malicious value lives in params, not in the Cypher text.
    expect(recorded[0].cypher).not.toContain("OR '1'='1");
    expect(Object.values(recorded[0].params)).toContain("x' OR '1'='1");
  });

  it('ctx with prototype-pollution keys is rejected when the partial uses them', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: (c) => {
              // The attacker tries to inject a prototype pollution key
              // by reading from ctx — the WhereCompiler must reject.
              return { ['__proto__']: (c as { x: string }).x };
            },
          }),
        ],
      },
    });
    await expect(
      ogm.withContext({ x: 'evil' }).model('Book').find({}),
    ).rejects.toBeInstanceOf(OGMError);
  });

  it('large ctx value flows as a single param (no Cypher bloat)', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: (c) => ({ ownerId: (c as { huge: string }).huge }),
          }),
        ],
      },
    });
    const huge = 'A'.repeat(1024);
    await ogm.withContext({ huge }).model('Book').find({});
    expect(recorded[0].cypher.length).toBeLessThan(200);
    expect(Object.values(recorded[0].params)).toContain(huge);
  });

  it('ctx value with backticks is parameterized (not interpolated)', async () => {
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
    await ogm.withContext({ uid: '`evil`' }).model('Book').find({});
    expect(recorded[0].cypher).not.toContain('`evil`');
    expect(Object.values(recorded[0].params)).toContain('`evil`');
  });

  it('user-supplied where keys are still validated (existing path)', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await expect(
      ogm
        .withContext({})
        .model('Book')
        .find({ where: { 'bad name': 'x' } as Record<string, unknown> }),
    ).rejects.toBeInstanceOf(OGMError);
  });
});
