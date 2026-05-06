/**
 * v1.8.2 SECURITY REGRESSION TESTS
 *
 * Pre-1.8.2, when a Permissive policy's `when(ctx)` callback returned
 * `null`/`undefined` OR its `cypher.fragment(ctx)` returned `''`, the
 * permissive contributed no fragment to `permFrags`. If EVERY registered
 * permissive abstained (an extremely natural pattern when guarding by
 * ctx fields), `permFrags` ended up empty and the compiler emitted
 *
 *     WHERE true
 *
 * — silently inverting the deny default. The query then returned the
 * full table to whoever issued the request.
 *
 * The TypeScript surface for `when` returns `W extends Record<string, unknown>`
 * which technically blocks nullish returns at compile time. But the
 * runtime defensively accepts them — and JavaScript callers, looser
 * tsconfigs, type assertions, and config loaded from external sources
 * all bypass the static gate. The runtime path is the one that matters.
 *
 * `cypher.fragment` returning `''` is type-clean (`string` includes ''),
 * so that path was always reachable without bypassing TS.
 *
 * Permissives are an ALLOW-LIST. If no rule fires, access is DENIED.
 * v1.8.2 makes the empty-permFrags case emit `false` so the query
 * returns no rows. Migration: developers who genuinely want
 * "match anything" must write `when: () => ({})` (empty partial)
 * rather than `when: () => null`.
 *
 * These tests pin the new behaviour down so it cannot regress silently.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
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

// Type-erasure helper: lets us simulate the runtime case where a JS
// caller (or a typescript caller using a wider/erased type) returns
// `null`/`undefined` from `when(ctx)`. The runtime defensively handles
// these values; pre-1.8.2 it did so by silently dropping the
// permissive's contribution to permFrags.
const nullishWhen = (() => null) as unknown as () => Record<string, unknown>;
const undefinedWhen = (() => undefined) as unknown as () => Record<
  string,
  unknown
>;

describe('v1.8.2 — Permissive abstain → default deny', () => {
  it('single permissive when() returns null → emits WHERE false (not true)', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: nullishWhen,
          }),
        ],
      },
    });

    const result = await ogm
      .withContext({ userId: undefined })
      .model('Book')
      .find({});

    // Pre-1.8.2 emitted `WHERE true` here — wide-open query
    expect(recorded[0].cypher).not.toMatch(/WHERE\s+true\s*RETURN/);
    expect(recorded[0].cypher).toContain('false');
    expect(result).toEqual([]);
  });

  it('single permissive when() returns undefined → emits WHERE false', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: undefinedWhen,
          }),
        ],
      },
    });

    await ogm.withContext({}).model('Book').find({});

    expect(recorded[0].cypher).not.toMatch(/WHERE\s+true\s*RETURN/);
    expect(recorded[0].cypher).toContain('false');
  });

  it('single permissive cypher.fragment returns "" → emits WHERE false', async () => {
    // This case is type-clean — `string` includes the empty string.
    // No casts needed; pre-1.8.2 leaked here without any TS bypass.
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            cypher: {
              fragment: () => '',
              params: () => ({}),
            },
          }),
        ],
      },
    });

    await ogm.withContext({}).model('Book').find({});

    expect(recorded[0].cypher).not.toMatch(/WHERE\s+true\s*RETURN/);
    expect(recorded[0].cypher).toContain('false');
  });

  it('multiple permissives, ALL abstain → emits WHERE false', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({ operations: ['read'], when: nullishWhen }),
          permissive({ operations: ['read'], when: nullishWhen }),
          permissive({ operations: ['read'], when: undefinedWhen }),
        ],
      },
    });

    await ogm.withContext({}).model('Book').find({});

    expect(recorded[0].cypher).not.toMatch(/WHERE\s+true\s*RETURN/);
    expect(recorded[0].cypher).toContain('false');
  });

  it('multiple permissives, ONE grants → query is restricted by the granting one', async () => {
    const recorded: Recorded[] = [];
    const conditionalGrant = ((ctx: { userId?: string }) =>
      ctx.userId ? { ownerId: ctx.userId } : null) as unknown as (ctx: {
      userId?: string;
    }) => Record<string, unknown>;

    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({ operations: ['read'], when: nullishWhen }),
          permissive({
            operations: ['read'],
            when: conditionalGrant,
          }),
          permissive({ operations: ['read'], when: nullishWhen }),
        ],
      },
    });

    await ogm.withContext({ userId: 'alice' }).model('Book').find({});

    // The granting permissive contributed `n.ownerId = $...`
    expect(recorded[0].cypher).toContain('`ownerId`');
    expect(recorded[0].cypher).not.toMatch(/\(false\)/);
    expect(Object.values(recorded[0].params)).toContain('alice');
  });

  it('explicit empty partial `when: () => ({})` STILL emits WHERE true (preserved behaviour)', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({}),
          }),
        ],
      },
    });

    await ogm.withContext({}).model('Book').find({});

    // The migration path: developers who want allow-all use `() => ({})`
    // which is treated as match-anything (`true`). This MUST keep working.
    expect(recorded[0].cypher).toMatch(/WHERE\s+true\s*RETURN/);
  });

  it('the granting branch of a conditional when() still works correctly', async () => {
    // Real-world pattern: `(ctx) => ctx.userId ? { ownerId: ctx.userId } : null`
    const recorded: Recorded[] = [];
    const conditionalGrant = ((ctx: { userId?: string }) =>
      ctx.userId ? { ownerId: ctx.userId } : null) as unknown as (ctx: {
      userId?: string;
    }) => Record<string, unknown>;

    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: conditionalGrant,
          }),
        ],
      },
    });

    // With ctx that triggers the grant branch
    await ogm.withContext({ userId: 'alice' }).model('Book').find({});
    expect(recorded[0].cypher).toContain('`ownerId`');
    expect(Object.values(recorded[0].params)).toContain('alice');

    recorded.length = 0;

    // With ctx that triggers the abstain branch — pre-1.8.2 leaked here
    await ogm.withContext({}).model('Book').find({});
    expect(recorded[0].cypher).not.toMatch(/WHERE\s+true\s*RETURN/);
    expect(recorded[0].cypher).toContain('false');
  });

  it('abstaining permissive + restrictive → DENY wins (does not allow via restrictive=true)', async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        Book: [
          permissive({ operations: ['read'], when: nullishWhen }),
          restrictive({ operations: ['read'], when: () => ({}) }),
        ],
      },
    });

    await ogm.withContext({}).model('Book').find({});

    // Even though the restrictive returned `{}` (match-anything),
    // the absence of a granting permissive denies the whole query.
    expect(recorded[0].cypher).toContain('false');
  });
});
