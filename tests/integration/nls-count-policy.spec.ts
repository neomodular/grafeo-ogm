/**
 * Live proof that `count()` enforces the restrictives registered on `count`
 * (v2.12.3). `count()` resolves policies as `aggregate()` does — the type's
 * `aggregate` policies, falling back to `read` — and ANDs every `count`
 * restrictive onto that clause; a `count` permissive grants nothing (2.x).
 *
 * The probe: one type with three nodes (tier 1, 1, 2), a restrictive
 * `{ tier: 1 }` and a match-all permissive, under four policy sets:
 *
 * | set | policies                                                   | find | count (v2.12.1) | count |
 * |-----|------------------------------------------------------------|------|-----------------|-------|
 * | A   | permissive [read] + restrictive [read, count]              | 2    | 2               | 2     |
 * | B   | permissive [read] + restrictive [read, delete, aggregate, count] | 2 | 0            | 0     |
 * | C   | permissive [read] + restrictive [count]                    | 3    | 3               | 2     |
 * | D   | permissive [read, aggregate] + restrictive [read]          | 2    | 3               | 3     |
 *
 * B is the pre-existing "a restrictive that lists `aggregate` claims the
 * count alone" behaviour, unchanged. Each scenario asserts a DATABASE
 * OUTCOME; the mock-driver counterpart is `tests/policy/count-operation.spec.ts`.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId`, every query filters on it, and `afterAll` deletes them.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { PolicyDeniedError } from '../../src/policy/errors';
import {
  permissive,
  restrictive,
  type OperationOrWildcard,
  type PoliciesByModel,
  type ReadOperation,
} from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = `
interface ItCcRes {
  id: ID!
  runId: String
  tier: Int
}
type ItCcDoc implements ItCcRes @node {
  id: ID! @unique
  runId: String
  tier: Int
}
type ItCcMemo implements ItCcRes @node {
  id: ID! @unique
  runId: String
  tier: Int
}
`;

const tier1 = (operations: ReadOperation[], name = 'tier1') =>
  restrictive({ operations, name, when: () => ({ tier: 1 }) });
const allow = (operations: OperationOrWildcard[], name = 'allow') =>
  permissive({ operations, name, when: () => ({}) });

const POLICIES: Record<string, PoliciesByModel> = {
  A: { ItCcDoc: [allow(['read']), tier1(['read', 'count'])] },
  B: {
    ItCcDoc: [allow(['read']), tier1(['read', 'delete', 'aggregate', 'count'])],
  },
  C: { ItCcDoc: [allow(['read']), tier1(['count'])] },
  D: { ItCcDoc: [allow(['read', 'aggregate']), tier1(['read'])] },
  // E: a count permissive grants nothing; the read permissive decides.
  E: {
    ItCcDoc: [
      permissive({
        operations: ['read'],
        name: 'read-tier1',
        when: () => ({ tier: 1 }),
      }),
      allow(['count'], 'count-all'),
    ],
  },
  // F: a count restrictive on an otherwise policy-free type.
  F: { ItCcDoc: [tier1(['count'])] },
  // I: interface — the Doc member has the count-only restrictive (C), the
  // Memo member is read-only.
  I: {
    ItCcDoc: [allow(['read']), tier1(['count'])],
    ItCcMemo: [allow(['read']), tier1(['read'])],
  },
  // J: interface — an interface-level count restrictive reaches every member.
  J: {
    ItCcRes: [tier1(['count'], 'res-tier1')],
    ItCcDoc: [allow(['read'])],
    ItCcMemo: [allow(['read'])],
  },
};

describeLive('NLS `count` restrictives — live Neo4j', () => {
  const runId = `it-count-${randomUUID()}`;
  const id = (suffix: string) => `${runId}-${suffix}`;
  let driver: Driver;
  const ogms: Record<string, OGM> = {};
  const where = { runId };
  const ctx = { uid: 'u1' };

  const doc = (set: string) => ogms[set].withContext(ctx).model('ItCcDoc');
  const res = (set: string) =>
    ogms[set].withContext(ctx).interfaceModel('ItCcRes');

  async function run(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    const session = driver.session();
    try {
      await session.run(cypher, { runId, ...params });
    } finally {
      await session.close();
    }
  }

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    await driver.verifyConnectivity();
    for (const [set, policies] of Object.entries(POLICIES))
      ogms[set] = new OGM({ typeDefs, driver, policies });

    await run(
      `CREATE (:ItCcDoc {id: $d1, runId: $runId, tier: 1})
       CREATE (:ItCcDoc {id: $d2, runId: $runId, tier: 1})
       CREATE (:ItCcDoc {id: $d3, runId: $runId, tier: 2})
       CREATE (:ItCcMemo {id: $m1, runId: $runId, tier: 1})
       CREATE (:ItCcMemo {id: $m2, runId: $runId, tier: 2})`,
      { d1: id('d1'), d2: id('d2'), d3: id('d3'), m1: id('m1'), m2: id('m2') },
    );
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await driver.close();
    }
  });

  describe('Model.count', () => {
    it('A: permissive [read] + restrictive [read, count] → find 2, count 2', async () => {
      expect(await doc('A').find({ where })).toHaveLength(2);
      expect(await doc('A').count({ where })).toBe(2);
    });

    it('B: restrictive [read, delete, aggregate, count] → find 2, count 0 (unchanged)', async () => {
      expect(await doc('B').find({ where })).toHaveLength(2);
      expect(await doc('B').count({ where })).toBe(0);
    });

    it('C: permissive [read] + restrictive [count] → find 3, count 2 (v2.12.1 counted 3)', async () => {
      expect(await doc('C').find({ where })).toHaveLength(3);
      expect(await doc('C').count({ where })).toBe(2);
    });

    it('C: aggregate({ count }) is not narrowed by the count restrictive', async () => {
      const agg = await doc('C').aggregate({
        where,
        aggregate: { count: true },
      });
      expect(agg.count).toBe(3);
    });

    it("C: the read permissive still grants under onDeny 'throw'", async () => {
      const throwing = new OGM({
        typeDefs,
        driver,
        policies: POLICIES.C,
        policyDefaults: { onDeny: 'throw' },
      });
      expect(
        await throwing.withContext(ctx).model('ItCcDoc').count({ where }),
      ).toBe(2);
    });

    it('D: permissive [read, aggregate] + restrictive [read] → find 2, count 3 (unchanged)', async () => {
      expect(await doc('D').find({ where })).toHaveLength(2);
      expect(await doc('D').count({ where })).toBe(3);
    });

    it('E: a count permissive grants nothing; the read permissive decides → find 2, count 2', async () => {
      expect(await doc('E').find({ where })).toHaveLength(2);
      expect(await doc('E').count({ where })).toBe(2);
    });

    it('F: a count restrictive on a policy-free type → find 3, count 2 (v2.12.1 counted 3)', async () => {
      expect(await doc('F').find({ where })).toHaveLength(3);
      expect(await doc('F').count({ where })).toBe(2);
    });

    it('a per-call bypass counts every row', async () => {
      expect(
        await doc('C').count({ where, unsafe: { bypassPolicies: true } }),
      ).toBe(3);
    });

    it("B under onDeny 'throw' still throws PolicyDeniedError(aggregate)", async () => {
      const throwing = new OGM({
        typeDefs,
        driver,
        policies: POLICIES.B,
        policyDefaults: { onDeny: 'throw' },
      });
      await expect(
        throwing.withContext(ctx).model('ItCcDoc').count({ where }),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
    });
  });

  describe('InterfaceModel.count', () => {
    it("I: a member's count restrictive narrows its branch → find 4, count 3 (v2.12.1 counted 4)", async () => {
      expect(await res('I').find({ where })).toHaveLength(4);
      expect(await res('I').count({ where })).toBe(3);
    });

    it('J: an interface-level count restrictive reaches every member → find 5, count 3 (v2.12.1 counted 5)', async () => {
      expect(await res('J').find({ where })).toHaveLength(5);
      expect(await res('J').count({ where })).toBe(3);
    });

    it('J: aggregate({ count }) is not narrowed by the count restrictive', async () => {
      const agg = await res('J').aggregate({
        where,
        aggregate: { count: true },
      });
      expect(agg.count).toBe(5);
    });
  });
});
