/**
 * `count()` enforces the restrictives registered on `count` (v2.12.3).
 *
 * `count()` resolves policies exactly as `aggregate()` does — the type's
 * `aggregate` policies, falling back to `read` — and, since v2.12.3, ANDs
 * every restrictive that matches `count` onto that clause. A restrictive
 * already applied through the resolved operation is not added twice, a
 * `count` permissive grants nothing (2.x; the OGM warns once), and policy
 * sets without a count-only restrictive compile byte-identically to v2.12.1.
 *
 * Pre-2.12.3 a `restrictive({ operations: ['count'] })` was never enforced.
 * The goldens below were captured from the v2.12.1 compiler (17c8341); the
 * live counterpart is `tests/integration/nls-count-policy.spec.ts`.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { PolicyDeniedError } from '../../src/policy/errors';
import {
  override,
  permissive,
  restrictive,
  type OperationOrWildcard,
  type PoliciesByModel,
  type PolicyDefaults,
  type ReadOperation,
} from '../../src/policy/types';

const typeDefs = `
type CcDoc @node {
  id: ID! @unique
  tier: Int
}
interface CcRes {
  id: ID!
  tier: Int
}
type CcA implements CcRes @node {
  id: ID! @unique
  tier: Int
}
type CcB implements CcRes @node {
  id: ID! @unique
  tier: Int
}
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
  metadata: Record<string, unknown> | undefined;
}

function setup(
  policies: PoliciesByModel,
  options: { policyDefaults?: PolicyDefaults; logger?: boolean } = {},
) {
  const recorded: Recorded[] = [];
  const session = {
    run: jest.fn(
      (
        cypher: string,
        params: Record<string, unknown>,
        config?: { metadata?: Record<string, unknown> },
      ) => {
        recorded.push({ cypher, params, metadata: config?.metadata });
        return Promise.resolve({ records: [] });
      },
    ),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const warn = jest.fn();
  const ogm = new OGM({
    typeDefs,
    driver: {
      session: jest.fn().mockReturnValue(session),
    } as unknown as Driver,
    policies,
    ...(options.policyDefaults
      ? { policyDefaults: options.policyDefaults }
      : {}),
    ...(options.logger ? { logger: { debug: jest.fn(), warn } } : {}),
  });
  /** Run `fn`, returning the one statement it sent (result mapping may throw on the empty mock). */
  const capture = async (fn: () => Promise<unknown>): Promise<Recorded> => {
    recorded.length = 0;
    await fn().catch(() => undefined);
    expect(recorded).toHaveLength(1);
    return recorded[0];
  };
  return { ogm, bound: ogm.withContext({ uid: 'u1' }), capture, warn };
}

/** The `WHERE` line of a statement, `''` when there is none. */
function whereOf({ cypher }: Recorded): string {
  const line = cypher.split('\n').find((l) => l.startsWith('WHERE '));
  return line ? line.slice('WHERE '.length) : '';
}

const tier1 = (operations: ReadOperation[], name = 'tier1') =>
  restrictive({ operations, name, when: () => ({ tier: 1 }) });
const allow = (operations: OperationOrWildcard[], name = 'allow') =>
  permissive({ operations, name, when: () => ({}) });

const TIER = '(true AND (n.`tier` = $param0))';

// The coordinator's probe: CcDoc with 3 nodes (tier 1, 1, 2), `tier1`
// restrictive, `allow` permissive. `find` / `count` are the row counts the
// live suite asserts; `main` is the v2.12.1 Cypher.
const CASES = {
  // A: the count restrictive is the read one — already applied, not added twice.
  A: { CcDoc: [allow(['read']), tier1(['read', 'count'])] },
  // B: the restrictive claims `aggregate`, so count resolves it alone:
  // default-deny (pre-existing, unchanged).
  B: {
    CcDoc: [allow(['read']), tier1(['read', 'delete', 'aggregate', 'count'])],
  },
  // C: the bug — a count-only restrictive.
  C: { CcDoc: [allow(['read']), tier1(['count'])] },
  // D: an aggregate permissive; no count restrictive.
  D: { CcDoc: [allow(['read', 'aggregate']), tier1(['read'])] },
} satisfies Record<string, PoliciesByModel>;

