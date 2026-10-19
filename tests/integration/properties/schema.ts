/**
 * Fixed schema, policies and seed graph for the property-based live suites
 * (`tests/integration/properties/`).
 *
 * The schema is small but covers every target kind a nested write or read
 * can reach:
 *
 * - `ItPTag` (no policies) is the usual root. `charts` is concrete with
 *   edge properties (`ItPEdge`), `resources` is an INTERFACE target and
 *   `items` a UNION target. `vaults` deliberately SHARES its relationship
 *   type (`ITP_RES`) with the interface field `resources`, and `ItPVault`
 *   is not an `ItPResource` implementor — the shape of the v2.5.0
 *   regression where a nested write on the interface field also touched
 *   the other field's nodes.
 * - `ItPChart` — the fixture policies of `tests/fixtures/nls-enforcement`:
 *   read hides `secret`, update / delete owner-only, create needs a grant,
 *   tenant WITH CHECK on create / update.
 * - `ItPCategory` — deletable only when not `protected`.
 * - `ItPDrug` — default-deny type: its only permissive (`*`) is gated off.
 * - `ItPDoc` — read restrictive with the `_NOT: null` idiom.
 * - `ItPVault` — no policies, not an interface member.
 * - `ItPScalars` — every scalar kind and a list of each (round-trip rule).
 *
 * `POLICY_MIRROR` re-states every policy as a plain JS predicate over a
 * node's stored properties, using Cypher's three-valued logic (a missing
 * property never satisfies an equality). The policy rules are checked
 * against the mirror, never against the OGM's own compiled predicates, so
 * a compiler bug cannot hide itself.
 */
import { permissive, restrictive } from '../../../src/policy/types';

export const typeDefs = /* GraphQL */ `
  interface ItPResource {
    id: ID!
    runId: String
    name: String
    rank: Int
  }
  type ItPEdge @relationshipProperties {
    weight: Int
    note: String
  }
  union ItPItem = ItPChart | ItPDoc

  type ItPTag @node {
    id: ID! @unique
    runId: String
    name: String
    rank: Int
    charts: [ItPChart!]!
      @relationship(type: "ITP_TAGS", direction: OUT, properties: "ItPEdge")
    resources: [ItPResource!]! @relationship(type: "ITP_RES", direction: OUT)
    vaults: [ItPVault!]! @relationship(type: "ITP_RES", direction: OUT)
    items: [ItPItem!]! @relationship(type: "ITP_ITEM", direction: OUT)
  }
  type ItPChart implements ItPResource @node {
    id: ID! @unique
    runId: String
    name: String
    rank: Int
    tenantId: String
    ownerId: String
    secret: Boolean
    tags: [ItPTag!]!
      @relationship(type: "ITP_TAGS", direction: IN, properties: "ItPEdge")
    categories: [ItPCategory!]!
      @relationship(type: "ITP_IN_CAT", direction: OUT)
  }
  type ItPCategory @node {
    id: ID! @unique
    runId: String
    name: String
    rank: Int
    protected: Boolean
    charts: [ItPChart!]! @relationship(type: "ITP_IN_CAT", direction: IN)
  }
  type ItPDrug implements ItPResource @node {
    id: ID! @unique
    runId: String
    name: String
    rank: Int
  }
  type ItPDoc @node {
    id: ID! @unique
    runId: String
    name: String
    rank: Int
    approvedAt: String
  }
  type ItPVault @node {
    id: ID! @unique
    runId: String
    name: String
    rank: Int
  }
  type ItPScalars @node {
    id: ID! @unique
    runId: String
    i: Int
    bi: BigInt
    f: Float
    b: Boolean
    s: String
    xid: ID
    dt: DateTime
    d: Date
    ldt: LocalDateTime
    t: Time
    lt: LocalTime
    dur: Duration
    p: Point
    cp: CartesianPoint
    is: [Int!]
    bis: [BigInt!]
    fs: [Float!]
    bs: [Boolean!]
    ss: [String!]
    xids: [ID!]
    dts: [DateTime!]
    ds: [Date!]
    ldts: [LocalDateTime!]
    ts: [Time!]
    lts: [LocalTime!]
    durs: [Duration!]
    ps: [Point!]
    cps: [CartesianPoint!]
  }
`;

/** Every node type of the graph schema (scalars excluded). */
export const GRAPH_TYPES = [
  'ItPTag',
  'ItPChart',
  'ItPCategory',
  'ItPDrug',
  'ItPDoc',
  'ItPVault',
] as const;
export type GraphType = (typeof GRAPH_TYPES)[number];

