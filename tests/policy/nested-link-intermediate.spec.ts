/**
 * v2.5.2 — a `connect` nested in a connect item, or a `disconnect` nested
 * in a disconnect item, writes the INTERMEDIATE node's own relationships.
 * The direct equivalent (`Intermediate.update({ connect | disconnect })`)
 * needs the intermediate's `update` policy, so the nested form must too.
 * Pre-2.5.2 the intermediate was gated by `read` only. The live
 * counterpart is `tests/integration/nls-enforcement.spec.ts`.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { PolicyDeniedError } from '../../src/policy/errors';
import { permissive } from '../../src/policy/types';
import {
  CTX,
  policies,
  typeDefs,
  type Ctx,
} from '../fixtures/nls-enforcement.fixture';

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function setup(
  opts: {
    policies?: Record<string, unknown[]> | null;
    onDeny?: 'throw' | 'empty';
  } = {},
) {
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
  const pol = opts.policies === undefined ? policies : opts.policies;
  const ogm = new OGM({
    typeDefs,
    driver,
    ...(pol ? { policies: pol as typeof policies } : {}),
    ...(opts.onDeny ? { policyDefaults: { onDeny: opts.onDeny } } : {}),
  });
  return {
    ogm,
    bound: (ctx: Ctx = CTX) => ogm.withContext(ctx),
    recorded,
  };
}

/**
 * The `update` gate must sit on the intermediate, between the outer link
 * and the nested write: a `WHERE` carrying `ownerId` (the chart's update
 * permissive) after the outer clause and before the nested one.
 */
function expectGateBetween(
  cypher: string,
  outer: RegExp,
  nested: RegExp,
): void {
  const lines = cypher.split('\n').map((l) => l.trim());
  const outerAt = lines.findIndex((l) => outer.test(l));
  const nestedAt = lines.findIndex((l, i) => i > outerAt && nested.test(l));
  expect(outerAt).toBeGreaterThan(-1);
  expect(nestedAt).toBeGreaterThan(outerAt);
  const gateAt = lines.findIndex(
    (l, i) =>
      i > outerAt && i < nestedAt && /^WHERE .*`ownerId` = \$\w+/.test(l),
  );
  expect(gateAt).toBeGreaterThan(outerAt);
  // The gate's WITH carries the intermediate variable.
  expect(lines[gateAt - 1]).toMatch(/^WITH /);
}

const OUTER_TAGS_MERGE = /^MERGE .*IT_TAGS\b/;
const OUTER_TAGS_DELETE = /^DELETE r\w*charts/;
const NESTED_CAT_MERGE = /^MERGE .*IT_IN_CATEGORY/;
const NESTED_CAT_MATCH = /^OPTIONAL MATCH .*IT_IN_CATEGORY/;

const nestedConnect = (chartId = 'c1') => ({
  charts: [
    {
      where: { node: { id: chartId } },
      connect: { categories: [{ where: { node: { id: 'k1' } } }] },
    },
  ],
});

describe('v2.5.2 — nested link through an intermediate needs its update policy', () => {
  it('update: connect nested in a connect item', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .update({ where: { id: 't1' }, connect: nestedConnect() });
    expectGateBetween(recorded[0].cypher, OUTER_TAGS_MERGE, NESTED_CAT_MERGE);
    // The bound owner value is the context's uid.
    expect(Object.values(recorded[0].params)).toContain('u1');
  });

  it('create: connect nested in a connect item', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .create({
        input: [{ id: 't9', charts: { connect: nestedConnect().charts } }],
      });
    expectGateBetween(recorded[0].cypher, OUTER_TAGS_MERGE, NESTED_CAT_MERGE);
  });

  it('update body: item connect with a nested connect', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .update({
        where: { id: 't1' },
        update: { charts: [{ connect: nestedConnect().charts }] },
      });
    expectGateBetween(recorded[0].cypher, OUTER_TAGS_MERGE, NESTED_CAT_MERGE);
  });

  it('per-member abstract connect with a nested connect', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .update({
        where: { id: 't1' },
        connect: { items: { ItChart: nestedConnect().charts } },
      });
    expectGateBetween(
      recorded[0].cypher,
      /^MERGE .*IT_TAGS_ITEM/,
      NESTED_CAT_MERGE,
    );
  });

  it('update: disconnect nested in a disconnect item', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .update({
        where: { id: 't1' },
        disconnect: {
          charts: [
            {
              where: { node: { id: 'c1' } },
              disconnect: { categories: [{ where: { node: { id: 'k1' } } }] },
            },
          ],
        },
      });
    expectGateBetween(recorded[0].cypher, OUTER_TAGS_DELETE, NESTED_CAT_MATCH);
  });

  it('update: blanket disconnect nested in a disconnect item', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .update({
        where: { id: 't1' },
        disconnect: {
          charts: [
            { where: { node: { id: 'c1' } }, disconnect: { categories: null } },
          ],
        },
      });
    expectGateBetween(recorded[0].cypher, OUTER_TAGS_DELETE, NESTED_CAT_MATCH);
  });

  it('update body: item disconnect with a nested disconnect', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .update({
        where: { id: 't1' },
        update: {
          charts: [
            {
              disconnect: [
                {
                  where: { node: { id: 'c1' } },
                  disconnect: { categories: [{}] },
                },
              ],
            },
          ],
        },
      });
    expectGateBetween(
      recorded[0].cypher,
      /^DELETE r_disc_charts/,
      NESTED_CAT_MATCH,
    );
  });

  it('a plain connect (no nested op) is still gated by read only', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .update({
        where: { id: 't1' },
        connect: { charts: [{ where: { node: { id: 'c1' } } }] },
      });
    expect(recorded[0].cypher).not.toMatch(/`ownerId`/);
  });

  it("onDeny 'throw' with no update permissive on the intermediate throws", async () => {
    const { bound, recorded } = setup({
      policies: {
        ItChart: [
          permissive({
            operations: ['read'],
            name: 'chart.read',
            when: () => ({}),
          }),
          // An update permissive that never applies to this context.
          permissive({
            operations: ['update'],
            name: 'chart.update-admin',
            appliesWhen: () => false,
            when: () => ({}),
          }),
        ],
        ItCategory: policies.ItCategory,
      },
      onDeny: 'throw',
    });
    const err: unknown = await bound()
      .model('ItTag')
      .update({ where: { id: 't1' }, connect: nestedConnect() })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect((err as PolicyDeniedError).typeName).toBe('ItChart');
    expect((err as PolicyDeniedError).operation).toBe('update');
    expect(recorded).toHaveLength(0);
    // The plain connect only needs read, so it still runs.
    await bound()
      .model('ItTag')
      .update({
        where: { id: 't1' },
        connect: { charts: [{ where: { node: { id: 'c1' } } }] },
      });
    expect(recorded).toHaveLength(1);
  });

  it('without policies the nested connect emits no gate', async () => {
    const { ogm, recorded } = setup({ policies: null });
    await ogm
      .model('ItTag')
      .update({ where: { id: 't1' }, connect: nestedConnect() });
    expect(recorded[0].cypher).not.toMatch(/`ownerId`/);
  });
});
