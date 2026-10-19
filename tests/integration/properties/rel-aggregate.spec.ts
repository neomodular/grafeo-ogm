/**
 * Property 7 (v2.7.0) — a `<rel>Aggregate` measures exactly the list.
 *
 * For a random relationship field (concrete, interface or union target),
 * an optional `where`, at depth 1 or 2, with no policies or bound to one of
 * the fixture contexts, in 2.x default and strict mode: the aggregate's
 * `count` equals the length of the same relationship selected as a list
 * with the same `where` under the same context, and its `rank { min max
 * sum }` equal the min / max / sum of the listed nodes' `rank`. So a node
 * the read policy (or, strict, the member restriction) hides from the list
 * never moves an aggregate, and a visible one always does.
 *
 * Opt-in on NEO4J_URI; seed graph tagged with this run's `runId`, removed
 * in afterAll; every case runs in a rolled-back transaction.
 */
import fc from 'fast-check';
import type { Driver } from 'neo4j-driver';
import { OGM } from '../../../src/ogm';
import { gqlLiteral, RELS, scalarWhere, type RelDef } from './arbitraries';
import { stableJson, type OgmLike } from './exec';
import {
  checkProperty,
  cleanup,
  describeLive,
  inRollback,
  makeDriver,
  newRunId,
  OutcomeStats,
  redact,
  resolvePlaceholders,
  seedGraph,
} from './harness';
import { CONTEXTS, policies, typeDefs } from './schema';

jest.setTimeout(300_000);

type Rec = Record<string, unknown>;

interface Case {
  model: string;
  /** Depth 2: the relationship walked first (to a concrete target). */
  via?: RelDef;
  def: RelDef;
  where?: Rec;
  ctx: number;
  strict: boolean;
}

const ROOTS = Object.keys(RELS).filter((t) => RELS[t].length > 0);

const caseArb: fc.Arbitrary<Case> = fc
  .record({
    model: fc.constantFrom(...ROOTS),
    deep: fc.boolean(),
    ctx: fc.integer({ min: -1, max: CONTEXTS.length - 1 }),
    strict: fc.boolean(),
  })
  .chain(({ model, deep, ctx, strict }) => {
    const vias = RELS[model].filter(
      (r) => r.kind === 'concrete' && (RELS[r.members[0]] ?? []).length > 0,
    );
    const via =
      deep && vias.length ? fc.constantFrom(...vias) : fc.constant(undefined);
    return via.chain((v) =>
      fc
        .constantFrom(...RELS[v ? v.members[0] : model])
        .chain((def) =>
          (def.kind === 'union'
            ? fc.constant(undefined)
            : fc.option(
                scalarWhere(
                  def.kind === 'interface' ? 'ItPResource' : def.members[0],
                  1,
                ),
                { nil: undefined },
              )
          ).map((where) => ({ model, via: v, def, where, ctx, strict })),
        ),
    );
  });

function selection(c: Case): string {
  const args = c.where ? `(where: ${gqlLiteral(c.where)})` : '';
  const node = c.def.kind === 'union' ? '' : ' node { rank { min max sum } }';
  const inner = `{ id l: ${c.def.field}${args} { id ${c.def.kind === 'union' ? '__typename' : 'rank'} } a: ${c.def.field}Aggregate${args} { count${node} } }`;
  return c.via ? `{ id ${c.via.field} ${inner} }` : inner;
}

/** Every object holding both `l` (the list) and `a` (its aggregate). */
function pairs(rows: Rec[], c: Case): Array<{ l: Rec[]; a: Rec }> {
  const holders = c.via
    ? rows.flatMap((r) => (r[c.via!.field] as Rec[]) ?? [])
    : rows;
  return holders.map((h) => ({ l: h.l as Rec[], a: h.a as Rec }));
}

describeLive(
  'Property 7 — <rel>Aggregate measures the list (live Neo4j)',
  () => {
    const runId = newRunId();
    let driver: Driver;
    const ogms: Record<string, OGM> = {};
    const stats = new OutcomeStats('rel-aggregate');

    beforeAll(async () => {
      driver = makeDriver();
      await driver.verifyConnectivity();
      await seedGraph(driver, runId);
      for (const strict of [false, true]) {
        ogms[`plain${strict}`] = new OGM({ typeDefs, driver, strict });
        ogms[`guarded${strict}`] = new OGM({
          typeDefs,
          driver,
          strict,
          policies,
          policyDefaults: { auditMetadata: false },
        });
      }
    });

    afterAll(async () => {
      stats.report();
      if (driver) {
        await cleanup(driver, runId);
        await driver.close();
      }
    });

    const pick = (c: Case): OgmLike =>
      c.ctx < 0
        ? ogms[`plain${c.strict}`]
        : ogms[`guarded${c.strict}`].withContext(CONTEXTS[c.ctx]);

    it('count = list length; rank min / max / sum = the listed ranks', async () => {
      await checkProperty(
        'rel-aggregate/count-equals-list',
        caseArb,
        async (c) => {
          const selectionSet = selection(c);
          const rows = await inRollback(driver, (tx) =>
            (
              pick(c).model(c.model) as unknown as {
                find(p: Rec): Promise<Rec[]>;
              }
            ).find({
              where: resolvePlaceholders({ runId: '@run' }, runId),
              selectionSet: resolvePlaceholders(selectionSet, runId),
              context: { transaction: tx },
            }),
          );
          let checked = 0;
          for (const { l, a } of pairs(rows, c)) {
            checked++;
            const ranks = l
              .map((n) => n.rank)
              .filter((r): r is number => typeof r === 'number');
            const want: Rec = { count: l.length };
            if (c.def.kind !== 'union')
              want.node = {
                rank: {
                  min: ranks.length ? Math.min(...ranks) : null,
                  max: ranks.length ? Math.max(...ranks) : null,
                  sum: ranks.reduce((s, r) => s + r, 0),
                },
              };
            if (stableJson(a) !== stableJson(want))
              throw new Error(
                redact(
                  `${selectionSet}\n  aggregate: ${JSON.stringify(a)}\n  list:      ${JSON.stringify(want)} (${l.length} nodes)`,
                  runId,
                ),
              );
          }
          stats.add(
            `${c.def.kind}${c.via ? ' depth2' : ''}${c.ctx < 0 ? '' : ' policies'}${c.strict ? ' strict' : ''} ${checked ? 'checked' : 'empty'}`,
          );
        },
        250,
      );
    });
  },
);
