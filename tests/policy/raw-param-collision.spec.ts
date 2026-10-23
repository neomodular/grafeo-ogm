/**
 * v2.12.1 — raw-fragment policy params are unique across the statement.
 *
 * A policy's `cypher.params` keys are namespaced `policy_p<N>_<key>`.
 * Pre-2.12.1 `N` was a per-compile index that restarted at 0 in every
 * frame, so two types whose policies used the same raw key (`$v` below)
 * both bound `$policy_p0_v`, and the later frame's value silently
 * overwrote the earlier one in the shared params object (`mergeParams` is
 * `Object.assign`). Selecting a nested type therefore REPLACED the root
 * type's restrictive value: rows the root policy allowed disappeared and
 * rows it hid were returned. The same overwrite reached traversal filters,
 * connections, nested writes, relabel guards and `InterfaceModel` members.
 *
 * `N` now comes from the statement-wide `paramCounter` (the counter behind
 * `param<N>` / `sel_param<N>`). These tests pin, per frame kind, that every
 * raw param gets its own name, that every value survives, and that each
 * name is referenced by the node variable of the frame that bound it. The
 * live counterpart is `tests/integration/nls-raw-param-collision.spec.ts`.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive, restrictive } from '../../src/policy/types';

const typeDefs = `
interface Thing {
  id: ID!
  tier: String
}
type Top implements Thing @node {
  id: ID! @unique
  tier: String
  kids: [Kid!]! @relationship(type: "HAS", direction: OUT)
}
type Kid implements Thing @node {
  id: ID! @unique
  tier: String
  leaves: [Leaf!]! @relationship(type: "HAS_LEAF", direction: OUT)
}
type Leaf @node {
  id: ID! @unique
  tier: String
}
`;

/** Every type scopes rows by `tier`, all through the SAME raw key `v`. */
const tierIs = (v: string) => ({
  fragment: (_c: unknown, a: { node: string }) => `${a.node}.tier = $v`,
  params: () => ({ v }),
});

