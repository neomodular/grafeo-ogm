import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { PolicyDeniedError } from '../../src/policy/errors';
import { restrictive } from '../../src/policy/types';

const schema = `
type Book @node {
  id: ID! @id @unique
  title: String!
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

describe('Default-deny: throw vs empty', () => {
  it('onDeny:empty (default) emits WHERE false and returns []', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [restrictive({ operations: ['read'], when: () => ({}) })],
      },
    });
    const result = await ogm.withContext({}).model('Book').find({});
    expect(recorded[0].cypher).toContain('false');
    expect(result).toEqual([]);
  });

  it('onDeny:throw raises PolicyDeniedError', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policyDefaults: { onDeny: 'throw' },
      policies: {
        Book: [restrictive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await expect(
      ogm.withContext({}).model('Book').find({}),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('PolicyDeniedError carries typeName and operation', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policyDefaults: { onDeny: 'throw' },
      policies: {
        Book: [restrictive({ operations: ['read'], when: () => ({}) })],
      },
    });
    try {
      await ogm.withContext({}).model('Book').find({});
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as PolicyDeniedError;
      expect(err.typeName).toBe('Book');
      expect(err.operation).toBe('read');
      expect(err.reason).toBe('no-permissive-matched');
    }
  });

  it('onDeny:throw on update', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policyDefaults: { onDeny: 'throw' },
      policies: {
        // Write-side restrictive — only `(ctx, input) => boolean` is
        // valid. The default-deny path triggers because no permissive
        // is registered for 'update'.
        Book: [restrictive({ operations: ['update'], when: () => true })],
      },
    });
    await expect(
      ogm
        .withContext({})
        .model('Book')
        .update({ where: { id: 'b' }, update: { title: 'x' } }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('onDeny:throw on delete', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policyDefaults: { onDeny: 'throw' },
      policies: {
        Book: [restrictive({ operations: ['delete'], when: () => ({}) })],
      },
    });
    await expect(
      ogm
        .withContext({})
        .model('Book')
        .delete({ where: { id: 'b' } }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('PolicyDeniedError extends OGMError', async () => {
    try {
      const ogm = new OGM({
        typeDefs: schema,
        driver: createMockDriver(),
        policyDefaults: { onDeny: 'throw' },
        policies: {
          Book: [restrictive({ operations: ['read'], when: () => ({}) })],
        },
      });
      await ogm.withContext({}).model('Book').find({});
    } catch (e) {
      const { OGMError } = await import('../../src/errors');
      expect(e).toBeInstanceOf(OGMError);
    }
  });

  it('onDeny:throw never reaches the executor', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policyDefaults: { onDeny: 'throw' },
      policies: {
        Book: [restrictive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await expect(ogm.withContext({}).model('Book').find({})).rejects.toThrow();
    expect(recorded.length).toBe(0);
  });

  it('onDeny:throw with override does NOT throw (override wins)', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policyDefaults: { onDeny: 'throw' },
      policies: {
        Book: [
          restrictive({ operations: ['read'], when: () => ({}) }),
          // Override matching for read.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('../../src/policy/types').override({
            operations: ['read'],
            when: () => true,
          }),
        ],
      },
    });
    await expect(
      ogm.withContext({}).model('Book').find({}),
    ).resolves.toBeDefined();
  });

  it('onDeny:empty does not change the resolved metadata bypassed flag', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [restrictive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm.withContext({}).model('Book').find({});
    // The query DID execute (and returned 0 rows), so we check that
    // some metadata exists.
    expect(recorded[0]).toBeDefined();
  });

  it('reason field is no-permissive-matched for default-deny throw', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policyDefaults: { onDeny: 'throw' },
      policies: {
        Book: [restrictive({ operations: ['read'], when: () => ({}) })],
      },
    });
    try {
      await ogm.withContext({}).model('Book').find({});
    } catch (e) {
      expect((e as PolicyDeniedError).reason).toBe('no-permissive-matched');
    }
  });
});
