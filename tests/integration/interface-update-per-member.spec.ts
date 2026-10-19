/**
 * v2.6.2 — property-suite finding F3: in a nested update of an interface
 * field, the generated `ItPResourceUpdateInput` keys `node` per
 * implementing type (`{ node: { ItPChart: { … } } }`), but the runtime threw
 * `Unknown field "ItPChart"` and only accepted the flat interface fields.
 *
 * Opt-in on NEO4J_URI; property-suite schema and seed (`ItP*` labels, one
 * runId, removed in afterAll); every case runs in a rolled-back transaction.
 */
import { OGM } from '../../src/ogm';
import { describeLive, inRollback } from './properties/harness';
import { useItpFixture, type Rec } from './properties/fixture';
import { policies, typeDefs } from './properties/schema';

jest.setTimeout(120_000);

describeLive('interface nested update keyed per member (live Neo4j)', () => {
  const f = useItpFixture();

  it('applies each member body to that member’s targets only', async () => {
    await inRollback(f.driver, async (tx) => {
      await f.model('ItPTag').update({
        where: { id: f.id('t1') },
        update: {
          resources: [
            {
              update: {
                node: {
                  ItPChart: {
                    name: 'chart',
                    categories: [
                      {
                        disconnect: [{ where: { node: { id: f.id('k2') } } }],
                      },
                    ],
                  },
                },
              },
            },
            {
              where: { node: { name: 'a' } },
              update: { node: { ItPDrug: { rank: 9 } } },
            },
          ],
        },
        context: { transaction: tx },
      });
      const res = await tx.run(
        `MATCH (x {runId: $runId})
         WHERE x.id IN [$runId + '-c1', $runId + '-d1', $runId + '-v1']
         RETURN x.id AS id, x.name AS name, x.rank AS rank,
                [(x)-[:ITP_IN_CAT]->(k) | k.id] AS cats ORDER BY id`,
        { runId: f.runId },
      );
      expect(
        res.records.map((r) => ({
          id: f.short(r.get('id')),
          name: r.get('name'),
          rank: r.get('rank')?.toNumber(),
          cats: (r.get('cats') as string[]).map(f.short),
        })),
      ).toEqual([
        { id: 'c1', name: 'chart', rank: 1, cats: ['k1'] },
        { id: 'd1', name: 'a', rank: 9, cats: [] },
        { id: 'v1', name: 'a', rank: 1, cats: [] },
      ]);
    });
  });

  it('enforces the member’s update policies on its body', async () => {
    const guarded = new OGM({
      typeDefs,
      driver: f.driver,
      policies,
      policyDefaults: { auditMetadata: false },
    });
    const as = (uid: string) =>
      f.model('ItPTag', guarded.withContext({ uid, tid: 't1' }));
    const chartUpdate = (body: Rec) => ({
      where: { id: f.id('t1') },
      update: { resources: [{ update: { node: { ItPChart: body } } }] },
    });
    // WITH CHECK: the tenant restrictive runs on the member body.
    await expect(
      as('u1').update(chartUpdate({ tenantId: 't2' })),
    ).rejects.toThrow(/Policy denied update on ItPChart/);
    // Row filter: c1 is u1's, so u2's update writes nothing.
    await inRollback(f.driver, async (tx) => {
      await as('u2').update({
        ...chartUpdate({ name: 'mine' }),
        context: { transaction: tx },
      });
      expect(
        await f.ids(
          tx,
          "MATCH (c:ItPChart {runId: $runId}) WHERE c.name = 'mine' RETURN c.id",
        ),
      ).toEqual([]);
    });
  });

  it('rejects member keys mixed with interface fields', async () => {
    await expect(
      f.model('ItPTag').update({
        where: { id: f.id('t1') },
        update: {
          resources: [{ update: { node: { ItPChart: {}, name: 'x' } } }],
        },
      }),
    ).rejects.toThrow(/member keys/);
  });
});