describe('Model.count — the probe cases, byte-identical to v2.12.1 except C', () => {
  it('A: permissive [read] + restrictive [read, count] → unchanged', async () => {
    const { bound, capture } = setup(CASES.A);
    const count = await capture(() => bound.model('CcDoc').count());
    expect(whereOf(count)).toBe(TIER);
    expect(count.params).toEqual({ param0: 1 });
    expect(count.metadata).toMatchObject({
      operation: 'aggregate',
      policiesEvaluated: ['allow', 'tier1'],
    });
  });

  it('B: restrictive [read, delete, aggregate, count] claims aggregate → default-deny, unchanged', async () => {
    const { bound, capture } = setup(CASES.B);
    const count = await capture(() => bound.model('CcDoc').count());
    expect(whereOf(count)).toBe('false');
    expect(count.metadata).toMatchObject({ policiesEvaluated: ['tier1'] });
    const find = await capture(() => bound.model('CcDoc').find());
    expect(whereOf(find)).toBe(TIER);

    const throwing = setup(CASES.B, { policyDefaults: { onDeny: 'throw' } });
    await expect(throwing.bound.model('CcDoc').count()).rejects.toMatchObject({
      name: 'PolicyDeniedError',
      typeName: 'CcDoc',
      operation: 'aggregate',
    });
  });

  it('C: permissive [read] + restrictive [count] → the count restrictive is ANDed in (v2.12.1: `WHERE true`)', async () => {
    const { bound, capture } = setup(CASES.C);
    const count = await capture(() => bound.model('CcDoc').count());
    expect(whereOf(count)).toBe(TIER);
    expect(count.params).toEqual({ param0: 1 });
    expect(count.metadata).toMatchObject({
      modelType: 'CcDoc',
      operation: 'aggregate',
      policiesEvaluated: ['allow', 'tier1'],
    });

    // `read` and `aggregate` do not see it.
    const find = await capture(() => bound.model('CcDoc').find());
    expect(whereOf(find)).toBe('true');
    expect(find.metadata).toMatchObject({ policiesEvaluated: ['allow'] });
    const aggregate = await capture(() =>
      bound.model('CcDoc').aggregate({ aggregate: { count: true } }),
    );
    expect(whereOf(aggregate)).toBe('true');

    // The permissive still grants, so `onDeny: 'throw'` does not fire.
    const throwing = setup(CASES.C, { policyDefaults: { onDeny: 'throw' } });
    const strictCount = await throwing.capture(() =>
      throwing.bound.model('CcDoc').count(),
    );
    expect(whereOf(strictCount)).toBe(TIER);
  });

  it('D: permissive [read, aggregate] + restrictive [read] → unchanged', async () => {
    const { bound, capture } = setup(CASES.D);
    const count = await capture(() => bound.model('CcDoc').count());
    expect(whereOf(count)).toBe('true');
    expect(count.params).toEqual({});
    expect(count.metadata).toMatchObject({ policiesEvaluated: ['allow'] });
    const find = await capture(() => bound.model('CcDoc').find());
    expect(whereOf(find)).toBe(TIER);
  });
});

