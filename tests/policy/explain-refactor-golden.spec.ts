import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import {
  override,
  permissive,
  restrictive,
  type PoliciesByModel,
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
  riskScore: Int
    @cypher(statement: "RETURN size(this.id) AS riskScore", columnName: "riskScore")
  tiers: [Tier!]! @relationship(type: "IN_TIER", direction: OUT)
}
type Tier @node {
  id: ID! @id @unique
  name: String
}
type Drug implements Resource @node(labels: ["Resource", "Drug"]) {
  id: ID! @id @unique
  tenantId: String
  valid: Boolean
}
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function createMockDriver(records: Recorded[]): Driver {
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

type Ctx = { uid: string; tid: string; tierId: string; zone: string };
const CTX: Ctx = { uid: 'u1', tid: 't1', tierId: 'tier-1', zone: 'z1' };
const READ_SIDE = ['read', 'count', 'aggregate', 'delete'] as const;

/**
 * Run `fn` against a fresh OGM carrying `policies`, bound to `CTX`, and
 * return every query the mock driver saw. Result-mapping failures AFTER
 * `session.run` (empty mock records) are irrelevant to emission and are
 * swallowed; a compile failure surfaces as zero recorded queries.
 */
async function capture(
  policies: PoliciesByModel,
  fn: (ogm: ReturnType<OGM['withContext']>) => Promise<unknown>,
): Promise<Recorded[]> {
  const recorded: Recorded[] = [];
  const ogm = new OGM({
    typeDefs: schema,
    driver: createMockDriver(recorded),
    policies,
  });
  await fn(ogm.withContext(CTX)).catch(() => undefined);
  return recorded;
}

const CASES: Array<{ name: string; run: () => Promise<Recorded[]> }> = [
  {
    name: 'when-only permissive + restrictive',
    run: () =>
      capture(
        {
          Chart: [
            permissive({
              operations: ['read'],
              name: 'owner',
              when: (c) => ({ ownerId: c.uid }),
            }),
            restrictive({
              operations: ['read'],
              name: 'active',
              when: () => ({ active: true }),
            }),
          ],
        },
        (o) => o.model('Chart').find({}),
      ),
  },
  {
    name: 'cypher-only permissive + restrictive',
    run: () =>
      capture(
        {
          Chart: [
            permissive({
              operations: ['read'],
              name: 'owner-raw',
              cypher: {
                fragment: (_c, { node }) => `${node}.ownerId = $uid`,
                params: (c) => ({ uid: c.uid }),
              },
            }),
            restrictive({
              operations: ['read'],
              name: 'zone-raw',
              cypher: {
                fragment: (_c, { node }) => `${node}.weightZone IN $zones`,
                params: (c) => ({ zones: [c.zone] }),
              },
            }),
          ],
        },
        (o) => o.model('Chart').find({}),
      ),
  },
  {
    name: 'both forms inside one permissive and one restrictive',
    run: () =>
      capture(
        {
          Chart: [
            permissive({
              operations: ['read'],
              name: 'owner-or-tenant',
              when: (c) => ({ ownerId: c.uid }),
              cypher: {
                fragment: (_c, { node }) => `${node}.tenantId = $tid`,
                params: (c) => ({ tid: c.tid }),
              },
            }),
            restrictive({
              operations: ['read'],
              name: 'active-in-zone',
              when: () => ({ active: true }),
              cypher: {
                fragment: (_c, { node }) => `${node}.weightZone = $zone`,
                params: (c) => ({ zone: c.zone }),
              },
            }),
          ],
        },
        (o) => o.model('Chart').find({}),
      ),
  },
  {
    name: 'constant permissive {} + restrictive hard deny',
    run: () =>
      capture(
        {
          Chart: [
            permissive({ operations: ['read'], when: () => ({}) }),
            restrictive({ operations: ['read'], when: () => false }),
          ],
        },
        (o) => o.model('Chart').find({}),
      ),
  },
  {
    name: 'abstaining permissive and no-op restrictives mixed with real ones',
    run: () =>
      capture(
        {
          Chart: [
            permissive({
              operations: ['read'],
              when: () => null as unknown as Record<string, unknown>,
            }),
            permissive({
              operations: ['read'],
              when: (c) => ({ ownerId: c.uid }),
            }),
            restrictive({
              operations: ['read'],
              when: () => null as unknown as Record<string, unknown>,
            }),
            restrictive({
              operations: ['read'],
              cypher: { fragment: () => '', params: () => ({}) },
            }),
            restrictive({
              operations: ['read'],
              when: () => ({ active: true }),
            }),
          ],
        },
        (o) => o.model('Chart').find({}),
      ),
  },
  {
    name: 'zero permissives (default deny)',
    run: () =>
      capture(
        {
          Chart: [
            restrictive({
              operations: ['read'],
              when: () => ({ active: true }),
            }),
          ],
        },
        (o) => o.model('Chart').find({}),
      ),
  },
  {
    name: 'all permissives abstain (default deny)',
    run: () =>
      capture(
        {
          Chart: [
            permissive({
              operations: ['read'],
              when: () => undefined as unknown as Record<string, unknown>,
            }),
            permissive({
              operations: ['read'],
              cypher: { fragment: () => '', params: () => ({}) },
            }),
          ],
        },
        (o) => o.model('Chart').find({}),
      ),
  },
  {
    name: 'interface-inherited restrictive + concrete permissive',
    run: () =>
      capture(
        {
          Resource: [
            restrictive({
              operations: ['read'],
              name: 'tenant',
              when: (c) => ({ tenantId: c.tid }),
            }),
          ],
          Chart: [
            permissive({
              operations: ['read'],
              name: 'owner',
              when: (c) => ({ ownerId: c.uid }),
            }),
          ],
        },
        (o) => o.model('Chart').find({}),
      ),
  },
  {
    name: '@cypher field referenced in a policy partial with user where',
    run: () =>
      capture(
        {
          Chart: [
            permissive({ operations: ['read'], when: () => ({}) }),
            restrictive({
              operations: ['read'],
              name: 'low-risk',
              when: () => ({ riskScore_LT: 10 }),
            }),
          ],
        },
        (o) => o.model('Chart').find({ where: { id: 'c1' } }),
      ),
  },
  {
    name: 'appliesWhen false on a permissive and a restrictive',
    run: () =>
      capture(
        {
          Chart: [
            permissive({
              operations: ['read'],
              name: 'never-perm',
              appliesWhen: () => false,
              when: () => ({ ownerId: 'nobody' }),
            }),
            permissive({
              operations: ['read'],
              name: 'owner',
              when: (c) => ({ ownerId: c.uid }),
            }),
            restrictive({
              operations: ['read'],
              name: 'never-rest',
              appliesWhen: () => false,
              when: () => ({ active: false }),
            }),
            restrictive({
              operations: ['read'],
              name: 'active',
              appliesWhen: () => true,
              when: () => ({ active: true }),
            }),
          ],
        },
        (o) => o.model('Chart').find({}),
      ),
  },
  {
    name: 'user where with traversal + policy traversal + target-type policy',
    run: () =>
      capture(
        {
          Chart: [
            permissive({ operations: ['read'], when: () => ({}) }),
            restrictive({
              operations: ['read'],
              name: 'tier',
              when: (c) => ({ tiers_SOME: { id: c.tierId } }),
            }),
          ],
          Tier: [
            permissive({
              operations: ['read'],
              name: 'gold-tiers',
              when: () => ({ name: 'gold' }),
            }),
          ],
        },
        (o) =>
          o.model('Chart').find({
            where: { id_IN: ['c1', 'c2'], tiers_SOME: { name: 'x' } },
          }),
      ),
  },
  {
    name: 'nested selection filtered by target-type policy',
    run: () =>
      capture(
        {
          Chart: [permissive({ operations: ['read'], when: () => ({}) })],
          Tier: [
            permissive({ operations: ['read'], when: () => ({}) }),
            restrictive({
              operations: ['read'],
              name: 'named-tiers',
              when: () => ({ name_IN: ['gold', 'silver'] }),
            }),
          ],
        },
        (o) =>
          o.model('Chart').find({
            select: { id: true, tiers: { select: { id: true } } },
          }),
      ),
  },
  {
    name: 'count op',
    run: () =>
      capture(
        {
          Chart: [
            permissive({
              operations: [...READ_SIDE],
              when: (c) => ({ ownerId: c.uid }),
            }),
            restrictive({
              operations: [...READ_SIDE],
              when: () => ({ active: true }),
            }),
          ],
        },
        (o) => o.model('Chart').count({ where: { tenantId: 't1' } }),
      ),
  },
  {
    name: 'aggregate op',
    run: () =>
      capture(
        {
          Chart: [
            permissive({
              operations: [...READ_SIDE],
              when: (c) => ({ ownerId: c.uid }),
            }),
            restrictive({
              operations: [...READ_SIDE],
              cypher: {
                fragment: (_c, { node }) => `${node}.active = $on`,
                params: () => ({ on: true }),
              },
            }),
          ],
        },
        (o) => o.model('Chart').aggregate({ aggregate: { count: true } }),
      ),
  },
  {
    name: 'delete op',
    run: () =>
      capture(
        {
          Chart: [
            permissive({
              operations: [...READ_SIDE],
              when: (c) => ({ ownerId: c.uid }),
            }),
            restrictive({
              operations: [...READ_SIDE],
              when: () => ({ active: false }),
            }),
          ],
        },
        (o) => o.model('Chart').delete({ where: { id: 'c1' } }),
      ),
  },
  {
    name: 'override short-circuit',
    run: () =>
      capture(
        {
          Chart: [
            override({ operations: ['read'], name: 'admin', when: () => true }),
            permissive({
              operations: ['read'],
              when: (c) => ({ ownerId: c.uid }),
            }),
            restrictive({ operations: ['read'], when: () => false }),
          ],
        },
        (o) => o.model('Chart').find({ where: { id: 'c1' } }),
      ),
  },
  {
    name: 'interface model find across implementers',
    run: () =>
      capture(
        {
          Resource: [
            restrictive({
              operations: ['read'],
              name: 'tenant',
              when: (c) => ({ tenantId: c.tid }),
            }),
          ],
          Chart: [
            permissive({
              operations: ['read'],
              when: (c) => ({ ownerId: c.uid }),
            }),
          ],
          Drug: [
            permissive({ operations: ['read'], when: () => ({ valid: true }) }),
          ],
        },
        (o) => o.interfaceModel('Resource').find({}),
      ),
  },
];

/** Params round-tripped through JSON so neo4j `Integer`s compare as data. */
function normalize(recorded: Recorded[]): Recorded[] {
  return JSON.parse(JSON.stringify(recorded)) as Recorded[];
}

/**
 * Captured from the pre-refactor `compilePolicyClause` (v2.1.1). Do NOT
 * regenerate these to make a failing test pass — a diff here means the
 * fragment/compose split changed emitted Cypher.
 */
const GOLDEN: Record<string, Recorded[]> = {
  'when-only permissive + restrictive': [
    {
      cypher:
        "MATCH (n:`Chart`)\nWHERE ((n.`ownerId` = $param0) AND (n.`active` = $param1))\nRETURN n { __typename: 'Chart', .`id`, .`tenantId`, .`ownerId`, .`active`, .`weightZone` }",
      params: {
        param0: 'u1',
        param1: true,
      },
    },
  ],
  'cypher-only permissive + restrictive': [
    {
      cypher:
        "MATCH (n:`Chart`)\nWHERE ((n.ownerId = $policy_p0_uid) AND (n.weightZone IN $policy_p1_zones))\nRETURN n { __typename: 'Chart', .`id`, .`tenantId`, .`ownerId`, .`active`, .`weightZone` }",
      params: {
        policy_p0_uid: 'u1',
        policy_p1_zones: ['z1'],
      },
    },
  ],
  'both forms inside one permissive and one restrictive': [
    {
      cypher:
        "MATCH (n:`Chart`)\nWHERE (((n.`ownerId` = $param0) OR (n.tenantId = $policy_p0_tid)) AND (n.`active` = $param1) AND (n.weightZone = $policy_p1_zone))\nRETURN n { __typename: 'Chart', .`id`, .`tenantId`, .`ownerId`, .`active`, .`weightZone` }",
      params: {
        param0: 'u1',
        policy_p0_tid: 't1',
        param1: true,
        policy_p1_zone: 'z1',
      },
    },
  ],
  'constant permissive {} + restrictive hard deny': [
    {
      cypher:
        "MATCH (n:`Chart`)\nWHERE (true AND false)\nRETURN n { __typename: 'Chart', .`id`, .`tenantId`, .`ownerId`, .`active`, .`weightZone` }",
      params: {},
    },
  ],
  'abstaining permissive and no-op restrictives mixed with real ones': [
    {
      cypher:
        "MATCH (n:`Chart`)\nWHERE ((n.`ownerId` = $param0) AND (n.`active` = $param1))\nRETURN n { __typename: 'Chart', .`id`, .`tenantId`, .`ownerId`, .`active`, .`weightZone` }",
      params: {
        param0: 'u1',
        param1: true,
      },
    },
  ],
  'zero permissives (default deny)': [
    {
      cypher:
        "MATCH (n:`Chart`)\nWHERE false\nRETURN n { __typename: 'Chart', .`id`, .`tenantId`, .`ownerId`, .`active`, .`weightZone` }",
      params: {
        param0: true,
      },
    },
  ],
  'all permissives abstain (default deny)': [
    {
      cypher:
        "MATCH (n:`Chart`)\nWHERE false\nRETURN n { __typename: 'Chart', .`id`, .`tenantId`, .`ownerId`, .`active`, .`weightZone` }",
      params: {},
    },
  ],
  'interface-inherited restrictive + concrete permissive': [
    {
      cypher:
        "MATCH (n:`Chart`)\nWHERE ((n.`ownerId` = $param0) AND (n.`tenantId` = $param1))\nRETURN n { __typename: 'Chart', .`id`, .`tenantId`, .`ownerId`, .`active`, .`weightZone` }",
      params: {
        param0: 'u1',
        param1: 't1',
      },
    },
  ],
  '@cypher field referenced in a policy partial with user where': [
    {
      cypher:
        "MATCH (n:`Chart`)\nCALL {\n  WITH n\n  WITH n AS this\n  RETURN size(this.id) AS riskScore\n}\nWITH n, `riskScore` AS __where_n_riskScore\nWHERE (n.`id` = $param0) AND (true AND (__where_n_riskScore < $param1))\nRETURN n { __typename: 'Chart', .`id`, .`tenantId`, .`ownerId`, .`active`, .`weightZone` }",
      params: {
        param0: 'c1',
        param1: 10,
      },
    },
  ],
  'appliesWhen false on a permissive and a restrictive': [
    {
      cypher:
        "MATCH (n:`Chart`)\nWHERE ((n.`ownerId` = $param0) AND (n.`active` = $param1))\nRETURN n { __typename: 'Chart', .`id`, .`tenantId`, .`ownerId`, .`active`, .`weightZone` }",
      params: {
        param0: 'u1',
        param1: true,
      },
    },
  ],
  'user where with traversal + policy traversal + target-type policy': [
    {
      cypher:
        "MATCH (n:`Chart`)\nWHERE (n.`id` IN $param0 AND EXISTS { MATCH (n)-[:`IN_TIER`]->(r1:`Tier`) WHERE (r1.`name` = $param2) AND (r1.`name` = $param3) }) AND (true AND (EXISTS { MATCH (n)-[:`IN_TIER`]->(r4:`Tier`) WHERE r4.`id` = $param5 }))\nRETURN n { __typename: 'Chart', .`id`, .`tenantId`, .`ownerId`, .`active`, .`weightZone` }",
      params: {
        param0: ['c1', 'c2'],
        param2: 'x',
        param3: 'gold',
        param5: 'tier-1',
      },
    },
  ],
  'nested selection filtered by target-type policy': [
    {
      cypher:
        'MATCH (n:`Chart`)\nWHERE true\nRETURN n { .`id`, tiers: [(n)-[:`IN_TIER`]->(n0:`Tier`) WHERE (true AND (n0.`name` IN $param0)) | n0 { .`id` }] }',
      params: {
        param0: ['gold', 'silver'],
      },
    },
  ],
  'count op': [
    {
      cypher:
        'MATCH (n:`Chart`)\nWHERE (n.`tenantId` = $param0) AND ((n.`ownerId` = $param1) AND (n.`active` = $param2))\nRETURN count(n) AS count',
      params: {
        param0: 't1',
        param1: 'u1',
        param2: true,
      },
    },
  ],
  'aggregate op': [
    {
      cypher:
        'MATCH (n:`Chart`)\nWHERE ((n.`ownerId` = $param0) AND (n.active = $policy_p0_on))\nRETURN count(n) AS count',
      params: {
        param0: 'u1',
        policy_p0_on: true,
      },
    },
  ],
  'delete op': [
    {
      cypher:
        'MATCH (n:`Chart`:`Resource`)\nWHERE (n.`id` = $param0) AND ((n.`ownerId` = $param1) AND (n.`active` = $param2))\nDETACH DELETE n',
      params: {
        param0: 'c1',
        param1: 'u1',
        param2: false,
      },
    },
  ],
  'override short-circuit': [
    {
      cypher:
        "MATCH (n:`Chart`)\nWHERE n.`id` = $param0\nRETURN n { __typename: 'Chart', .`id`, .`tenantId`, .`ownerId`, .`active`, .`weightZone` }",
      params: {
        param0: 'c1',
      },
    },
  ],
  'interface model find across implementers': [
    {
      cypher:
        "MATCH (n:`Resource`)\nWHERE (CASE WHEN n:`Chart` THEN ((n.`ownerId` = $param0) AND (n.`tenantId` = $param1) AND (n.`tenantId` = $param2)) WHEN n:`Drug` THEN ((n.`valid` = $param3) AND (n.`tenantId` = $param4) AND (n.`tenantId` = $param5)) ELSE false END)\nWITH n, CASE WHEN n:`Chart` THEN 'Chart' WHEN n:`Drug` THEN 'Drug' END AS __typename\nRETURN n { __typename: head([__label IN labels(n) WHERE __label IN ['Chart', 'Drug']]), .`id`, .`tenantId` , __typename: __typename }",
      params: {
        param0: 'u1',
        param1: 't1',
        param2: 't1',
        param3: true,
        param4: 't1',
        param5: 't1',
      },
    },
  ],
};

describe('policy clause emission — frozen golden (pre fragment/compose split)', () => {
  for (const c of CASES)
    it(c.name, async () => {
      const got = normalize(await c.run());
      expect(got.length).toBeGreaterThan(0);
      expect(got).toEqual(GOLDEN[c.name]);
    });
});
