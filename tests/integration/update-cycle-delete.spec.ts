/**
 * v2.8.0 — property-suite finding F1: a nested `delete` reached through a
 * cycle (chart -> tags -> charts) can delete a node the update still holds,
 * the root or an intermediate nested-update target. A later clause that
 * reads or writes it (the root's response projection, a CREATE from it)
 * failed on the server with `Neo.ClientError.Statement.EntityNotFound`, so
 * the whole update failed; `updateMany` with no such later clause counted
 * the deleted root.
 *
 * - strict: the deleted node's remaining writes are skipped and a deleted
 *   root leaves the response and the count, in any transaction.
 * - default: the v2.7.0 statement runs unchanged (so `updateMany` still
 *   counts a deleted root, with a warning). One that fails with
 *   `EntityNotFound` is re-run with the guard when the OGM owns the
 *   transaction; in a caller transaction it still fails (and warns).
 *
 * Opt-in on NEO4J_URI; property-suite schema and seed (`ItP*` labels, one
 * runId, removed in afterAll). The caller-transaction cases roll back; the
 * auto-commit cases write their own runId-tagged subgraph.
 */
import type { Session } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { describeLive, inRollback } from './properties/harness';
import { useItpFixture, type Rec } from './properties/fixture';
import { typeDefs } from './properties/schema';

jest.setTimeout(120_000);

interface Many {
  updateMany(p: Rec): Promise<{ count: number }>;
}

