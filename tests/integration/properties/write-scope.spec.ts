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
 * The strict variant runs a `strict: true` OGM on the same writes plus the
 * shapes only strict mode keeps in scope: a blanket disconnect on a
 * relationship type two fields share (finding F5, v2.6.0 strict item 4),
 * and a nested delete reached through a cycle (finding F1, v2.8.0).
 *
 * Opt-in on NEO4J_URI; seed graph tagged with this run's `runId`, removed
 * in afterAll; every case runs in a rolled-back transaction.
 */
import fc from 'fast-check';
import type { Driver } from 'neo4j-driver';
import { OGM } from '../../../src/ogm';
import {
  hasCycleDelete,
  hasSharedBlanketDisconnect,
  writeOp,
} from './arbitraries';
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
  let strictOgm: OGM;
  const stats = new OutcomeStats('write-scope');

  beforeAll(async () => {
    driver = makeDriver();
    await driver.verifyConnectivity();
    await seedGraph(driver, runId);
    ogm = new OGM({ typeDefs, driver });
    strictOgm = new OGM({ typeDefs, driver, strict: true });
  });

  afterAll(async () => {
    stats.report();
    if (driver) {
      await cleanup(driver, runId);
      await driver.close();
    }
  });

  async function checkScope(
    target: OGM,
    op: Parameters<typeof runWrite>[1],
    label: string,
  ): Promise<void> {
    await inRollback(driver, async (tx) => {
      const before = await snapshot(tx, runId);
      const outcome = await runWrite(target, op, runId, tx);
      const after = await snapshot(tx, runId);
      const diff = diffSnapshots(before, after);
      if (!outcome.ok) {
        stats.add(
          `${label}${outcome.kind}: ${outcome.summary.split('\n')[0].slice(0, 100)}`,
        );
        if (outcome.kind !== 'ogm')
          throw new Error(`server rejected the write: ${outcome.summary}`);
        if (!isEmptyDiff(diff))
          throw new Error(
            `OGMError but the graph changed:\n${describeDiff(diff, runId)}`,
          );
        return;
      }
      stats.add(
        `${label}ok ${op.kind}${isEmptyDiff(diff) ? ' (no change)' : ''}`,
      );
      const env = writeEnvelope(resolvePlaceholders(op, runId), before, after);
      const violations = scopeViolations(diff, env);
      if (violations.length > 0)
        throw new Error(
          redact(
            `write changed the graph outside its scope:\n  ${violations.join('\n  ')}\nfull diff:\n${describeDiff(diff, runId)}`,
            runId,
          ),
        );
    });
  }

  it('a write changes nothing outside the nodes and relationships its input names', async () => {
    await checkProperty(
      'write-scope',
      writeOp({ depth: 3 }),
      (op) => checkScope(ogm, op, ''),
      400,
    );
  });

  it('strict: the same, blanket disconnects on a shared relationship type and deletes through a cycle included', async () => {
    await checkProperty(
      'write-scope/strict',
      writeOp({ depth: 3, sharedBlanketDisconnect: true, cycleDelete: true }),
      (op) =>
        checkScope(
          strictOgm,
          op,
          `strict ${hasSharedBlanketDisconnect(op) ? 'F5 ' : ''}${hasCycleDelete(op) ? 'F1 ' : ''}`,
        ),
      400,
    );
  });

  it('strict: a blanket disconnect on a shared relationship type unlinks only its field’s targets', async () => {
    // F5's shape alone (rare in the general generator), on its roots.
    await checkProperty(
      'write-scope/strict-F5',
      writeOp({
        depth: 2,
        kinds: ['update', 'updateMany'],
        roots: ['ItPTag', 'ItPChart'],
        sharedBlanketDisconnect: true,
      }).filter(hasSharedBlanketDisconnect),
      (op) => checkScope(strictOgm, op, 'strict F5 '),
      150,
    );
  });

  it('strict: a nested delete reached through a cycle stays in scope', async () => {
    // F1's shape alone (rare in the general generator).
    await checkProperty(
      'write-scope/strict-F1',
      writeOp({
        depth: 3,
        kinds: ['update', 'updateMany'],
        roots: ['ItPTag', 'ItPChart', 'ItPCategory'],
        cycleDelete: true,
      }).filter(hasCycleDelete),
      (op) => checkScope(strictOgm, op, 'strict F1 '),
      150,
    );
  });
});
