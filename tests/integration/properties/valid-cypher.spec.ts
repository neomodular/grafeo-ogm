/**
 * Property 1 — valid Cypher or OGMError, never a server error.
 *
 * For random reads (`where` with operators, logical nesting, relationship
 * and connection filters; `selectionSet` with fragments, aliases,
 * connections and arguments; typed `select`; options) and random writes
 * (every model method, nested create / connect / disconnect / update /
 * delete at depth ≤ 3, concrete / interface / union targets), with and
 * without policies, the OGM either throws `OGMError` before anything is
 * sent, or Neo4j 5.26 accepts the statement. A `Neo.ClientError.Statement.*`
 * (or any non-OGM error) fails the property. An `OGMError` must also leave
 * the graph untouched.
 *
 * Opt-in on NEO4J_URI; seed graph tagged with this run's `runId`, removed
 * in afterAll; every case runs in a rolled-back transaction.
 */
import fc from 'fast-check';
import type { Driver } from 'neo4j-driver';
import { OGM } from '../../../src/ogm';
import { readOp, writeOp } from './arbitraries';
import { runRead, runWrite, type OgmLike } from './exec';
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
  seedGraph,
  snapshot,
} from './harness';
import { CONTEXTS, policies, typeDefs } from './schema';

jest.setTimeout(300_000);

describeLive('Property 1 — valid Cypher or OGMError (live Neo4j)', () => {
  const runId = newRunId();
  let driver: Driver;
  let plain: OGM;
  let guarded: OGM;
  const readStats = new OutcomeStats('valid-cypher/read');
  const writeStats = new OutcomeStats('valid-cypher/write');

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
    readStats.report();
    writeStats.report();
    if (driver) {
      await cleanup(driver, runId);
      await driver.close();
    }
  });

  /** No policies, or bound to one of the fixture contexts. */
  const ogmArb = fc.oneof(
    fc.constant(-1),
    fc.integer({ min: 0, max: CONTEXTS.length - 1 }),
  );
  const pick = (i: number): OgmLike =>
    i < 0 ? plain : guarded.withContext(CONTEXTS[i]);

  it('random reads compile to Cypher Neo4j accepts, or throw OGMError', async () => {
    await checkProperty(
      'valid-cypher/read',
      fc.record({ ctx: ogmArb, op: readOp(2) }),
      async ({ ctx, op }) => {
        const outcome = await inRollback(driver, (tx) =>
          runRead(pick(ctx), op, runId, tx),
        );
        readStats.add(
          outcome.ok
            ? `ok ${op.kind}`
            : `${outcome.kind}: ${outcome.summary.split('\n')[0].slice(0, 110)}`,
        );
        if (!outcome.ok && outcome.kind !== 'ogm')
          throw new Error(
            `read was rejected by the server (${outcome.kind}): ${outcome.summary}`,
          );
      },
      300,
    );
  });

  it('random writes compile to Cypher Neo4j accepts, or throw OGMError and write nothing', async () => {
    await checkProperty(
      'valid-cypher/write',
      fc.record({ ctx: ogmArb, op: writeOp({ depth: 3 }) }),
      async ({ ctx, op }) => {
        await inRollback(driver, async (tx) => {
          const before = await snapshot(tx, runId);
          const outcome = await runWrite(pick(ctx), op, runId, tx);
          writeStats.add(
            outcome.ok
              ? `ok ${op.kind}`
              : `${outcome.kind}: ${outcome.summary.split('\n')[0].slice(0, 110)}`,
          );
          if (!outcome.ok && outcome.kind !== 'ogm')
            throw new Error(
              `write was rejected by the server (${outcome.kind}): ${outcome.summary}`,
            );
          if (!outcome.ok) {
            const diff = diffSnapshots(before, await snapshot(tx, runId));
            if (!isEmptyDiff(diff))
              throw new Error(
                `OGMError (${outcome.summary}) but the graph changed:\n${describeDiff(diff, runId)}`,
              );
          }
        });
      },
      400,
    );
  });
});
