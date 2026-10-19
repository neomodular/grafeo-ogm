/**
 * Property 4 — policy containment (node-level security).
 *
 * The same random nested writes as property 3, run through an OGM bound to
 * a policy context (the fixture policy shapes: owner-only update / delete,
 * tenant WITH CHECK, read restrictive, default-deny type). After the write:
 *
 * - every relationship added or removed has both endpoints READABLE by the
 *   context (or created by this write);
 * - for every such relationship, the endpoint whose own relationship set
 *   the write changed (the "owner": the root, an intermediate of a nested
 *   connect / disconnect, the parent of a nested create) is UPDATABLE, or
 *   CREATED in this write;
 * - every node whose properties changed is updatable (and its new values
 *   pass the update WITH CHECK); every created node passes its create
 *   policy; every deleted node is deletable;
 * - and nothing changed outside the write's envelope (property 3).
 *
 * "Readable", "updatable", "deletable", "creatable" come from
 * `POLICY_MIRROR` — the policies restated as JS predicates over the
 * snapshot — never from the OGM's compiled predicates. A sanity test pins
 * the mirror against the OGM's own `find` for every type and context.
 *
 * Opt-in on NEO4J_URI; seed graph tagged with this run's `runId`, removed
 * in afterAll; every case runs in a rolled-back transaction.
 */
import fc from 'fast-check';
import type { Driver } from 'neo4j-driver';
import { OGM } from '../../../src/ogm';
import { writeOp } from './arbitraries';
import { runWrite } from './exec';
import {
  checkProperty,
  cleanup,
  describeDiff,
  describeLive,
  diffSnapshots,
  inRollback,
  isEmptyDiff,
  makeDriver,
  newRunId,
  OutcomeStats,
  redact,
  resolvePlaceholders,
  seedGraph,
  snapshot,
} from './harness';
import { policyViolations, scopeViolations, writeEnvelope } from './oracle';
import {
  CONTEXTS,
  GRAPH_TYPES,
  POLICY_MIRROR,
  policies,
  typeDefs,
} from './schema';

jest.setTimeout(300_000);

describeLive('Property 4 — policy containment (live Neo4j)', () => {
  const runId = newRunId();
  let driver: Driver;
  let ogm: OGM;
  const stats = new OutcomeStats('policy-containment');

  beforeAll(async () => {
    driver = makeDriver();
    await driver.verifyConnectivity();
    await seedGraph(driver, runId);
    ogm = new OGM({
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

  it('the policy mirror agrees with the OGM read path for every type and context', async () => {
    await inRollback(driver, async (tx) => {
      const snap = await snapshot(tx, runId);
      for (const ctx of CONTEXTS)
        for (const type of GRAPH_TYPES) {
          const rows = (await ogm
            .withContext(ctx)
            .model(type)
            .find({
              where: { runId },
              selectionSet: '{ id }',
              context: { transaction: tx },
            })) as Array<{
            id: string;
          }>;
          const expected = [...snap.nodes.values()]
            .filter(
              (n) => n.type === type && POLICY_MIRROR.readable(type, n.props),
            )
            .map((n) => n.key)
            .sort();
          expect({ ctx, type, ids: rows.map((r) => r.id).sort() }).toEqual({
            ctx,
            type,
            ids: expected,
          });
        }
    });
  });

  it('a policy-bound nested write only touches what the context may read, update, create and delete', async () => {
    await checkProperty(
      'policy-containment',
      fc.record({
        ctx: fc.integer({ min: 0, max: CONTEXTS.length - 1 }),
        // Finding F7 (fixed in v2.6.1): `upsert` on an EXISTING node now
        // applies the type's `update` row filter, so upserts on existing
        // ItPChart nodes are generated again.
        op: writeOp({ depth: 3 }),
      }),
      async ({ ctx, op }) => {
        const context = CONTEXTS[ctx];
        await inRollback(driver, async (tx) => {
          const before = await snapshot(tx, runId);
          const outcome = await runWrite(
            ogm.withContext(context),
            op,
            runId,
            tx,
          );
          const after = await snapshot(tx, runId);
          const diff = diffSnapshots(before, after);
          if (!outcome.ok) {
            stats.add(
              `${outcome.kind}: ${outcome.summary.split('\n')[0].slice(0, 100)}`,
            );
            if (outcome.kind !== 'ogm')
              throw new Error(`server rejected the write: ${outcome.summary}`);
            if (!isEmptyDiff(diff))
              throw new Error(
                `OGMError but the graph changed:\n${describeDiff(diff, runId)}`,
              );
            return;
          }
          stats.add(`ok ${op.kind}${isEmptyDiff(diff) ? ' (no change)' : ''}`);
          const env = writeEnvelope(
            resolvePlaceholders(op, runId),
            before,
            after,
          );
          const violations = [
            ...scopeViolations(diff, env),
            ...policyViolations(diff, env, before, after, context),
          ];
          if (violations.length > 0)
            throw new Error(
              redact(
                `policy-bound write (ctx ${JSON.stringify(context)}) broke containment:\n  ${violations.join('\n  ')}\nfull diff:\n${describeDiff(diff, runId)}`,
                runId,
              ),
            );
        });
      },
      500,
    );
  });
});