describe('Model.count — count restrictives', () => {
  it('a type whose only policy is a count restrictive counts the rows it admits (v2.12.1: no WHERE)', async () => {
    const { bound, capture } = setup({ CcDoc: [tier1(['count'])] });
    const count = await capture(() => bound.model('CcDoc').count());
    expect(whereOf(count)).toBe(TIER);
    expect(count.metadata).toMatchObject({ policiesEvaluated: ['tier1'] });
    const find = await capture(() => bound.model('CcDoc').find());
    expect(whereOf(find)).toBe('');
  });

  it('a count restrictive composes with the user where and other read restrictives', async () => {
    const { bound, capture } = setup({
      CcDoc: [
        allow(['read']),
        restrictive({
          operations: ['read'],
          name: 'has-id',
          when: () => ({ id_NOT: null }),
        }),
        tier1(['count']),
      ],
    });
    const count = await capture(() =>
      bound.model('CcDoc').count({ where: { id: 'd1' } }),
    );
    expect(whereOf(count)).toBe(
      '(n.`id` = $param0) AND (true AND (n.`id` IS NOT NULL) AND (n.`tier` = $param1))',
    );
    expect(count.params).toEqual({ param0: 'd1', param1: 1 });
    expect(count.metadata).toMatchObject({
      policiesEvaluated: ['allow', 'has-id', 'tier1'],
    });
  });

  it('a count restrictive gated off by appliesWhen is not applied nor listed', async () => {
    const { bound, capture } = setup({
      CcDoc: [
        allow(['read']),
        restrictive({
          operations: ['count'],
          name: 'gated',
          appliesWhen: () => false,
          when: () => ({ tier: 1 }),
        }),
      ],
    });
    const count = await capture(() => bound.model('CcDoc').count());
    expect(whereOf(count)).toBe('true');
    expect(count.metadata).toMatchObject({ policiesEvaluated: ['allow'] });
  });

  it('a count restrictive hard deny (`when: () => false`) counts nothing', async () => {
    const { bound, capture } = setup({
      CcDoc: [
        allow(['read']),
        restrictive({ operations: ['count'], name: 'deny', when: () => false }),
      ],
    });
    const count = await capture(() => bound.model('CcDoc').count());
    expect(whereOf(count)).toBe('(true AND false)');
  });

  it('a firing override on the resolved operation lifts the whole count, as before', async () => {
    const { bound, capture } = setup({
      CcDoc: [
        override({ operations: ['read'], name: 'admin', when: () => true }),
        tier1(['count']),
      ],
    });
    const count = await capture(() => bound.model('CcDoc').count());
    expect(whereOf(count)).toBe('');
    expect(count.metadata).toMatchObject({ policiesEvaluated: ['admin'] });
  });

  it('a wildcard override lifts the count restrictives too', async () => {
    const { bound, capture } = setup({
      CcDoc: [
        override({ operations: ['*'], name: 'admin', when: () => true }),
        tier1(['count']),
      ],
    });
    const count = await capture(() => bound.model('CcDoc').count());
    expect(whereOf(count)).toBe('');
  });

  it('an override on `count` lifts the count restrictives and leaves the resolved clause', async () => {
    const { bound, capture } = setup({
      CcDoc: [
        override({
          operations: ['count'],
          name: 'count-admin',
          when: () => true,
        }),
        allow(['read']),
        tier1(['count']),
      ],
    });
    const count = await capture(() => bound.model('CcDoc').count());
    expect(whereOf(count)).toBe('true');
    expect(count.metadata).toMatchObject({ policiesEvaluated: ['allow'] });
  });

  it('a per-call bypass compiles the policy-free statement', async () => {
    const { bound, capture } = setup(CASES.C);
    const count = await capture(() =>
      bound.model('CcDoc').count({ unsafe: { bypassPolicies: true } }),
    );
    expect(whereOf(count)).toBe('');
  });
});

