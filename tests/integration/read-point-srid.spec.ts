/**
 * Live Point `srid` suite (v2.4.8).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * On the driver's DEFAULT (lossless-integer) configuration a Point's
 * `srid` is a Neo4j Integer, and the result mapper copied it as-is, so
 * callers got `{ low, high }` instead of a number.
 */
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

describeLive('Point srid — live Neo4j, lossless driver', () => {
  const h = liveHarness({ lossless: true });

  beforeAll(async () => {
    await h.setup();
    await h.run(
      `CREATE (:LbUser {id: $u, runId: $runId, loc: point({x: 1.5, y: 2.5})})
       CREATE (:LbUser {id: $g, runId: $runId, loc: point({longitude: 10.0, latitude: 20.0})})`,
      { u: h.id('u'), g: h.id('g') },
    );
  });

  afterAll(() => h.teardown());

  it('maps srid to a plain number', async () => {
    const rows = (await h.ogm.model('LbUser').find({
      where: { runId: h.runId } as never,
      selectionSet: '{ id loc }',
    })) as { id: string; loc: unknown }[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.loc]));
    expect(byId[h.id('u')]).toEqual({ x: 1.5, y: 2.5, srid: 7203 });
    expect(byId[h.id('g')]).toEqual({ x: 10, y: 20, srid: 4326 });
  });
});
