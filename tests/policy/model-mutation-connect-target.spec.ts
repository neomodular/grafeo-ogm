import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

/**
 * Regression suite for the connect/disconnect TARGET-type policy bypass
 * (CWE-285). Pre-fix, `Model.update`'s connect/disconnect emitted a
 * `MATCH (target:<Label>)` carrying ONLY the user's `where` and NO policy,
 * so a caller whose SOURCE node was correctly policy-filtered could still
 * link/unlink relationships to target nodes the target type's `read`
 * policy should forbid (broken object-level authorization on relationship
 * writes).
 *
 * The fix threads the caller's policy bundle + shared param counter into
 * the MutationCompiler and AND-stitches the TARGET type's `read` policy
 * into every connect/disconnect target MATCH — mirroring the read paths
 * (`WhereCompiler`/`SelectionCompiler`).
 */

const schema = `
type User @node {
  id: ID! @id @unique
  name: String
  ownedBooks: [Book!]! @relationship(type: "OWNS", direction: OUT)
}

type Book @node {
  id: ID! @id @unique
  title: String!
  ownerId: String
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

/** OGM with a SOURCE update policy and a TARGET read policy filtered by ctx. */
function policyOgm(recorded: Recorded[]): OGM {
  return new OGM({
    typeDefs: schema,
    driver: createMockDriver(recorded),
    policies: {
      // Source: match-all so the update proceeds and the policy machinery
      // is activated (a null source bundle would skip target enforcement,
      // exactly as the read paths do).
      User: [permissive({ operations: ['update'], when: () => ({}) })],
      // Target: restrict Books to the caller's own ownerId on READ.
      Book: [
        permissive({
          operations: ['read'],
          when: (c) => ({ ownerId: (c as { uid: string }).uid }),
        }),
      ],
    },
  });
}

describe('Model mutations — connect/disconnect TARGET policy (CWE-285)', () => {
  it('connect target MATCH carries the target type read policy predicate', async () => {
    const recorded: Recorded[] = [];
    await policyOgm(recorded)
      .withContext({ uid: 'u1' })
      .model('User')
      .update({
        where: { id: 'me' },
        connect: { ownedBooks: { where: { id: 'b1' } } },
      });

    const { cypher, params } = recorded[0];
    // The connect target is MATCHed by Book label...
    expect(cypher).toContain('MATCH (target:');
    // ...and its WHERE now AND-stitches the Book `read` policy predicate.
    expect(cypher).toContain('target.`ownerId` = $param2');
    // v2.3.0 — the user's own connect filter is compiled by WhereCompiler
    // and draws from the SAME shared counter as the policy predicate, so
    // the two can never collide (filter first, then policy).
    expect(cypher).toContain('target.`id` = $param1');
    expect(params.param2).toBe('u1');
    expect(params.param1).toBe('b1');
  });

  it('disconnect target MATCH carries the target type read policy predicate', async () => {
    const recorded: Recorded[] = [];
    await policyOgm(recorded)
      .withContext({ uid: 'u1' })
      .model('User')
      .update({
        where: { id: 'me' },
        disconnect: { ownedBooks: { where: { id: 'b1' } } },
      });

    const { cypher, params } = recorded[0];
    expect(cypher).toContain('target_ownedBooks_0.`ownerId` = $param2');
    expect(cypher).toContain('target_ownedBooks_0.`id` = $param1');
    expect(params.param2).toBe('u1');
  });

  it('nested connect (inside update body) carries the target policy predicate', async () => {
    const recorded: Recorded[] = [];
    await policyOgm(recorded)
      .withContext({ uid: 'u1' })
      .model('User')
      .update({
        where: { id: 'me' },
        update: { ownedBooks: [{ connect: { where: { id: 'b1' } } }] },
      });

    const { cypher } = recorded[0];
    // Nested connect target var is `n_conn0`; its WHERE carries the policy.
    expect(cypher).toContain('.`ownerId` = $param2');
    expect(cypher).toMatch(/MATCH \(n_conn0:/);
  });

  it('enforces the target READ policy, not an update/write policy', async () => {
    // A Book policy registered ONLY on `update` must NOT be stitched into
    // the connect target MATCH — target row-visibility is gated by `read`.
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        User: [permissive({ operations: ['update'], when: () => ({}) })],
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
      .model('User')
      .update({
        where: { id: 'me' },
        connect: { ownedBooks: { where: { id: 'b1' } } },
      });

    const { cypher, params } = recorded[0];
    // No `read` policy on Book → no target predicate and no policy value
    // bound (the only param<N> is the user's own connect filter).
    expect(cypher).not.toContain('target.`ownerId`');
    expect(Object.values(params)).not.toContain('u1');
    expect(params.param1).toBe('b1');
  });

  it('no target policy → no target predicate and no policy params', async () => {
    // Source has an update policy but Book has NO policy: the connect
    // target MATCH carries only the user's own filter.
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recorded),
      policies: {
        User: [permissive({ operations: ['update'], when: () => ({}) })],
      },
    });
    await ogm
      .withContext({ uid: 'u1' })
      .model('User')
      .update({
        where: { id: 'me' },
        connect: { ownedBooks: { where: { id: 'b1' } } },
      });

    const { cypher, params } = recorded[0];
    expect(cypher).not.toContain('target.`ownerId`');
    expect(Object.values(params)).not.toContain('u1');
  });

  it('no policies at all → connect Cypher is byte-identical to a bypassed policy OGM', async () => {
    // Baseline: an OGM with no policies whatsoever.
    const recNo: Recorded[] = [];
    const ogmNo = new OGM({
      typeDefs: schema,
      driver: createMockDriver(recNo),
    });
    await ogmNo.model('User').update({
      where: { id: 'me' },
      connect: { ownedBooks: { where: { id: 'b1' } } },
    });

    // Same operation on a fully-policied OGM but with the bypass escape
    // hatch active — must emit byte-identical Cypher.
    const recBypass: Recorded[] = [];
    await policyOgm(recBypass)
      .withContext({ uid: 'u1' })
      .model('User')
      .update({
        where: { id: 'me' },
        connect: { ownedBooks: { where: { id: 'b1' } } },
        unsafe: { bypassPolicies: true },
      });

    expect(recBypass[0].cypher).toBe(recNo[0].cypher);
    expect(recNo[0].cypher).not.toContain('target.`ownerId`');
  });
});
