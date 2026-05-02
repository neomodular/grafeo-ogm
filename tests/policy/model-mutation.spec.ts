import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { PolicyDeniedError } from '../../src/policy/errors';
import { permissive, restrictive } from '../../src/policy/types';

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

describe('Model mutations — policy integration', () => {
  it('update injects policy where', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['update'],
            when: (c) => ({ ownerId: (c as { uid: string }).uid }),
          }),
        ],
      },
    });
    await ogm
      .withContext({ uid: 'u1' })
      .model('Book')
      .update({ where: { id: 'b1' }, update: { title: 'New' } });
    expect(recorded[0].cypher).toContain('ownerId');
  });

  it('updateMany injects policy where', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['update'],
            when: () => ({ ownerId: 'u' }),
          }),
        ],
      },
    });
    await ogm
      .withContext({})
      .model('Book')
      .updateMany({ where: {}, data: { title: 'X' } });
    expect(recorded[0].cypher).toContain('ownerId');
  });

  it('delete injects policy where', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['delete'],
            when: () => ({ ownerId: 'u' }),
          }),
        ],
      },
    });
    await ogm
      .withContext({})
      .model('Book')
      .delete({ where: { id: 'b1' } });
    expect(recorded[0].cypher).toContain('ownerId');
  });

  it('deleteMany injects policy where', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['delete'],
            when: () => ({ ownerId: 'u' }),
          }),
        ],
      },
    });
    await ogm.withContext({}).model('Book').deleteMany({});
    expect(recorded[0].cypher).toContain('ownerId');
  });

  it('create denies when no permissive matches', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [
          // Only a restrictive — no permissive → default-deny on create.
          restrictive({
            operations: ['create'],
            when: () => true,
          }),
        ],
      },
    });
    await expect(
      ogm
        .withContext({})
        .model('Book')
        .create({ input: [{ id: 'b1', title: 'x' }] }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('create succeeds when permissive matches', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [permissive({ operations: ['create'], when: () => ({}) })],
      },
    });
    await ogm
      .withContext({})
      .model('Book')
      .create({ input: [{ id: 'b1', title: 'x' }] });
    expect(recorded.length).toBe(1);
  });

  it('createMany denies when restrictive rejects an input', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [
          permissive({ operations: ['create'], when: () => ({}) }),
          restrictive({
            operations: ['create'],
            when: (_ctx, input) =>
              Boolean(input && (input as { ownerId?: string }).ownerId),
          }),
        ],
      },
    });
    await expect(
      ogm
        .withContext({})
        .model('Book')
        .createMany({ data: [{ id: 'b1', title: 'x' }] }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('createMany passes when every input satisfies restrictive', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({ operations: ['create'], when: () => ({}) }),
          restrictive({
            operations: ['create'],
            when: (_ctx, input) =>
              Boolean(input && (input as { ownerId?: string }).ownerId),
          }),
        ],
      },
    });
    await ogm
      .withContext({})
      .model('Book')
      .createMany({ data: [{ id: 'b1', title: 'x', ownerId: 'a' }] });
    expect(recorded.length).toBe(1);
  });

  it('upsert denies when create policy has no permissive', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [
          permissive({ operations: ['update'], when: () => ({}) }),
          // Restrictive on create with no permissive → default-deny.
          restrictive({ operations: ['create'], when: () => true }),
        ],
      },
    });
    await expect(
      ogm
        .withContext({})
        .model('Book')
        .upsert({
          where: { id: 'b1' },
          create: { id: 'b1', title: 'x' },
          update: { title: 'y' },
        }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('upsert allows when both create and update permit', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({ operations: ['update'], when: () => ({}) }),
          permissive({ operations: ['create'], when: () => ({}) }),
        ],
      },
    });
    await ogm
      .withContext({})
      .model('Book')
      .upsert({
        where: { id: 'b1' },
        create: { id: 'b1', title: 'x' },
        update: { title: 'y' },
      });
    expect(recorded.length).toBe(1);
  });

  it('setLabels injects update policy where', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['update'],
            when: () => ({ ownerId: 'u' }),
          }),
        ],
      },
    });
    await ogm
      .withContext({})
      .model('Book')
      .setLabels({ where: { id: 'b1' }, addLabels: ['Archived'] });
    expect(recorded[0].cypher).toContain('ownerId');
  });

  it('per-call unsafe bypasses mutation policy', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['update'],
            when: () => ({ ownerId: 'u' }),
          }),
        ],
      },
    });
    await ogm
      .withContext({})
      .model('Book')
      .update({
        where: { id: 'b1' },
        update: { title: 'X' },
        unsafe: { bypassPolicies: true },
      });
    expect(recorded[0].cypher).not.toContain('ownerId');
  });

  it('default-deny throw on update raises PolicyDeniedError before compile', async () => {
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policyDefaults: { onDeny: 'throw' },
      policies: {
        // Write-side restrictive — `when` returns boolean. Default-deny
        // fires because no permissive applies to the 'update' op.
        Book: [
          restrictive({
            operations: ['update'],
            when: () => true,
          }),
        ],
      },
    });
    await expect(
      ogm
        .withContext({})
        .model('Book')
        .update({ where: { id: 'b1' }, update: { title: 'x' } }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  // C1 fix: WriteRestrictive `when` is invoked EXACTLY ONCE at the
  // application layer with `(ctx, input)`. It is NOT invoked again at
  // the where-compile layer (where it would receive no input and could
  // return a misleading verdict). This contract eliminates the dual-
  // invocation bug present in earlier 1.7.0-beta.0 iterations.
  it('WriteRestrictive `when(ctx, input)` runs exactly once on update with the input bag', async () => {
    const captures: Array<{ ctx: unknown; input: unknown }> = [];
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({ operations: ['update'], when: () => ({}) }),
          restrictive({
            operations: ['update'],
            when: (ctx, input) => {
              captures.push({ ctx, input });
              return true;
            },
          }),
        ],
      },
    });
    await ogm
      .withContext({ uid: 'u1' })
      .model('Book')
      .update({ where: { id: 'b1' }, update: { title: 'X' } });
    expect(captures).toHaveLength(1);
    expect(captures[0]).toEqual({
      ctx: { uid: 'u1' },
      input: { title: 'X' },
    });
  });
});
