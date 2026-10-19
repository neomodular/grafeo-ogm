/**
 * v2.8.0 — property-suite finding F9 (allow-all-equivalence "random
 * writes" failing intermittently). Not an OGM bug: a nested write that runs
 * for several rows creates several nodes with the SAME input `id`, and the
 * suite's snapshot keyed nodes by `id`, so it kept whichever duplicate the
 * snapshot query returned last. Pinned here:
 *
 * - Nested ops run once per matched row, in item order, and each run sees
 *   what the earlier runs of the same statement wrote (as in
 *   @neo4j/graphql). Within one row, an `update` item does not match the
 *   node a LATER sibling item creates; a later row that reaches the same
 *   intermediate node does.
 * - The policy-free and the allow-all OGM leave the same graph (as a
 *   multiset of nodes) for that write.
 *
 * Opt-in on NEO4J_URI; property-suite schema and seed (`ItP*` labels, one
 * runId, removed in afterAll); every case runs in a rolled-back
 * transaction.
 */
import type { Transaction } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { describeLive, inRollback } from './properties/harness';
import { useItpFixture, type Rec } from './properties/fixture';
import { allowAllPolicies, typeDefs } from './properties/schema';

jest.setTimeout(120_000);

describeLive(
  'nested writes see the earlier rows of their statement (live Neo4j)',
  () => {
    const f = useItpFixture();
    let allowAll: OGM;

    beforeAll(() => {
      allowAll = new OGM({
        typeDefs,
        driver: f.driver,
        policies: allowAllPolicies,
        policyDefaults: { auditMetadata: false },
      });
    });

    /** `updateMany` on charts: under each tag, rename its resources, then create n3. */
    const write = (ids: string[]) => ({
      where: { id_IN: ids.map(f.id) },
      data: {
        tags: [
          {
            update: {
              node: {
                resources: [
                  { update: { node: { name: 'a' } } },
                  {
                    create: [
                      {
                        node: {
                          ItPChart: {
                            id: f.id('n3'),
                            runId: f.runId,
                            tenantId: 't1',
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    });

    async function created(tx: Transaction): Promise<string[]> {
      const res = await tx.run(
        `MATCH (t:ItPTag {runId: $runId})-[:ITP_RES]->(c:ItPChart {id: $id})
       RETURN t.id AS tag, c.name AS name ORDER BY tag, name`,
        { runId: f.runId, id: f.id('n3') },
      );
      return res.records.map(
        (r) => `${f.short(r.get('tag'))}:${String(r.get('name'))}`,
      );
    }

    const run = (ogm: Pick<OGM, 'model'>, ids: string[]) =>
      inRollback(f.driver, async (tx) => {
        const model = ogm.model('ItPChart') as unknown as {
          updateMany(p: Rec): Promise<{ count: number }>;
        };
        await model.updateMany({ ...write(ids), context: { transaction: tx } });
        return created(tx);
      });

    it('one row: an update item does not match the node a later sibling item creates', async () => {
      // c1 is tagged t1 only.
      expect(await run(f.ogm, ['c1'])).toEqual(['t1:null']);
    });

    it('several rows: a later row reaching the same tag matches what an earlier row created', async () => {
      // Rows (c1, t1), (c2, t1), (c2, t2): t1's two runs create two n3, the
      // second run renames the first one; t2's single run renames none.
      expect(await run(f.ogm, ['c1', 'c2'])).toEqual([
        't1:a',
        't1:null',
        't2:null',
      ]);
    });

    it('allow-all policies leave the same nodes as no policies', async () => {
      const bound = allowAll.withContext({ uid: 'u1', tid: 't1' });
      expect(await run(bound, ['c1', 'c2'])).toEqual(
        await run(f.ogm, ['c1', 'c2']),
      );
    });
  },
);
