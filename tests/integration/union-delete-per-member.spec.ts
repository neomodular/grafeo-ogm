/**
 * v2.6.2 — property-suite finding F4: a root cascade delete on a union
 * field keyed per member (`{ items: { ItPChart: [...] } }`), exactly as the
 * generated `ItPTagItemsDeleteInput` types it, threw
 * `Unknown key "ItPChart" in a nested delete`; only the flat item list ran.
 *
 * Opt-in on NEO4J_URI; property-suite schema and seed (`ItP*` labels, one
 * runId, removed in afterAll); every case runs in a rolled-back transaction.
 */
import { OGM } from '../../src/ogm';
import { describeLive, inRollback } from './properties/harness';
import { useItpFixture } from './properties/fixture';
import { policies, typeDefs } from './properties/schema';

jest.setTimeout(120_000);

describeLive('union cascade delete keyed per member (live Neo4j)', () => {
  const f = useItpFixture();

  it('deletes each member’s matching targets', async () => {
    await inRollback(f.driver, async (tx) => {
      const res = await f.model('ItPTag').delete({
        where: { id: f.id('t1') },
        delete: {
          items: {
            ItPChart: [{ where: { node: { id: f.id('c1') } } }],
            ItPDoc: [{ where: { node: { name: 'b' } } }],
          },
        },
        context: { transaction: tx },
      });
      // t1, c1 and o2 (t1's items: c1, o1 'a', o2 'b').
      expect(res.nodesDeleted).toBe(3);
      expect(
        await f.ids(
          tx,
          'MATCH (x {runId: $runId}) WHERE x:ItPTag OR x:ItPChart OR x:ItPDoc RETURN x.id',
        ),
      ).toEqual(['c2', 'c3', 'c4', 'c5', 'o1', 'o3', 't2', 't3', 't4']);
    });
  });

  it('gates each member’s targets by that member’s delete policy', async () => {
    const guarded = new OGM({
      typeDefs,
      driver: f.driver,
      policies,
      policyDefaults: { auditMetadata: false },
    });
    await inRollback(f.driver, async (tx) => {
      // c1 belongs to u1, so u2's cascade must leave it.
      await f
        .model('ItPTag', guarded.withContext({ uid: 'u2', tid: 't1' }))
        .delete({
          where: { id: f.id('t1') },
          delete: { items: { ItPChart: [{}] } },
          context: { transaction: tx },
        });
      expect(
        await f.ids(tx, 'MATCH (c:ItPChart {runId: $runId}) RETURN c.id'),
      ).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    });
  });

  it('still accepts the flat item list', async () => {
    await inRollback(f.driver, async (tx) => {
      const res = await f.model('ItPTag').delete({
        where: { id: f.id('t1') },
        delete: { items: [{ where: { node: { name: 'a' } } }] },
        context: { transaction: tx },
      });
      // t1, c1 'a', o1 'a'.
      expect(res.nodesDeleted).toBe(3);
    });
  });

  it('rejects member keys mixed with item keys', async () => {
    await expect(
      f.model('ItPTag').delete({
        where: { id: f.id('t1') },
        delete: { items: { ItPChart: [{}], where: {} } },
      }),
    ).rejects.toThrow(/Key it by member type/);
  });
});