export type Ctx = { uid: string; tid: string; canCreateChart?: boolean };

/** Contexts a policy-bound property run is drawn from. */
export const CONTEXTS: readonly Ctx[] = [
  { uid: 'u1', tid: 't1' },
  { uid: 'u2', tid: 't1', canCreateChart: true },
  { uid: 'u1', tid: 't2', canCreateChart: true },
];

export const policies = {
  ItPChart: [
    permissive({
      operations: ['read'],
      name: 'chart.read-all',
      when: () => ({}),
    }),
    restrictive({
      operations: ['read'],
      name: 'chart.no-secret',
      when: () => ({ secret: false }),
    }),
    permissive({
      operations: ['update'],
      name: 'chart.update-own',
      when: (c) => ({ ownerId: (c as Ctx).uid }),
    }),
    restrictive({
      operations: ['update'],
      name: 'chart.update-tenant',
      when: (c, input) =>
        input.tenantId === undefined || input.tenantId === (c as Ctx).tid,
    }),
    permissive({
      operations: ['create'],
      name: 'chart.create-grant',
      appliesWhen: (c) => Boolean((c as Ctx).canCreateChart),
      when: () => ({}),
    }),
    restrictive({
      operations: ['create'],
      name: 'chart.create-tenant',
      when: (c, input) => input.tenantId === (c as Ctx).tid,
    }),
    permissive({
      operations: ['delete'],
      name: 'chart.delete-own',
      when: (c) => ({ ownerId: (c as Ctx).uid }),
    }),
  ],
  ItPCategory: [
    permissive({
      operations: ['read', 'update', 'create'],
      name: 'category.all',
      when: () => ({}),
    }),
    permissive({
      operations: ['delete'],
      name: 'category.delete-unprotected',
      when: () => ({ protected: false }),
    }),
  ],
  ItPDrug: [
    permissive({
      operations: ['*'],
      name: 'drug.default-deny',
      appliesWhen: () => false,
      when: () => ({}),
    }),
  ],
  ItPDoc: [
    permissive({ operations: ['read'], name: 'doc.all', when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'doc.approved',
      when: () => ({ approvedAt_NOT: null }),
    }),
  ],
};

/** An allow-all permissive for every operation of every type (rule 5). */
export const allowAllPolicies = Object.fromEntries(
  [...GRAPH_TYPES, 'ItPScalars'].map((t) => [
    t,
    [permissive({ operations: ['*'], name: `${t}.all`, when: () => ({}) })],
  ]),
);

type Props = Record<string, unknown>;

/**
 * The policies above as JS predicates over STORED properties. Cypher
 * three-valued logic: `n.secret = false` is NULL (not true) when `secret`
 * is missing, so a missing property never grants or passes.
 */
export const POLICY_MIRROR = {
  readable(type: string, p: Props): boolean {
    switch (type) {
      case 'ItPChart':
        return p.secret === false;
      case 'ItPDrug':
        return false;
      case 'ItPDoc':
        return p.approvedAt !== undefined && p.approvedAt !== null;
      default:
        return true;
    }
  },
  updatable(type: string, p: Props, ctx: Ctx): boolean {
    switch (type) {
      case 'ItPChart':
        return p.ownerId === ctx.uid;
      case 'ItPDrug':
        return false;
      default:
        return true;
    }
  },
  deletable(type: string, p: Props, ctx: Ctx): boolean {
    switch (type) {
      case 'ItPChart':
        return p.ownerId === ctx.uid;
      case 'ItPCategory':
        return p.protected === false;
      case 'ItPDrug':
        return false;
      default:
        return true;
    }
  },
  /** Create policy, checked on the created node's stored properties. */
  creatable(type: string, p: Props, ctx: Ctx): boolean {
    switch (type) {
      case 'ItPChart':
        return Boolean(ctx.canCreateChart) && p.tenantId === ctx.tid;
      case 'ItPDrug':
        return false;
      default:
        return true;
    }
  },
  /** Update WITH CHECK, checked on the changed node's new properties. */
  updateCheck(type: string, before: Props, after: Props, ctx: Ctx): boolean {
    if (type === 'ItPChart' && before.tenantId !== after.tenantId)
      return after.tenantId === ctx.tid;
    return true;
  },
};

/** Names shared by every type, so a `name` filter can hit several types. */
export const NAMES = ['a', 'b', 'c'] as const;

