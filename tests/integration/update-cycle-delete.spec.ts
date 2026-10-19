/**
 * v2.6.2 — property-suite finding F1: a nested `delete` reached through a
 * cycle (chart -> tags -> charts) can delete a node the update is still
 * writing — the root, or an intermediate nested-update target. Every later
 * clause that touched it failed on the server with
 * `Neo.ClientError.Statement.EntityNotFound`, so the whole update failed.
 * Now a deleted node's remaining nested writes are skipped and a deleted
 * root is omitted from the response.
 *
 * Opt-in on NEO4J_URI; property-suite schema and seed (`ItP*` labels, one
 * runId, removed in afterAll); every case runs in a rolled-back transaction.
 */
import { describeLive, inRollback } from './properties/harness';
import { useItpFixture, type Rec } from './properties/fixture';

jest.setTimeout(120_000);

describeLive('nested delete through a cycle (live Neo4j)', () => {
  const f = useItpFixture();

  it('omits a root deleted through the cycle from the response', async () => {
    await inRollback(f.driver, async (tx) => {
      const res = await f.model('ItPChart').update({
        where: { id: f.id('c1') },
        update: {
          tags: [{ update: { node: { charts: [{ delete: [{}] }] } } }],
        },
        selectionSet: '{ id name tags { id } }',
        context: { transaction: tx },
      });
      expect(res.itPCharts).toEqual([]);
      // t1's charts: c1 (the root), c2, c3.
      expect(res.info.nodesDeleted).toBe(3);
      expect(
        await f.ids(tx, 'MATCH (c:ItPChart {runId: $runId}) RETURN c.id'),
      ).toEqual(['c4', 'c5']);
    });
  });

  it('keeps the roots that survive, and updateMany counts only those', async () => {
    await inRollback(f.driver, async (tx) => {
      // c1 is tagged t1, c4 is tagged t2; t2's charts (c2, c4) are deleted.
      const where = { id_IN: [f.id('c1'), f.id('c4')] };
      const update = {
        name: 'z',
        tags: [
          {
            where: { node: { id: f.id('t2') } },
            update: { node: { charts: [{ delete: [{}] }] } },
          },
        ],
      };
      const res = await f.model('ItPChart').update({
        where,
        update,
        selectionSet: '{ id name }',
        context: { transaction: tx },
      });
      expect(res.itPCharts).toEqual([{ id: f.id('c1'), name: 'z' }]);
      expect(res.info.nodesDeleted).toBe(2);
    });
    await inRollback(f.driver, async (tx) => {
      const res = await (
        f.model('ItPChart') as unknown as {
          updateMany(p: Rec): Promise<{ count: number }>;
        }
      ).updateMany({
        where: { id_IN: [f.id('c1'), f.id('c4')] },
        data: {
          tags: [
            {
              where: { node: { id: f.id('t2') } },
              update: { node: { charts: [{ delete: [{}] }] } },
            },
          ],
        },
        context: { transaction: tx },
      });
      expect(res.count).toBe(1);
    });
  });

  it('skips the remaining nested writes of a deleted intermediate node', async () => {
    await inRollback(f.driver, async (tx) => {
      const res = await f.model('ItPTag').update({
        where: { id: f.id('t1') },
        update: {
          name: 'renamed',
          charts: [
            {
              where: { node: { id: f.id('c1') } },
              update: {
                node: {
                  tags: [
                    {
                      update: {
                        node: {
                          charts: [
                            {
                              delete: [{ where: { node: { id: f.id('c1') } } }],
                            },
                          ],
                        },
                      },
                    },
                  ],
                  categories: [
                    { create: [{ node: { id: f.id('kx'), runId: f.runId } }] },
                  ],
                },
              },
            },
          ],
        },
        selectionSet: '{ id name charts { id } }',
        context: { transaction: tx },
      });
      expect(
        (res.itPTags as Rec[]).map((t) => ({
          id: f.short(t.id),
          name: t.name,
          charts: (t.charts as Rec[]).map((c) => f.short(c.id)).sort(),
        })),
      ).toEqual([{ id: 't1', name: 'renamed', charts: ['c2', 'c3'] }]);
      expect(res.info.nodesDeleted).toBe(1);
      expect(res.info.nodesCreated).toBe(0);
    });
  });
});
