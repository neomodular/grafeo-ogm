import { Driver, Integer } from 'neo4j-driver';
import { OGMError } from '../../src/errors';
import { OGM } from '../../src/ogm';
import { PolicyDeniedError } from '../../src/policy/errors';
import {
  override,
  permissive,
  restrictive,
  type PoliciesByModel,
  type PolicyDefaults,
} from '../../src/policy/types';

const schema = `
interface Resource {
  id: ID!
  tenantId: String
}
type Chart implements Resource @node(labels: ["Resource", "Chart"]) {
  id: ID! @id @unique
  tenantId: String
  ownerId: String
  active: Boolean
  weightZone: String
  valid: Boolean
  riskScore: Int
    @cypher(statement: "RETURN size(this.id) AS riskScore", columnName: "riskScore")
  tiers: [Tier!]! @relationship(type: "IN_TIER", direction: OUT)
}
type Tier @node {
  id: ID! @id @unique
  name: String
}
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
  config?: { metadata?: Record<string, unknown> };
}

type Row = Record<string, unknown>;

function fakeRecord(row: Row) {
  return {
    keys: Object.keys(row),
    get: (key: string) => row[key],
    toObject: () => row,
  };
}

/** A row as Neo4j would return it for an explain query. */
function row(node: Row, outcomes: unknown[], visible: boolean): Row {
  return {
    n: node,
    __explain_outcomes: outcomes,
    __explain_visible: visible,
  };
}

const CTX = { uid: 'u1', tid: 't1', zone: 'z1' };

function setup(
  policies: PoliciesByModel,
  options: {
    rows?: Row[];
    policyDefaults?: PolicyDefaults;
    ctx?: Record<string, unknown>;
  } = {},
) {
  const recorded: Recorded[] = [];
  const session = {
    run: jest.fn(
      (cypher: string, params: Record<string, unknown>, config?: unknown) => {
        recorded.push({ cypher, params, config: config as Recorded['config'] });
        return Promise.resolve({
          records: (options.rows ?? []).map(fakeRecord),
          summary: {},
        });
      },
    ),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const driver = {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
  const logger = { debug: jest.fn(), warn: jest.fn() };
  const ogm = new OGM({
    typeDefs: schema,
    driver,
    policies,
    logger,
    policyDefaults: options.policyDefaults,
  });
  return {
    ogm,
    bound: ogm.withContext(options.ctx ?? CTX),
    recorded,
    driver,
    logger,
  };
}

function line(cypher: string, prefix: string): string {
  const found = cypher.split('\n').find((l) => l.startsWith(prefix));
  if (!found) throw new Error(`no line starting with "${prefix}":\n${cypher}`);
  return found;
}

/** The composed policy clause `find` put in its WHERE (no user where). */
function findClause(cypher: string): string {
  return line(cypher, 'WHERE ').slice('WHERE '.length);
}

// A policy set exercising every clause form. Parameter numbering follows
// compile order: permissives first, then restrictives.
const FORMS: PoliciesByModel = {
  Chart: [
    permissive({
      operations: ['read'],
      name: 'owner',
      when: (c) => ({ ownerId: c.uid }),
    }),
    permissive({
      operations: ['read'],
      name: 'owner-or-tenant',
      when: () => ({ ownerId: 'x' }),
      cypher: {
        fragment: (_c, { node }) => `${node}.tenantId = $tid`,
        params: (c) => ({ tid: c.tid }),
      },
    }),
    restrictive({
      operations: ['read'],
      name: 'active',
      when: () => ({ active: true }),
    }),
    restrictive({
      operations: ['read'],
      name: 'zone-raw',
      cypher: {
        fragment: (_c, { node }) => `${node}.weightZone IN $zones`,
        params: (c) => ({ zones: [c.zone] }),
      },
    }),
    restrictive({
      operations: ['read'],
      name: 'active-in-zone',
      when: () => ({ valid: true }),
      cypher: {
        fragment: (_c, { node }) => `${node}.weightZone = $zone`,
        params: (c) => ({ zone: c.zone }),
      },
    }),
  ],
};

describe('Model.explainPolicies — guards (6.1)', () => {
  it('rejects a model without a policy binding', async () => {
    const { ogm } = setup(FORMS);
    await expect(ogm.model('Chart').explainPolicies()).rejects.toThrow(
      /requires a policy-bound model/,
    );
  });

  it('rejects a globally bypassed OGM, with or without a context', async () => {
    const { ogm } = setup(FORMS);
    const bypassed = ogm.unsafe.bypassPolicies();
    await expect(bypassed.model('Chart').explainPolicies()).rejects.toThrow(
      /policy-bypassed OGM/,
    );
    await expect(
      bypassed.withContext(CTX).model('Chart').explainPolicies(),
    ).rejects.toThrow(/policy-bypassed OGM/);
  });

  it('rejects select together with selectionSet', async () => {
    const { bound } = setup(FORMS);
    await expect(
      bound
        .model('Chart')
        .explainPolicies({ select: { id: true }, selectionSet: '{ id }' }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('defaults the candidate limit to 100', async () => {
    const { bound, recorded } = setup(FORMS);
    await bound.model('Chart').explainPolicies();
    expect(recorded[0].cypher.split('\n').pop()).toBe('LIMIT $options_limit');
    expect((recorded[0].params.options_limit as Integer).toNumber()).toBe(100);
  });

  it('accepts 1000 and rejects 1001 candidates', async () => {
    const { bound, recorded } = setup(FORMS);
    await bound.model('Chart').explainPolicies({ options: { limit: 1000 } });
    expect((recorded[0].params.options_limit as Integer).toNumber()).toBe(1000);
    await expect(
      bound.model('Chart').explainPolicies({ options: { limit: 1001 } }),
    ).rejects.toThrow(/exceeds the maximum of 1000/);
    expect(recorded).toHaveLength(1);
  });
});

describe('Model.explainPolicies — clause forms and no short-circuit (6.2, 6.3)', () => {
  it('projects one value per applied policy: OR of parts for permissives, AND for restrictives', async () => {
    const f = setup(FORMS);
    await f.bound.model('Chart').find({});
    const enforced = findClause(f.recorded[0].cypher);

    const { bound, recorded } = setup(FORMS);
    await bound.model('Chart').explainPolicies();
    expect(line(recorded[0].cypher, 'WITH n, [')).toBe(
      'WITH n, [' +
        '(n.`ownerId` = $param0), ' +
        '((n.`ownerId` = $param1) OR (n.tenantId = $policy_p0_tid)), ' +
        '(n.`active` = $param2), ' +
        '(n.weightZone IN $policy_p1_zones), ' +
        '((n.`valid` = $param3) AND (n.weightZone = $policy_p2_zone))' +
        '] AS __explain_outcomes, ' +
        `coalesce((${enforced}), false) AS __explain_visible`,
    );
    // The candidate WHERE is empty: the policy predicate is NOT a filter.
    expect(recorded[0].cypher).not.toMatch(/^WHERE /m);
  });

  it('attributes raw-Cypher and declarative failures and reports every failing gate', async () => {
    const { bound } = setup(FORMS, {
      rows: [row({ id: 'c1' }, [true, false, true, false, false], false)],
    });
    const [e] = await bound.model('Chart').explainPolicies();
    expect(e.node).toEqual({ id: 'c1' });
    expect(e.visible).toBe(false);
    expect(e.permissiveGranted).toBe(true);
    expect(e.policies.map((p) => [p.name, p.kind, p.outcome])).toEqual([
      ['owner', 'permissive', 'pass'],
      ['owner-or-tenant', 'permissive', 'fail'],
      ['active', 'restrictive', 'pass'],
      ['zone-raw', 'restrictive', 'fail'],
      ['active-in-zone', 'restrictive', 'fail'],
    ]);
    expect(e.failedRestrictives).toEqual(['zone-raw', 'active-in-zone']);
  });

  it('reports a permissive that passes on only one of its two parts as pass', async () => {
    const { bound } = setup(FORMS, {
      // Cypher computes the OR of the two parts; true means one sufficed.
      rows: [row({ id: 'c1' }, [false, true, true, true, true], true)],
    });
    const [e] = await bound.model('Chart').explainPolicies();
    expect(e.visible).toBe(true);
    expect(e.policies[1]).toMatchObject({
      name: 'owner-or-tenant',
      outcome: 'pass',
    });
  });
});

describe('Model.explainPolicies — applicability (6.4)', () => {
  it('reports appliesWhen=false permissives and restrictives as not-applied, uncompiled', async () => {
    const { bound, recorded } = setup(
      {
        Chart: [
          permissive({
            operations: ['read'],
            name: 'p-off',
            appliesWhen: () => false,
            when: () => ({ ownerId: 'nobody' }),
          }),
          permissive({ operations: ['read'], name: 'p-on', when: () => ({}) }),
          restrictive({
            operations: ['read'],
            name: 'r-off',
            appliesWhen: () => false,
            when: () => false,
          }),
          override({ operations: ['read'], name: 'o-off', when: () => false }),
        ],
      },
      { rows: [row({ id: 'c1' }, [true], true)] },
    );
    const [e] = await bound.model('Chart').explainPolicies();
    expect(line(recorded[0].cypher, 'WITH n, [')).toBe(
      'WITH n, [true] AS __explain_outcomes, coalesce((true), false) AS __explain_visible',
    );
    expect(e.policies.map((p) => [p.name, p.applied, p.outcome])).toEqual([
      ['p-off', false, 'not-applied'],
      ['p-on', true, 'pass'],
      ['r-off', false, 'not-applied'],
      ['o-off', false, 'not-applied'],
    ]);
    expect(e.visible).toBe(true);
    expect(e.failedRestrictives).toEqual([]);
  });

  it('reports a firing override as pass, everything else skipped, all visible', async () => {
    const { bound, recorded } = setup(
      {
        Chart: [
          permissive({ operations: ['read'], name: 'p', when: () => ({}) }),
          override({ operations: ['read'], name: 'o-off', when: () => false }),
          override({ operations: ['read'], name: 'admin', when: () => true }),
          restrictive({ operations: ['read'], name: 'r', when: () => false }),
        ],
      },
      { rows: [row({ id: 'c1' }, [], true)] },
    );
    const [e] = await bound.model('Chart').explainPolicies();
    expect(line(recorded[0].cypher, 'WITH n, [')).toBe(
      'WITH n, [] AS __explain_outcomes, true AS __explain_visible',
    );
    expect(e).toMatchObject({
      visible: true,
      overriddenBy: 'admin',
      permissiveGranted: true,
      failedRestrictives: [],
    });
    expect(e.policies.map((p) => [p.name, p.outcome])).toEqual([
      ['p', 'skipped'],
      ['o-off', 'not-applied'],
      ['admin', 'pass'],
      ['r', 'skipped'],
    ]);
  });

  it('reports every candidate visible with no policies when the type has none', async () => {
    const { bound, recorded } = setup(FORMS, {
      rows: [row({ id: 't1' }, [], true)],
    });
    const [e] = await bound.model('Tier').explainPolicies();
    expect(line(recorded[0].cypher, 'WITH n, [')).toBe(
      'WITH n, [] AS __explain_outcomes, true AS __explain_visible',
    );
    expect(e).toMatchObject({
      visible: true,
      overriddenBy: null,
      permissiveGranted: true,
      policies: [],
    });
  });
});

describe('Model.explainPolicies — outcome vocabulary (6.5)', () => {
  it('distinguishes NULL from false and counts it as a failed restrictive', async () => {
    const { bound } = setup(
      {
        Chart: [
          permissive({ operations: ['read'], name: 'all', when: () => ({}) }),
          restrictive({
            operations: ['read'],
            name: 'zone',
            when: () => ({ weightZone: 'z1' }),
          }),
        ],
      },
      { rows: [row({ id: 'c1' }, [true, null], false)] },
    );
    const [e] = await bound.model('Chart').explainPolicies();
    expect(e.policies.map((p) => [p.name, p.outcome])).toEqual([
      ['all', 'pass'],
      ['zone', 'null'],
    ]);
    expect(e.failedRestrictives).toEqual(['zone']);
    expect(e.visible).toBe(false);
  });

  it('projects {} as true and a hard deny as false', async () => {
    const { bound, recorded } = setup(
      {
        Chart: [
          permissive({ operations: ['read'], name: 'all', when: () => ({}) }),
          restrictive({
            operations: ['read'],
            name: 'deny',
            when: () => false,
          }),
        ],
      },
      { rows: [row({ id: 'c1' }, [true, false], false)] },
    );
    const [e] = await bound.model('Chart').explainPolicies();
    expect(line(recorded[0].cypher, 'WITH n, [')).toBe(
      'WITH n, [true, false] AS __explain_outcomes, coalesce(((true AND false)), false) AS __explain_visible',
    );
    expect(e.policies.map((p) => p.outcome)).toEqual(['pass', 'fail']);
    expect(e.failedRestrictives).toEqual(['deny']);
  });

  it('an abstaining permissive grants nothing; an abstaining restrictive restricts nothing', async () => {
    const { bound, recorded } = setup(
      {
        Chart: [
          permissive({
            operations: ['read'],
            name: 'abstain-p',
            when: () => null as unknown as Record<string, unknown>,
          }),
          restrictive({
            operations: ['read'],
            name: 'abstain-r',
            when: () => null as unknown as Record<string, unknown>,
          }),
        ],
      },
      { rows: [row({ id: 'c1' }, [], false)] },
    );
    const [e] = await bound.model('Chart').explainPolicies();
    // Nothing projected; the composed clause is the default-deny literal.
    expect(line(recorded[0].cypher, 'WITH n, [')).toBe(
      'WITH n, [] AS __explain_outcomes, coalesce((false), false) AS __explain_visible',
    );
    expect(e.policies.map((p) => [p.name, p.applied, p.outcome])).toEqual([
      ['abstain-p', true, 'abstain'],
      ['abstain-r', true, 'abstain'],
    ]);
    expect(e).toMatchObject({
      visible: false,
      permissiveGranted: false,
      failedRestrictives: [],
    });
  });

  it('reports default deny instead of throwing when onDeny is "throw"', async () => {
    const policies: PoliciesByModel = {
      Chart: [
        permissive({
          operations: ['read'],
          name: 'gated',
          appliesWhen: () => false,
          when: () => ({}),
        }),
      ],
    };
    const { bound } = setup(policies, {
      policyDefaults: { onDeny: 'throw' },
      rows: [row({ id: 'c1' }, [], false)],
    });
    await expect(bound.model('Chart').find({})).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    const [e] = await bound.model('Chart').explainPolicies();
    expect(e).toMatchObject({ visible: false, permissiveGranted: false });
    expect(e.policies[0]).toMatchObject({
      name: 'gated',
      outcome: 'not-applied',
    });
  });
});

describe('Model.explainPolicies — fidelity with find (6.6)', () => {
  it('projects the exact clause find enforces, with identical param names and values', async () => {
    const where = { id_IN: ['c1', 'c2'], tiers_SOME: { name: 'gold' } };
    const policies: PoliciesByModel = {
      ...FORMS,
      Tier: [
        permissive({ operations: ['read'], name: 'tiers', when: () => ({}) }),
        restrictive({
          operations: ['read'],
          name: 'named',
          when: () => ({ name_IN: ['gold', 'silver'] }),
        }),
      ],
    };
    const f = setup(policies);
    await f.bound.model('Chart').find({ where });
    const x = setup(policies);
    await x.bound.model('Chart').explainPolicies({ where });

    const explainWhere = line(x.recorded[0].cypher, 'WHERE ').slice(6);
    const findWhere = line(f.recorded[0].cypher, 'WHERE ').slice(6);
    const prefix = `(${explainWhere}) AND `;
    expect(findWhere.startsWith(prefix)).toBe(true);
    const enforced = findWhere.slice(prefix.length);
    expect(line(x.recorded[0].cypher, 'WITH n, [')).toContain(
      `coalesce((${enforced}), false) AS __explain_visible`,
    );

    // Candidate traversal still enforces the Tier target policy.
    expect(explainWhere).toContain('EXISTS { MATCH (n)-[:`IN_TIER`]->');
    const { options_limit: _limit, ...explainParams } = x.recorded[0].params;
    expect(explainParams).toEqual(f.recorded[0].params);
  });

  it('refuses to explain when the enforcement verdict disagrees with the outcomes', async () => {
    const { bound } = setup(FORMS, {
      // Every policy passes, yet the enforcement predicate says invisible.
      rows: [row({ id: 'c1' }, [true, true, true, true, true], false)],
    });
    await expect(bound.model('Chart').explainPolicies()).rejects.toThrow(
      /consistency check failed for row 0 of type "Chart"/,
    );
  });

  it('refuses a malformed outcome list', async () => {
    const { bound } = setup(FORMS, {
      rows: [row({ id: 'c1' }, [true], true)],
    });
    await expect(bound.model('Chart').explainPolicies()).rejects.toThrow(
      OGMError,
    );
  });

  it('refuses a non-boolean policy value', async () => {
    const { bound } = setup(FORMS, {
      rows: [row({ id: 'c1' }, [true, 1, true, true, true], true)],
    });
    await expect(bound.model('Chart').explainPolicies()).rejects.toThrow(
      /evaluated to a non-boolean value/,
    );
  });
});

describe('Model.explainPolicies — identity (6.7)', () => {
  it('uses fallback ids for unnamed policies, keeps duplicates positional, and reports sources', async () => {
    const { bound } = setup(
      {
        Chart: [
          permissive({ operations: ['read'], when: () => ({}) }),
          restrictive({ operations: ['read'], name: 'dup', when: () => ({}) }),
          restrictive({ operations: ['read'], name: 'dup', when: () => ({}) }),
        ],
        Resource: [
          restrictive({
            operations: ['read'],
            when: (c) => ({ tenantId: c.tid }),
          }),
        ],
      },
      { rows: [row({ id: 'c1' }, [true, false], false)] },
    );
    const [e] = await bound.model('Chart').explainPolicies();
    expect(
      e.policies.map((p) => [p.name, p.named, p.source, p.outcome]),
    ).toEqual([
      ['Chart.permissive[0]', false, 'Chart', 'pass'],
      ['dup', true, 'Chart', 'abstain'],
      ['dup', true, 'Chart', 'abstain'],
      ['Resource.restrictive[0]', false, 'Resource', 'fail'],
    ]);
    expect(e.failedRestrictives).toEqual(['Resource.restrictive[0]']);
  });
});

describe('Model.explainPolicies — selection (6.8)', () => {
  it('keeps nested relationships filtered by their target-type policy, like find', async () => {
    const policies: PoliciesByModel = {
      Chart: [permissive({ operations: ['read'], when: () => ({}) })],
      Tier: [
        permissive({ operations: ['read'], when: () => ({}) }),
        restrictive({
          operations: ['read'],
          name: 'named',
          when: () => ({ name_IN: ['gold'] }),
        }),
      ],
    };
    const select = { id: true, tiers: { select: { id: true } } };
    const f = setup(policies);
    await f.bound.model('Chart').find({ select });
    const x = setup(policies);
    await x.bound.model('Chart').explainPolicies({ select });

    const findReturn = line(f.recorded[0].cypher, 'RETURN ');
    expect(line(x.recorded[0].cypher, 'RETURN ')).toBe(
      `${findReturn}, __explain_outcomes, __explain_visible`,
    );
    expect(findReturn).toContain('(n0.`name` IN $param');
  });

  it('carries explain vars through @cypher selection and sort preludes', async () => {
    const { bound, recorded } = setup({
      Chart: [
        permissive({ operations: ['read'], when: () => ({}) }),
        restrictive({
          operations: ['read'],
          name: 'low-risk',
          when: () => ({ riskScore_LT: 10 }),
        }),
      ],
    });
    await bound.model('Chart').explainPolicies({
      select: { id: true, riskScore: true },
      labels: ['Extra'],
      options: { sort: [{ riskScore: 'DESC' }], offset: 5, limit: 10 },
    });
    const lines = recorded[0].cypher.split('\n');
    expect(lines[0]).toBe('MATCH (n:`Chart`:`Extra`)');

    const whereAlias = lines.findIndex((l) =>
      l.includes('AS __where_n_riskScore'),
    );
    const explainWith = lines.findIndex((l) => l.startsWith('WITH n, ['));
    const selAlias = lines.findIndex((l) => l.includes('AS __sel_n_riskScore'));
    expect(whereAlias).toBeGreaterThan(-1);
    expect(explainWith).toBeGreaterThan(whereAlias);
    expect(selAlias).toBeGreaterThan(explainWith);
    // The policy fragment reads the where-scope alias inside the explain WITH.
    expect(lines[explainWith]).toContain('(__where_n_riskScore < $param0)');

    // Every WITH after the explain projection must carry both vars.
    for (const l of lines.slice(explainWith + 1))
      if (l.startsWith('WITH '))
        expect(l).toMatch(/__explain_outcomes, __explain_visible/);

    expect(lines.find((l) => l.startsWith('RETURN '))).toMatch(
      /, __explain_outcomes, __explain_visible$/,
    );
    expect(lines).toContain('SKIP $options_offset');
    expect(lines[lines.length - 1]).toBe('LIMIT $options_limit');
  });
});

describe('Model.explainPolicies — security signalling (6.9)', () => {
  it('namespaces raw-fragment params exactly like enforcement', async () => {
    const { bound, recorded } = setup(FORMS);
    await bound.model('Chart').explainPolicies();
    expect(recorded[0].params).toMatchObject({
      policy_p0_tid: 't1',
      policy_p1_zones: ['z1'],
      policy_p2_zone: 'z1',
    });
  });

  it('rejects injection-style labels, where keys, and policy param keys', async () => {
    const { bound, recorded } = setup(FORMS);
    await expect(
      bound
        .model('Chart')
        .explainPolicies({ labels: ['Chart`) DETACH DELETE n //'] }),
    ).rejects.toThrow(OGMError);
    await expect(
      bound
        .model('Chart')
        .explainPolicies({ where: { ['id` = 1 OR true //']: 'x' } }),
    ).rejects.toThrow(OGMError);

    const evil = setup({
      Chart: [
        permissive({
          operations: ['read'],
          cypher: {
            fragment: () => 'true',
            params: () => ({ ['bad name']: 1 }),
          },
        }),
      ],
    });
    await expect(evil.bound.model('Chart').explainPolicies()).rejects.toThrow(
      OGMError,
    );
    expect(recorded).toHaveLength(0);
    expect(evil.recorded).toHaveLength(0);
  });

  it('warns on every call, naming the type', async () => {
    const { bound, logger } = setup(FORMS);
    await bound.model('Chart').explainPolicies();
    await bound.model('Chart').explainPolicies();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('explainPolicies'),
      'Chart',
    );
  });

  it('tags audit metadata with explain: true even when auditMetadata is off', async () => {
    const { bound, recorded } = setup(FORMS, {
      policyDefaults: { auditMetadata: false },
    });
    await bound.model('Chart').explainPolicies();
    expect(recorded[0].config?.metadata).toMatchObject({
      operation: 'read',
      modelType: 'Chart',
      explain: true,
      bypassed: false,
    });
    // A normal read on the same OGM stays untagged.
    await bound.model('Chart').find({});
    expect(recorded[1].config).toBeUndefined();
  });

  it('opens its own session in READ mode; find keeps the default session', async () => {
    const { bound, driver } = setup(FORMS);
    await bound.model('Chart').explainPolicies();
    await bound.model('Chart').find({});
    const calls = (driver.session as jest.Mock).mock.calls;
    expect(calls[0]).toEqual([{ defaultAccessMode: 'READ' }]);
    expect(calls[1]).toEqual([]);
  });
});