/**
 * Seed graph. Ids are suffixes; the suite prefixes them with its runId.
 * Dense on purpose: every relationship field has 0, 1 and several targets
 * somewhere, `ITP_RES` reaches charts, drugs AND vaults, and the policy
 * attributes (owner, secret, tenant, protected, approvedAt) take every
 * value including missing.
 */
export const SEED = {
  nodes: [
    { type: 'ItPTag', id: 't1', props: { name: 'a', rank: 1 } },
    { type: 'ItPTag', id: 't2', props: { name: 'b', rank: 2 } },
    { type: 'ItPTag', id: 't3', props: { name: 'a', rank: 3 } },
    { type: 'ItPTag', id: 't4', props: { name: 'c' } },
    {
      type: 'ItPChart',
      id: 'c1',
      props: {
        name: 'a',
        rank: 1,
        ownerId: 'u1',
        secret: false,
        tenantId: 't1',
      },
    },
    {
      type: 'ItPChart',
      id: 'c2',
      props: {
        name: 'b',
        rank: 2,
        ownerId: 'u2',
        secret: false,
        tenantId: 't1',
      },
    },
    {
      type: 'ItPChart',
      id: 'c3',
      props: {
        name: 'a',
        rank: 3,
        ownerId: 'u1',
        secret: true,
        tenantId: 't2',
      },
    },
    { type: 'ItPChart', id: 'c4', props: { name: 'c', ownerId: 'u2' } },
    {
      type: 'ItPChart',
      id: 'c5',
      props: { name: 'b', rank: 5, secret: false, tenantId: 't2' },
    },
    { type: 'ItPCategory', id: 'k1', props: { name: 'a', protected: false } },
    { type: 'ItPCategory', id: 'k2', props: { name: 'b', protected: true } },
    { type: 'ItPCategory', id: 'k3', props: { name: 'a', rank: 3 } },
    { type: 'ItPDrug', id: 'd1', props: { name: 'a', rank: 1 } },
    { type: 'ItPDrug', id: 'd2', props: { name: 'c' } },
    {
      type: 'ItPDoc',
      id: 'o1',
      props: { name: 'a', approvedAt: '2026-01-01', rank: 1 },
    },
    { type: 'ItPDoc', id: 'o2', props: { name: 'b' } },
    {
      type: 'ItPDoc',
      id: 'o3',
      props: { name: 'c', approvedAt: '2026-02-02' },
    },
    { type: 'ItPVault', id: 'v1', props: { name: 'a', rank: 1 } },
    { type: 'ItPVault', id: 'v2', props: { name: 'b' } },
    { type: 'ItPVault', id: 'v3', props: { name: 'a', rank: 3 } },
  ],
  rels: [
    ['t1', 'ITP_TAGS', 'c1', { weight: 1, note: 'x' }],
    ['t1', 'ITP_TAGS', 'c2', { weight: 2 }],
    ['t1', 'ITP_TAGS', 'c3', { weight: 3 }],
    ['t2', 'ITP_TAGS', 'c2', {}],
    ['t2', 'ITP_TAGS', 'c4', { weight: 4 }],
    ['t3', 'ITP_TAGS', 'c5', { weight: 5 }],
    ['t1', 'ITP_RES', 'c1', {}],
    ['t1', 'ITP_RES', 'd1', {}],
    ['t1', 'ITP_RES', 'v1', {}],
    ['t2', 'ITP_RES', 'c3', {}],
    ['t2', 'ITP_RES', 'v2', {}],
    ['t2', 'ITP_RES', 'd2', {}],
    ['t3', 'ITP_RES', 'v3', {}],
    ['t3', 'ITP_RES', 'c2', {}],
    ['t1', 'ITP_ITEM', 'c1', {}],
    ['t1', 'ITP_ITEM', 'o1', {}],
    ['t1', 'ITP_ITEM', 'o2', {}],
    ['t2', 'ITP_ITEM', 'c3', {}],
    ['t3', 'ITP_ITEM', 'o3', {}],
    ['c1', 'ITP_IN_CAT', 'k1', {}],
    ['c1', 'ITP_IN_CAT', 'k2', {}],
    ['c2', 'ITP_IN_CAT', 'k1', {}],
    ['c3', 'ITP_IN_CAT', 'k3', {}],
    ['c4', 'ITP_IN_CAT', 'k2', {}],
    ['c5', 'ITP_IN_CAT', 'k3', {}],
  ] as Array<[string, string, string, Record<string, unknown>]>,
};
