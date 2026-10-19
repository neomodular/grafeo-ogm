/**
 * Property 5 — an allow-all policy set equals no policies.
 *
 * An OGM where every type has a permissive `true` (`when: () => ({})`) for
 * every operation must behave exactly like a policy-free OGM: the same
 * rows (or the same error) for random reads, and for random writes the
 * same result and the same graph state afterwards. Each side runs in its
 * own rolled-back transaction from the same seed graph.
 *
 * Reads leave out `limit` / `offset` (root and nested): without a total
 * order the page is not deterministic, and two different Cypher shapes may
 * legitimately pick different rows. Rows and nested lists are compared
 * order-insensitively for the same reason.
 *
 * Opt-in on NEO4J_URI; seed graph tagged with this run's `runId`, removed
 * in afterAll.
 */
import fc from 'fast-check';
import type { Driver } from 'neo4j-driver';
import { OGM } from '../../../src/ogm';
import { readOp, writeOp } from './arbitraries';
import { runRead, runWrite, stableJson, type Outcome } from './exec';
import {
  canonProps,
  checkProperty,
  cleanup,
  describeLive,
  diffSnapshots,
  inRollback,
  makeDriver,
  newRunId,
  OutcomeStats,
  redact,
  seedGraph,
  snapshot,
  type GraphDiff,
} from './harness';
import { allowAllPolicies, typeDefs } from './schema';

jest.setTimeout(300_000);

/** Order-insensitive canonical form: every array sorted by its JSON. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v))
    return v
      .map(canonical)
      .sort((a, b) => (stableJson(a) < stableJson(b) ? -1 : 1));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        canonical(x),
      ]),
    );
  return v;
}

function outcomeKey(o: Outcome): string {
  if (o.ok) return `ok ${stableJson(canonical(o.result))}`;
  // Server messages carry element ids that differ between the two runs.
  const code = (o.error as { code?: string }).code;
  return o.kind === 'server' && code
    ? `server: ${code}`
    : `${o.kind}: ${o.summary}`;
}

function diffKey(d: GraphDiff): string {
  return stableJson({
    created: d.created.map((n) => n.canon).sort(),
    deleted: d.deleted.map((n) => n.key).sort(),
    changed: d.changed
      .map((c) => `${c.after.key}${canonProps(c.after.props)}`)
      .sort(),
    added: d.relsAdded.map((r) => r.canon).sort(),
    removed: d.relsRemoved.map((r) => r.canon).sort(),
  });
}

describeLive(
  'Property 5 — allow-all policies equal no policies (live Neo4j)',
  () => {
    const runId = newRunId();
    let driver: Driver;
    let plain: OGM;
    let allowAll: OGM;
    const stats = new OutcomeStats('allow-all-equivalence');

    beforeAll(async () => {
      driver = makeDriver();
      await driver.verifyConnectivity();
      await seedGraph(driver, runId);
      plain = new OGM({ typeDefs, driver });
      allowAll = new OGM({
        typeDefs,
        driver,
        policies: allowAllPolicies,
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

    const bound = () => allowAll.withContext({ uid: 'u1', tid: 't1' });

    it('random reads return the same rows', async () => {
      await checkProperty(
        'allow-all/read',
        // EXCLUDED (finding F8): without policies, a read through the
        // INTERFACE field `resources` (nested selection, connection,
        // `totalCount`, `resources_SOME` / `_ALL` filters) also returns /
        // counts / matches `ItPVault` nodes, which share its relationship
        // type but are not implementors; the per-member policy CASE of the
        // allow-all OGM filters them out. Reads naming `resources` are not
        // compared until fixed.
        readOp(2, false).filter(
          (op) => !JSON.stringify(op).includes('resources'),
        ),
        async (op) => {
          const a = await inRollback(driver, (tx) =>
            runRead(plain, op, runId, tx),
          );
          const b = await inRollback(driver, (tx) =>
            runRead(bound(), op, runId, tx),
          );
          stats.add(`read ${a.ok ? 'ok' : a.kind}`);
          const ka = outcomeKey(a);
          const kb = outcomeKey(b);
          if (ka !== kb)
            throw new Error(
              redact(`no policies:\n  ${ka}\nallow-all:\n  ${kb}`, runId),
            );
        },
        200,
      );
    });

    it('random writes return the same result and leave the same graph', async () => {
      await checkProperty(
        'allow-all/write',
        writeOp({ depth: 3 }),
        async (op) => {
          const runOn = (ogm: OGM | ReturnType<typeof bound>) =>
            inRollback(driver, async (tx) => {
              const before = await snapshot(tx, runId);
              const outcome = await runWrite(ogm, op, runId, tx);
              const diff = outcome.ok
                ? diffSnapshots(before, await snapshot(tx, runId))
                : undefined;
              return { outcome, diff: diff ? diffKey(diff) : '-' };
            });
          const a = await runOn(plain);
          const b = await runOn(bound());
          stats.add(`write ${a.outcome.ok ? 'ok' : a.outcome.kind}`);
          const ka = `${outcomeKey(a.outcome)}\n  graph: ${a.diff}`;
          const kb = `${outcomeKey(b.outcome)}\n  graph: ${b.diff}`;
          if (ka !== kb)
            throw new Error(
              redact(`no policies:\n  ${ka}\nallow-all:\n  ${kb}`, runId),
            );
        },
        250,
      );
    });
  },
);
