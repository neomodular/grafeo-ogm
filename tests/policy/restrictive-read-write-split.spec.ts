/**
 * C1 fix — Read/Write restrictive policy split.
 *
 * The dual-invocation contract bug in earlier 1.7.0-beta.0 iterations
 * caused user-supplied `when(ctx, input) => boolean` callbacks to be
 * called twice per write operation: once at the application layer with
 * `(ctx, input)`, then a second time at the where-compile layer with
 * `(ctx)` only. Side-effecting callbacks fired inconsistently and any
 * predicate that legitimately depended on `input` returned `false` at
 * the where-compile layer (no input → undefined access) → `WHERE false`
 * → all reads silently blocked.
 *
 * Fix: restrictives are now a discriminated union over `operations`.
 *  - `ReadRestrictive` (read|delete|aggregate|count): `when(ctx)`
 *  - `WriteRestrictive` (create|update): `when(ctx, input)`
 * The two never share an `operations` array, and the WHERE compiler
 * only consumes ReadRestrictives. Application-layer guards only consume
 * WriteRestrictives.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';
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

describe('Read/Write restrictive split — C1 contract', () => {
  // -------------------------------------------------------------------
  // Behavioral test #1
  //
  // A user writing `(ctx, input) => input.tenantId === ctx.tenantId` on
  // a WriteRestrictive must NOT block reads. Reads don't invoke
  // WriteRestrictives at all, so the where compiler never sees this
  // predicate.
  //
  // (Pre-fix bug: the where compiler invoked `when(ctx)` with `input`
  // undefined, returning false, AND-stitching `WHERE false` into the
  // user's read query.)
  // -------------------------------------------------------------------
  it('WriteRestrictive on update does not block reads', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          // Read access — anyone with a tenant can read.
          permissive({ operations: ['read'], when: () => ({}) }),
          // Read access — anyone with a tenant can update.
          permissive({ operations: ['update'], when: () => ({}) }),
          // Write-side WITH CHECK: input must declare the user's tenant.
          // The pre-fix where compiler would have called this with
          // input === undefined and returned false, blocking reads.
          restrictive({
            operations: ['update'],
            when: (ctx, input) =>
              (input as { tenantId?: string }).tenantId ===
              (ctx as { tenantId?: string }).tenantId,
          }),
        ],
      },
    });

    // Read should succeed and emit Cypher (no `WHERE false`).
    await ogm.withContext({ tenantId: 'acme' }).model('Book').find({});
    expect(recorded).toHaveLength(1);
    expect(recorded[0].cypher).not.toContain('WHERE false');
    // The compiled WHERE clause must not reference `n.tenantId` —
    // that would mean the WriteRestrictive's predicate leaked into
    // the read query (the pre-fix dual-call bug). The selection's
    // RETURN ... .tenantId projection is fine; we assert on the
    // WHERE body only.
    const whereBody = recorded[0].cypher.match(/WHERE([\s\S]*?)RETURN/)?.[1];
    expect(whereBody).toBeDefined();
    expect(whereBody).not.toContain('tenantId');
  });

  // -------------------------------------------------------------------
  // Behavioral test #2
  //
  // A side-effecting WriteRestrictive (uses a `captures` array) is
  // invoked exactly once per `create` and once per `update`, never on
  // `read` or `delete`.
  // -------------------------------------------------------------------
  it('side-effecting WriteRestrictive fires exactly once per write op (and never on read/delete)', async () => {
    const captures: Array<{ op: string; ctx: unknown; input: unknown }> = [];
    const recorded: Recorded[] = [];

    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({ operations: ['read'], when: () => ({}) }),
          permissive({ operations: ['create'], when: () => ({}) }),
          permissive({ operations: ['update'], when: () => ({}) }),
          permissive({ operations: ['delete'], when: () => ({}) }),
          restrictive({
            operations: ['create'],
            when: (ctx, input) => {
              captures.push({ op: 'create', ctx, input });
              return true;
            },
          }),
          restrictive({
            operations: ['update'],
            when: (ctx, input) => {
              captures.push({ op: 'update', ctx, input });
              return true;
            },
          }),
        ],
      },
    });

    const ctx = { uid: 'u1' };
    const m = ogm.withContext(ctx).model('Book');

    // create — should fire the create restrictive ONCE.
    await m.create({ input: [{ id: 'b1', title: 't1' }] });
    expect(captures.filter((c) => c.op === 'create')).toHaveLength(1);
    expect(captures[0]).toEqual({
      op: 'create',
      ctx,
      input: { id: 'b1', title: 't1' },
    });

    // read — restrictives MUST NOT fire.
    await m.find({});
    expect(captures.filter((c) => c.op === 'read')).toHaveLength(0);

    // update — should fire the update restrictive ONCE.
    await m.update({ where: { id: 'b1' }, update: { title: 't2' } });
    const updates = captures.filter((c) => c.op === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      op: 'update',
      ctx,
      input: { title: 't2' },
    });

    // delete — restrictives MUST NOT fire (deletes have no input).
    await m.delete({ where: { id: 'b1' } });
    expect(captures.filter((c) => c.op === 'delete')).toHaveLength(0);

    // Total captures: 1 create + 1 update = 2. Nothing else.
    expect(captures).toHaveLength(2);
  });

  // -------------------------------------------------------------------
  // Behavioral test #3
  //
  // The constructor throws OGMError when given mixed
  // `operations: ['read', 'create']`. This is the runtime guard; the
  // type system also catches it via @ts-expect-error in
  // tests/policy/types.spec.ts.
  // -------------------------------------------------------------------
  it('constructor throws OGMError on mixed read+create operations', () => {
    expect(() =>
      // @ts-expect-error — discriminated union forbids mixed ops at compile time.
      restrictive({
        operations: ['read', 'create'],
        when: () => true,
      }),
    ).toThrow(OGMError);
  });

  // -------------------------------------------------------------------
  // Bonus: verify the WHERE-side ReadRestrictive is invoked exactly
  // once per read query and receives only `(ctx)`.
  // -------------------------------------------------------------------
  it('ReadRestrictive `when` is invoked exactly once per read with `(ctx)` only', async () => {
    const calls: unknown[][] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [
          permissive({ operations: ['read'], when: () => ({}) }),
          restrictive({
            operations: ['read'],
            when: (...args) => {
              calls.push(args);
              return { ownerId: 'u' };
            },
          }),
        ],
      },
    });

    await ogm.withContext({ uid: 'u1' }).model('Book').find({});
    expect(calls).toHaveLength(1);
    // Single argument — `(ctx)`. No second `input` arg leaks in.
    expect(calls[0]).toHaveLength(1);
    expect(calls[0][0]).toEqual({ uid: 'u1' });
  });

  // -------------------------------------------------------------------
  // Bonus: verify a WriteRestrictive on `create` does not interfere
  // with reads even when no read permissive is registered. (Default-
  // deny on read still fires; the WriteRestrictive must not be the
  // source of the deny.)
  // -------------------------------------------------------------------
  it('WriteRestrictive on create does not contribute to read default-deny', async () => {
    const calls: unknown[][] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(),
      policies: {
        Book: [
          permissive({ operations: ['read'], when: () => ({}) }),
          restrictive({
            operations: ['create'],
            when: (...args) => {
              calls.push(args);
              return true;
            },
          }),
        ],
      },
    });

    // The create-side restrictive must NEVER be invoked on a read.
    await ogm.withContext({}).model('Book').find({});
    expect(calls).toHaveLength(0);
  });
});