describe('Model.count — count permissives grant nothing in 2.x', () => {
  const E: PoliciesByModel = {
    CcDoc: [
      permissive({
        operations: ['read'],
        name: 'read-tier1',
        when: () => ({ tier: 1 }),
      }),
      allow(['count'], 'count-all'),
    ],
  };

  it('count() uses the read permissive; the count permissive is ignored (byte-identical to v2.12.1)', async () => {
    const { bound, capture } = setup(E);
    const count = await capture(() => bound.model('CcDoc').count());
    expect(whereOf(count)).toBe('(n.`tier` = $param0)');
    expect(count.params).toEqual({ param0: 1 });
    expect(count.metadata).toMatchObject({ policiesEvaluated: ['read-tier1'] });
  });

  it('the OGM warns once per count-only permissive at construction', async () => {
    const { bound, warn } = setup(E, { logger: true });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('"count-all"');
    expect(message).toContain('"CcDoc"');
    expect(message).toMatch(/grants nothing/);
    // A limitation strict mode does not change: the notice names no switch.
    expect(message).not.toMatch(/strict: true|strict mode/);
    await bound
      .model('CcDoc')
      .count()
      .catch(() => undefined);
    await bound
      .model('CcDoc')
      .count()
      .catch(() => undefined);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a permissive that also lists read, aggregate or `*` takes part through that operation and does not warn', () => {
    const { warn } = setup(
      {
        CcDoc: [
          allow(['read', 'count'], 'rc'),
          allow(['aggregate', 'count'], 'ac'),
          allow(['*'], 'all'),
        ],
        CcA: [allow(['count', 'delete'], 'cd')],
      },
      { logger: true },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('"cd"');
  });

  it('a count-only restrictive does not warn', () => {
    const { warn } = setup(CASES.C, { logger: true });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('InterfaceModel.count — per implementer', () => {
  const IFACE = {
    // I: CcA has the count-only restrictive (case C); CcB is read-only.
    I: {
      CcA: [allow(['read']), tier1(['count'])],
      CcB: [allow(['read']), tier1(['read'])],
    },
    // J: an interface-level count restrictive reaches every implementer.
    J: {
      CcRes: [tier1(['count'], 'res-tier1')],
      CcA: [allow(['read'])],
      CcB: [allow(['read'])],
    },
    // K: the count restrictive is the read one on both members (case A).
    K: {
      CcA: [allow(['read']), tier1(['read', 'count'])],
      CcB: [allow(['read']), tier1(['read', 'count'])],
    },
  } satisfies Record<string, PoliciesByModel>;

  it("I: a member's count restrictive is ANDed onto its branch; the other member falls back to read", async () => {
    const { bound, capture } = setup(IFACE.I);
    const count = await capture(() => bound.interfaceModel('CcRes').count());
    expect(whereOf(count)).toBe(
      '((n:`CcA` OR n:`CcB`) AND (NOT n:`CcA` OR (true AND (n.`tier` = $param0))) AND (NOT n:`CcB` OR (true AND (n.`tier` = $param1))))',
    );
    expect(count.params).toEqual({ param0: 1, param1: 1 });
    expect(count.metadata).toMatchObject({
      modelType: 'CcRes',
      operation: 'aggregate',
    });
    // v2.12.1 golden for the same policies: the CcA branch was `true`.
    const find = await capture(() => bound.interfaceModel('CcRes').find());
    expect(whereOf(find)).toBe(
      '((n:`CcA` OR n:`CcB`) AND (NOT n:`CcA` OR true) AND (NOT n:`CcB` OR (true AND (n.`tier` = $param0))))',
    );
    const aggregate = await capture(() =>
      bound.interfaceModel('CcRes').aggregate({ aggregate: { count: true } }),
    );
    expect(whereOf(aggregate)).toBe(whereOf(find));
  });

  it('J: an interface-level count restrictive is ANDed onto every branch; audit metadata unchanged', async () => {
    const { bound, capture } = setup(IFACE.J);
    const count = await capture(() => bound.interfaceModel('CcRes').count());
    expect(whereOf(count)).toBe(
      '((n:`CcA` OR n:`CcB`) AND (NOT n:`CcA` OR (true AND (n.`tier` = $param0))) AND (NOT n:`CcB` OR (true AND (n.`tier` = $param1))))',
    );
    expect(count.params).toEqual({ param0: 1, param1: 1 });
    // InterfaceModel audit metadata is unchanged from v2.12.2: it lists the
    // interface's own resolved policies, not the count restrictives the
    // member branches apply.
    expect(count.metadata).toMatchObject({ policiesEvaluated: [] });
    const find = await capture(() => bound.interfaceModel('CcRes').find());
    expect(whereOf(find)).toBe(
      '((n:`CcA` OR n:`CcB`) AND (NOT n:`CcA` OR true) AND (NOT n:`CcB` OR true))',
    );
    expect(find.metadata).toMatchObject({ policiesEvaluated: [] });
  });

  it('K: restrictive [read, count] on both members → unchanged', async () => {
    const { bound, capture } = setup(IFACE.K);
    const count = await capture(() => bound.interfaceModel('CcRes').count());
    expect(whereOf(count)).toBe(
      '((n:`CcA` OR n:`CcB`) AND (NOT n:`CcA` OR (true AND (n.`tier` = $param0))) AND (NOT n:`CcB` OR (true AND (n.`tier` = $param1))))',
    );
    expect(count.params).toEqual({ param0: 1, param1: 1 });
    expect(count.metadata).toMatchObject({ policiesEvaluated: [] });
    const find = await capture(() => bound.interfaceModel('CcRes').find());
    expect(whereOf(find)).toBe(whereOf(count));
  });

  it("a member's count permissive grants nothing (byte-identical to v2.12.1)", async () => {
    const { bound, capture } = setup({
      CcA: [
        permissive({
          operations: ['read'],
          name: 'a-tier1',
          when: () => ({ tier: 1 }),
        }),
        allow(['count'], 'a-count-all'),
      ],
      CcB: [allow(['read'])],
    });
    const count = await capture(() => bound.interfaceModel('CcRes').count());
    expect(whereOf(count)).toBe(
      '((n:`CcA` OR n:`CcB`) AND (NOT n:`CcA` OR (n.`tier` = $param0)) AND (NOT n:`CcB` OR true))',
    );
  });

  it("onDeny 'throw' is decided by the aggregate / read grants, as before", async () => {
    const throwing = setup(IFACE.I, { policyDefaults: { onDeny: 'throw' } });
    const count = await throwing.capture(() =>
      throwing.bound.interfaceModel('CcRes').count(),
    );
    expect(whereOf(count)).toContain('n.`tier`');
    const denied = setup(
      { CcA: [tier1(['read'])], CcB: [tier1(['read'])] },
      { policyDefaults: { onDeny: 'throw' } },
    );
    await expect(
      denied.bound.interfaceModel('CcRes').count(),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });
});
