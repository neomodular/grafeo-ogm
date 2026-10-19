/**
 * Property 3 — write scope.
 *
 * After a random write, the ONLY changes are: properties of roots matched
 * by `where` and of nodes reached by a nested `update`, nodes reached by a
 * nested / cascade `delete`, newly created nodes, and relationships of the
 * relationship type, direction and target labels that each op names,
 * between those nodes. Every other node and relationship of the run stays
 * byte-identical (type-exact snapshot diff, see `harness.snapshot`).
 *
 * The allowed envelope is derived from the INPUT and the static schema map,
 * never from the OGM (`oracle.writeEnvelope`). It ignores nested `where`s,
 * which can only narrow, so it is a superset — but it never widens past a
 * field's own relationship type and target labels, which is exactly what
 * the v2.5.0 interface regression (a nested delete on `resources` also
 * deleting `vaults` nodes sharing `ITP_RES`) violated.
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
import { scopeViolations, writeEnvelope } from './oracle';
import { typeDefs } from './schema';

jest.setTimeout(300_000);

describeLive('Property 3 — write scope (live Neo4j)', () => {
  const runId = newRunId();
  let driver: Driver;
  let ogm: OGM;
  const stats = new OutcomeStats('write-scope');

  beforeAll(async () => {
    driver = makeDriver();
    await driver.verifyConnectivity();
    await seedGraph(driver, runId);
    ogm = new OGM({ typeDefs, driver });
  });

  afterAll(async () => {
    stats.report();
    if (driver) {
      await cleanup(driver, runId);
      await driver.close();
    }
  });

  it('a write changes nothing outside the nodes and relationships its input names', async () => {
    await checkProperty(
      'write-scope',
      writeOp({ depth: 3 }),
      async (op) => {
        await inRollback(driver, async (tx) => {
          const before = await snapshot(tx, runId);
          const outcome = await runWrite(ogm, op, runId, tx);
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
          const violations = scopeViolations(diff, env);
          if (violations.length > 0)
            throw new Error(
              redact(
                `write changed the graph outside its scope:\n  ${violations.join('\n  ')}\nfull diff:\n${describeDiff(diff, runId)}`,
                runId,
              ),
            );
        });
      },
      400,
    );
  });
});