const policies = {
  Top: [
    permissive({ operations: ['read'], when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'top.gold',
      cypher: tierIs('gold'),
    }),
    permissive({
      operations: ['update'],
      name: 'top.update-gold',
      cypher: tierIs('gold'),
    }),
  ],
  Kid: [
    permissive({ operations: ['read'], when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'kid.silver',
      cypher: tierIs('silver'),
    }),
    permissive({
      operations: ['delete'],
      name: 'kid.delete-silver',
      cypher: tierIs('silver'),
    }),
  ],
  Leaf: [
    permissive({ operations: ['read'], when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'leaf.bronze',
      cypher: tierIs('bronze'),
    }),
  ],
};

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function setup() {
  const recorded: Recorded[] = [];
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      recorded.push({ cypher, params });
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
  const driver = {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
  const ogm = new OGM({ typeDefs, driver, policies });
  return { bound: ogm.withContext({ uid: 'u1' }), recorded };
}

/** `name → value` for every bound `policy_p<N>_v`. */
function rawParams(params: Record<string, unknown>): Map<string, unknown> {
  return new Map(
    Object.entries(params).filter(([k]) => /^policy_p\d+_v$/.test(k)),
  );
}

/** The bound name whose value is `value` (exactly one must exist). */
function nameOf(params: Record<string, unknown>, value: string): string {
  const names = [...rawParams(params)].filter(([, v]) => v === value);
  expect(names).toHaveLength(1);
  return names[0][0];
}

/** Every `$policy_p…` placeholder in the Cypher is bound, and vice versa. */
function expectPlaceholdersMatchParams({ cypher, params }: Recorded): void {
  const referenced = new Set(
    [...cypher.matchAll(/\$(policy_p\d+_\w+)/g)].map((m) => m[1]),
  );
  expect([...referenced].sort()).toEqual([...rawParams(params).keys()].sort());
}

describe('policy raw params — unique across the statement (v2.12.1)', () => {
  it('root where + nested selection: the root and the nested type each bind their own value', async () => {
    const { bound, recorded } = setup();
    await bound.model('Top').find({
      where: { id: 't1' },
      select: { id: true, kids: { select: { id: true } } },
    });
    const [rec] = recorded;
    expectPlaceholdersMatchParams(rec);
    expect(rawParams(rec.params).size).toBe(2);
    // The ROOT filter reads gold, the nested filter reads silver.
    expect(rec.cypher).toContain(`n.tier = $${nameOf(rec.params, 'gold')}`);
    expect(rec.cypher).toContain(`n0.tier = $${nameOf(rec.params, 'silver')}`);
    // User params and policy params never share an index.
    expect(rec.params.param0).toBe('t1');
    expect(rec.params).not.toHaveProperty('policy_p0_v');
  });

  it('three frames deep (root → kids → leaves): three names, three values', async () => {
    const { bound, recorded } = setup();
    await bound.model('Top').find({
      select: {
        id: true,
        kids: { select: { id: true, leaves: { select: { id: true } } } },
      },
    });
    const [rec] = recorded;
    expectPlaceholdersMatchParams(rec);
    expect(rawParams(rec.params).size).toBe(3);
    expect(rec.cypher).toContain(`n.tier = $${nameOf(rec.params, 'gold')}`);
    expect(rec.cypher).toContain(`n0.tier = $${nameOf(rec.params, 'silver')}`);
    expect(rec.cypher).toContain(`n1.tier = $${nameOf(rec.params, 'bronze')}`);
  });

  it('traversal filter (`kids_SOME`): the traversed type and the root share one counter', async () => {
    const { bound, recorded } = setup();
    await bound.model('Top').find({ where: { kids_SOME: { id: 'k1' } } });
    const [rec] = recorded;
    expectPlaceholdersMatchParams(rec);
    expect(rawParams(rec.params).size).toBe(2);
    expect(rec.cypher).toContain(`n.tier = $${nameOf(rec.params, 'gold')}`);
    expect(rec.cypher).toMatch(
      new RegExp(`r\\d+\\.tier = \\$${nameOf(rec.params, 'silver')}`),
    );
  });

  it('connection selection: the edge pattern filter binds its own name', async () => {
    const { bound, recorded } = setup();
    await bound.model('Top').find({
      selectionSet: '{ id kidsConnection { edges { node { id } } } }',
    });
    const [rec] = recorded;
    expectPlaceholdersMatchParams(rec);
    expect(rawParams(rec.params).size).toBe(2);
    expect(rec.cypher).toContain(`n.tier = $${nameOf(rec.params, 'gold')}`);
    expect(rec.cypher).toMatch(
      new RegExp(`\\w+\\.tier = \\$${nameOf(rec.params, 'silver')}`),
    );
  });

  it('nested write: root update filter + connect target read filter', async () => {
    const { bound, recorded } = setup();
    await bound.model('Top').update({
      where: { id: 't1' },
      connect: { kids: [{ where: { node: { id: 'k1' } } }] },
    });
    const [rec] = recorded;
    expectPlaceholdersMatchParams(rec);
    // Root `update` (gold), connect target `read` (silver), and the
    // response projection's `read` filters for Top (gold) — distinct names.
    expect(rawParams(rec.params).size).toBeGreaterThanOrEqual(2);
    expect(new Set(rawParams(rec.params).values())).toEqual(
      new Set(['gold', 'silver']),
    );
    // The root MATCH filter is the update permissive — gold.
    const rootWhere = rec.cypher
      .split('\n')
      .find((l) => l.startsWith('WHERE ') && l.includes('n.`id` = $param0'));
    expect(rootWhere).toBeDefined();
    const goldNames = [...rawParams(rec.params)]
      .filter(([, v]) => v === 'gold')
      .map(([k]) => k);
    expect(goldNames.some((k) => rootWhere!.includes(`n.tier = $${k}`))).toBe(
      true,
    );
  });

  it('InterfaceModel: every member clause binds its own name', async () => {
    const { bound, recorded } = setup();
    await bound.interfaceModel('Thing').find({});
    const [rec] = recorded;
    expectPlaceholdersMatchParams(rec);
    expect(rawParams(rec.params).size).toBe(2);
    expect(new Set(rawParams(rec.params).values())).toEqual(
      new Set(['gold', 'silver']),
    );
  });

  it('setLabels: root update guard + removed type delete guard', async () => {
    const { bound, recorded } = setup();
    await bound
      .model('Top')
      .setLabels({ where: { id: 't1' }, removeLabels: ['Kid'] });
    const [rec] = recorded;
    expectPlaceholdersMatchParams(rec);
    expect(rawParams(rec.params).size).toBe(2);
    expect(rec.cypher).toContain(`n.tier = $${nameOf(rec.params, 'gold')}`);
    expect(rec.cypher).toContain(`n.tier = $${nameOf(rec.params, 'silver')}`);
  });

  it('a single policy frame with no user where still binds policy_p0_<key>', async () => {
    const { bound, recorded } = setup();
    await bound.model('Leaf').find({});
    const [rec] = recorded;
    expectPlaceholdersMatchParams(rec);
    expect(rec.params).toEqual({ policy_p0_v: 'bronze' });
    expect(rec.cypher).toContain('n.tier = $policy_p0_v');
  });
});
