/**
 * Property 2 — row cardinality (compiler invariant 2).
 *
 * `update` returns every root matched by `where` exactly once, and
 * `updateMany`'s count equals the number of matched roots — whatever the
 * nested ops (connect / disconnect / create / update / delete at depth
 * ≤ 3) match: zero targets, one, or many. The expected roots are computed
 * independently: the root `where` is evaluated in JS against a snapshot,
 * and under a policy context the mirrored `update` policy filters them
 * (and, for the rows `update` returns, the mirrored `read` policy on the
 * post-write state — v2.6.1).
 *
 * Opt-in on NEO4J_URI; seed graph tagged with this run's `runId`, removed
 * in afterAll; every case runs in a rolled-back transaction.
 */
import fc from 'fast-check';
import type { Driver } from 'neo4j-driver';
import { OGM } from '../../../src/ogm';
import { writeOp, type WriteOp } from './arbitraries';
import { runWrite, type OgmLike } from './exec';
import {
  checkProperty,
  cleanup,
  describeLive,
  inRollback,
  makeDriver,
  newRunId,
  OutcomeStats,
  resolvePlaceholders,
  seedGraph,
  shortId,
  snapshot,
} from './harness';
import { matchRoots } from './oracle';
import { CONTEXTS, POLICY_MIRROR, policies, typeDefs } from './schema';

jest.setTimeout(300_000);

type Rec = Record<string, unknown>;

describeLive('Property 2 — row cardinality (live Neo4j)', () => {
  const runId = newRunId();
  let driver: Driver;
  let plain: OGM;
  let guarded: OGM;
  const stats = new OutcomeStats('row-cardinality');

  beforeAll(async () => {
    driver = makeDriver();
    await driver.verifyConnectivity();
    await seedGraph(driver, runId);
    plain = new OGM({ typeDefs, driver });
    guarded = new OGM({
      typeDefs,
      driver,
      policies,
      policyDefaults: { auditMetadata: false },
    });
  });

  afterAll(async () => {
    stats.report();
    if (driver) {
      await cleanup(driver, runId);
      await driver.close();
    }
  });

  const ctxArb = fc.oneof(
    fc.constant(-1),
    fc.integer({ min: 0, max: CONTEXTS.length - 1 }),
  );

  it('update / updateMany return each matched root exactly once', async () => {
    await checkProperty(
      'row-cardinality',
      fc.record({
        ctx: ctxArb,
        op: writeOp({
          kinds: ['update', 'updateMany'],
          depth: 3,
          roots: ['ItPTag', 'ItPChart', 'ItPCategory'],
        }),
      }),
      async ({ ctx, op }) => {
        const ogm: OgmLike =
          ctx < 0 ? plain : guarded.withContext(CONTEXTS[ctx]);
        await inRollback(driver, async (tx) => {
          const before = await snapshot(tx, runId);
          if (op.kind !== 'update' && op.kind !== 'updateMany')
            throw new Error(`unexpected ${op.kind}`);
          const where = resolvePlaceholders(op.where, runId);
          const expected = matchRoots(before, op.model, where)
            .filter(
              (n) =>
                ctx < 0 ||
                POLICY_MIRROR.updatable(n.type, n.props, CONTEXTS[ctx]),
            )
            .map((n) => n.key)
            .sort();
          const outcome = await runWrite(ogm, op, runId, tx);
          if (!outcome.ok) {
            stats.add(
              `${outcome.kind}: ${outcome.summary.split('\n')[0].slice(0, 100)}`,
            );
            if (outcome.kind !== 'ogm')
              throw new Error(`server rejected the write: ${outcome.summary}`);
            return;
          }
          stats.add(
            `ok ${op.kind} (${expected.length === 0 ? 'zero' : expected.length === 1 ? 'one' : 'many'} roots)`,
          );
          // v2.6.1 (finding F6): `update` RETURNS only the updated roots the
          // context can read after the write; `updateMany` still counts all.
          let returned = expected;
          if (ctx >= 0 && op.kind === 'update') {
            const after = await snapshot(tx, runId);
            returned = expected.filter((k) => {
              const n = after.nodes.get(k);
              return n === undefined || POLICY_MIRROR.readable(n.type, n.props);
            });
          }
          checkRows(
            op,
            outcome.result as Rec,
            op.kind === 'update' ? returned : expected,
          );
        });
      },
      300,
    );
  });

  function checkRows(op: WriteOp, result: Rec, expected: string[]): void {
    const short = (ids: string[]) =>
      ids.map((i) => shortId(i, runId)).join(', ');
    if (op.kind === 'updateMany') {
      if (result.count !== expected.length)
        throw new Error(
          `updateMany count ${String(result.count)} ≠ ${expected.length} matched roots [${short(expected)}]`,
        );
      return;
    }
    const plural = Object.keys(result).find((k) => k !== 'info')!;
    const rows = result[plural] as Rec[];
    const got = rows.map((r) => r.id as string).sort();
    if (got.join('|') !== expected.join('|'))
      throw new Error(
        `update returned [${short(got)}], expected each matched root once: [${short(expected)}]`,
      );
  }
});