describeLive('nested delete through a cycle (live Neo4j)', () => {
  const f = useItpFixture();
  const many = (ogm?: OGM) => f.model('ItPChart', ogm) as unknown as Many;
  const cycle = {
    tags: [{ update: { node: { charts: [{ delete: [{}] }] } } }],
  };

  describe('strict', () => {
    it('omits a root deleted through the cycle from the response', async () => {
      await inRollback(f.driver, async (tx) => {
        const res = await f.model('ItPChart', f.strictOgm).update({
          where: { id: f.id('c1') },
          update: cycle,
          selectionSet: '{ itPCharts { id name tags { id } } }',
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
      // c1 is tagged t1, c4 is tagged t2; t2's charts (c2, c4) are deleted.
      const data = {
        name: 'z',
        tags: [
          {
            where: { node: { id: f.id('t2') } },
            update: { node: { charts: [{ delete: [{}] }] } },
          },
        ],
      };
      await inRollback(f.driver, async (tx) => {
        const res = await f.model('ItPChart', f.strictOgm).update({
          where: { id_IN: [f.id('c1'), f.id('c4')] },
          update: data,
          selectionSet: '{ itPCharts { id name } }',
          context: { transaction: tx },
        });
        expect(res.itPCharts).toEqual([{ id: f.id('c1'), name: 'z' }]);
        expect(res.info.nodesDeleted).toBe(2);
      });
      await inRollback(f.driver, async (tx) => {
        const res = await many(f.strictOgm).updateMany({
          where: { id_IN: [f.id('c1'), f.id('c4')] },
          data,
          context: { transaction: tx },
        });
        expect(res.count).toBe(1);
      });
    });

    it('skips the remaining nested writes of a deleted intermediate node', async () => {
      await inRollback(f.driver, async (tx) => {
        const res = await f.model('ItPTag', f.strictOgm).update({
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
                                delete: [
                                  { where: { node: { id: f.id('c1') } } },
                                ],
                              },
                            ],
                          },
                        },
                      },
                    ],
                    categories: [
                      {
                        create: [{ node: { id: f.id('kx'), runId: f.runId } }],
                      },
                    ],
                  },
                },
              },
            ],
          },
          selectionSet: '{ itPTags { id name charts { id } } }',
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

    it("drops a root that another root's cycle deleted before its own writes ran", async () => {
      // Roots c1 and c2 share t1. The delete (under t1, matching c2) runs
      // for whichever root comes first and removes c2; c2's own nested
      // ops then match nothing, and its later create must not run.
      const data = {
        name: 'z',
        tags: [
          {
            where: { node: { id: f.id('t1') } },
            update: {
              node: {
                charts: [{ delete: [{ where: { node: { id: f.id('c2') } } }] }],
              },
            },
          },
        ],
        categories: [
          { create: [{ node: { id: f.id('kz'), runId: f.runId } }] },
        ],
      };
      await inRollback(f.driver, async (tx) => {
        const res = await f.model('ItPChart', f.strictOgm).update({
          where: { id_IN: [f.id('c1'), f.id('c2')] },
          update: data,
          selectionSet: '{ itPCharts { id name categories { id } } }',
          context: { transaction: tx },
        });
        expect(
          (res.itPCharts as Rec[]).map((c) => ({
            id: f.short(c.id),
            name: c.name,
            categories: (c.categories as Rec[])
              .map((k) => f.short(k.id))
              .sort(),
          })),
        ).toEqual([{ id: 'c1', name: 'z', categories: ['k1', 'k2', 'kz'] }]);
        expect(res.info.nodesDeleted).toBe(1);
        expect(res.info.nodesCreated).toBe(1);
      });
      await inRollback(f.driver, async (tx) => {
        const res = await many(f.strictOgm).updateMany({
          where: { id_IN: [f.id('c1'), f.id('c2')] },
          data,
          context: { transaction: tx },
        });
        expect(res.count).toBe(1);
        expect(
          await f.ids(
            tx,
            'MATCH (c:ItPChart {runId: $runId})-[:ITP_IN_CAT]->(:ItPCategory {id: $runId + "-kz"}) RETURN c.id',
          ),
        ).toEqual(['c1']);
      });
    });
  });

  describe('default mode, in a caller transaction', () => {
    it('updateMany still counts a deleted root, and warns', async () => {
      await inRollback(f.driver, async (tx) => {
        const res = await many().updateMany({
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
        expect(res.count).toBe(2);
      });
      expect(
        f.warnings.some((w) =>
          w.includes('updateMany on ItPChart has a nested delete'),
        ),
      ).toBe(true);
    });

    it('a statement that touches the deleted root still fails, and warns', async () => {
      await inRollback(f.driver, async (tx) => {
        await expect(
          f.model('ItPChart').update({
            where: { id: f.id('c1') },
            update: cycle,
            selectionSet: '{ itPCharts { id } }',
            context: { transaction: tx },
          }),
        ).rejects.toMatchObject({
          code: 'Neo.ClientError.Statement.EntityNotFound',
        });
      });
      expect(
        f.warnings.some((w) =>
          w.includes('update on ItPChart failed with EntityNotFound'),
        ),
      ).toBe(true);
    });
  });

  describe('default mode, in a transaction the OGM owns', () => {
    let ogm: OGM;
    const warnings: string[] = [];
    let seq = 0;

    beforeAll(() => {
      ogm = new OGM({
        typeDefs,
        driver: f.driver,
        logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
      });
    });

    /** A committed copy of t1 -> {a, b, c} under fresh ids; returns them. */
    async function seedCopy() {
      const p = `${f.runId}-x${++seq}`;
      const session = f.driver.session();
      try {
        await session.run(
          `CREATE (t:ItPTag {id: $p + '-t', runId: $runId})
           WITH t UNWIND ['a', 'b', 'c'] AS s
           CREATE (t)-[:ITP_TAGS]->(:ItPChart {id: $p + '-' + s, runId: $runId, name: s})`,
          { p, runId: f.runId },
        );
      } finally {
        await session.close();
      }
      return { t: `${p}-t`, a: `${p}-a`, b: `${p}-b`, c: `${p}-c` };
    }

    async function chartIds(ids: string[]): Promise<string[]> {
      const session = f.driver.session();
      try {
        const res = await session.run(
          'MATCH (c:ItPChart) WHERE c.id IN $ids RETURN c.id AS id ORDER BY id',
          { ids },
        );
        return res.records.map((r) => r.get('id') as string);
      } finally {
        await session.close();
      }
    }

    it('re-runs a failed update with the guard: the deleted root leaves the response', async () => {
      const s = await seedCopy();
      const res = await f.model('ItPChart', ogm).update({
        where: { id: s.a },
        update: cycle,
        selectionSet: '{ itPCharts { id } }',
      });
      expect(res.itPCharts).toEqual([]);
      expect(res.info.nodesDeleted).toBe(3);
      expect(await chartIds([s.a, s.b, s.c])).toEqual([]);
    });

    it('re-runs a failed updateMany with the guard: a later create is skipped for the deleted roots', async () => {
      const s = await seedCopy();
      const res = await many(ogm).updateMany({
        where: { id_IN: [s.a, s.b] },
        data: {
          tags: [
            {
              update: {
                node: {
                  charts: [{ delete: [{ where: { node: { id: s.b } } }] }],
                },
              },
            },
          ],
          categories: [
            { create: [{ node: { id: `${s.t}-k`, runId: f.runId } }] },
          ],
        },
      });
      expect(res.count).toBe(1);
      expect(await chartIds([s.a, s.b, s.c])).toEqual([s.a, s.c]);
    });

    it('re-runs in a caller session too', async () => {
      const s = await seedCopy();
      const session: Session = f.driver.session();
      try {
        const res = await f.model('ItPChart', ogm).update({
          where: { id: s.a },
          update: cycle,
          selectionSet: '{ itPCharts { id } }',
          context: { session },
        });
        expect(res.itPCharts).toEqual([]);
      } finally {
        await session.close();
      }
      expect(await chartIds([s.a, s.b, s.c])).toEqual([]);
    });
  });
});
