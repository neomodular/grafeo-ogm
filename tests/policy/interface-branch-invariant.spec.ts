/**
 * Invariant (v2.3.0, fix-nls-enforcement-gaps H2): every `InterfaceModel`
 * policy branch `WHEN n:M THEN <clause>` is EXACTLY the policy clause that
 * `Model(M)` compiles for the same context and operation — same text,
 * same parameter values in the same order. `true` when `Model(M)` emits no
 * clause (no policy for the operation, or a firing override).
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import {
  override,
  permissive,
  restrictive,
  type PoliciesByModel,
} from '../../src/policy/types';

const typeDefs = `
interface Res {
  id: ID!
  tenantId: String
}
type Chart implements Res @node {
  id: ID! @unique
  tenantId: String
  ownerId: String
  secret: Boolean
}
type Drug implements Res @node {
  id: ID! @unique
  tenantId: String
  valid: Boolean
}
`;

type Ctx = { uid: string; tid: string };
const CTX: Ctx = { uid: 'u1', tid: 't1' };

const tenant = restrictive({
  operations: ['read'],
  name: 'res.tenant',
  when: (c) => ({ tenantId: (c as Ctx).tid }),
});

const FIXTURES: Record<string, PoliciesByModel> = {
  'interface-level policies only': {
    Res: [
      permissive({ operations: ['read'], name: 'res.all', when: () => ({}) }),
      tenant,
    ],
  },
  'implementer-level policies only': {
    Chart: [
      permissive({
        operations: ['read'],
        name: 'chart.own',
        when: (c) => ({ ownerId: (c as Ctx).uid }),
      }),
      restrictive({
        operations: ['read'],
        name: 'chart.no-secret',
        when: () => ({ secret: false }),
      }),
    ],
  },
  'interface + implementer policies': {
    Res: [tenant],
    Chart: [
      permissive({
        operations: ['read'],
        name: 'chart.own',
        when: (c) => ({ ownerId: (c as Ctx).uid }),
      }),
    ],
    Drug: [
      permissive({
        operations: ['read'],
        name: 'drug.valid',
        when: () => ({ valid: true }),
      }),
    ],
  },
  'implementer whose permissives are all gated off': {
    Chart: [
      permissive({ operations: ['read'], name: 'chart.all', when: () => ({}) }),
    ],
    Drug: [
      permissive({
        operations: ['read'],
        name: 'drug.gated',
        appliesWhen: () => false,
        when: () => ({}),
      }),
    ],
  },
  'implementer override fires': {
    Res: [
      permissive({ operations: ['read'], name: 'res.all', when: () => ({}) }),
      tenant,
    ],
    Chart: [
      override({ operations: ['read'], name: 'chart.admin', when: () => true }),
    ],
  },
  'no read policy on any implementer': {
    Chart: [
      permissive({
        operations: ['create'],
        name: 'chart.create',
        when: () => ({}),
      }),
    ],
  },
};

const AGGREGATE_FIXTURES: Record<string, PoliciesByModel> = {
  // Chart has its own aggregate policy; Drug falls back to read.
  'member aggregate policy + read fallback': {
    Res: [tenant],
    Chart: [
      permissive({
        operations: ['read'],
        name: 'chart.own',
        when: (c) => ({ ownerId: (c as Ctx).uid }),
      }),
      permissive({
        operations: ['aggregate'],
        name: 'chart.agg',
        when: () => ({ secret: false }),
      }),
    ],
    Drug: [
      permissive({
        operations: ['read'],
        name: 'drug.valid',
        when: () => ({ valid: true }),
      }),
    ],
  },
  'read policies only': FIXTURES['interface + implementer policies'],
  'gated read permissive':
    FIXTURES['implementer whose permissives are all gated off'],
};

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function setup(policies: PoliciesByModel) {
  const recorded: Recorded[] = [];
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      recorded.push({ cypher, params });
      return Promise.resolve({ records: [] });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const ogm = new OGM({
    typeDefs,
    driver: {
      session: jest.fn().mockReturnValue(session),
    } as unknown as Driver,
    policies,
  });
  /** Run `fn`, returning the one statement it sent (result mapping may throw on the empty mock). */
  const capture = async (fn: () => Promise<unknown>): Promise<Recorded> => {
    recorded.length = 0;
    await fn().catch(() => undefined);
    expect(recorded).toHaveLength(1);
    return recorded[0];
  };
  return { bound: ogm.withContext(CTX), capture };
}

/** A clause as text with `$paramN` normalized, plus its values in order. */
function shape(clause: string, params: Record<string, unknown>) {
  return {
    text: clause.replace(/\$param\d+/g, '$p'),
    values: [...clause.matchAll(/\$(param\d+)/g)].map((m) => params[m[1]]),
  };
}

/** The `WHERE` line of a statement, `''` when there is none. */
function whereOf({ cypher }: Recorded): string {
  const line = cypher.split('\n').find((l) => l.startsWith('WHERE '));
  return line ? line.slice('WHERE '.length) : '';
}

/** Branch `M` of an interface statement's CASE (`'true'` when no clause). */
function branchOf(rec: Recorded, member: string): string {
  const where = whereOf(rec);
  if (!where) return 'true';
  const m = new RegExp(
    `WHEN n:\`${member}\` THEN (.*?) (?:WHEN n:\`|ELSE false END\\))`,
  ).exec(where);
  if (!m) throw new Error(`no branch for ${member} in: ${where}`);
  return m[1];
}

const MEMBERS = ['Chart', 'Drug'];

describe.each(Object.entries(FIXTURES))(
  'InterfaceModel.find branches — %s',
  (_name, policies) => {
    it.each(MEMBERS)(
      "the %s branch equals that member's own Model.find clause",
      async (member) => {
        const { bound, capture } = setup(policies);
        const iface = await capture(() => bound.interfaceModel('Res').find());
        const model = await capture(() => bound.model(member).find());
        expect(shape(branchOf(iface, member), iface.params)).toEqual(
          shape(whereOf(model) || 'true', model.params),
        );
      },
    );
  },
);

describe.each(Object.entries(AGGREGATE_FIXTURES))(
  'InterfaceModel.aggregate / count branches — %s',
  (_name, policies) => {
    it.each(MEMBERS)(
      "the %s branch equals that member's own Model.aggregate clause",
      async (member) => {
        const { bound, capture } = setup(policies);
        const iface = await capture(() =>
          bound.interfaceModel('Res').aggregate({ aggregate: { count: true } }),
        );
        const model = await capture(() =>
          bound.model(member).aggregate({ aggregate: { count: true } }),
        );
        expect(shape(branchOf(iface, member), iface.params)).toEqual(
          shape(whereOf(model) || 'true', model.params),
        );
      },
    );

    it.each(MEMBERS)(
      "the %s branch equals that member's own Model.count clause",
      async (member) => {
        const { bound, capture } = setup(policies);
        const iface = await capture(() => bound.interfaceModel('Res').count());
        const model = await capture(() => bound.model(member).count());
        expect(shape(branchOf(iface, member), iface.params)).toEqual(
          shape(whereOf(model) || 'true', model.params),
        );
      },
    );
  },
);

it('an interface-level override short-circuits every branch', async () => {
  const { bound, capture } = setup({
    Res: [
      override({ operations: ['read'], name: 'res.admin', when: () => true }),
    ],
    Chart: [permissive({ operations: ['read'], name: 'c', when: () => ({}) })],
  });
  const iface = await capture(() => bound.interfaceModel('Res').find());
  expect(whereOf(iface)).toBe('');
});
