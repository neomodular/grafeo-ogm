/**
 * Live interface inline-fragment `@cypher` suite (v2.4.8).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * `LbThing.find({ selectionSet: '{ id ... on LbDoc { dcount } }' })`
 * compiled the fragment against the INTERFACE's properties, where
 * `dcount` doesn't exist, so it was projected as a stored property and
 * always came back null. Fragment fields now resolve against the concrete
 * type: an implementer's `@cypher` field projects only for that type.
 *
 * Nodes are created with the interface label too, so these tests don't
 * depend on how InterfaceModel matches implementers.
 */
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

describeLive('Interface fragment @cypher fields — live Neo4j', () => {
  const h = liveHarness();

  beforeAll(async () => {
    await h.setup();
    await h.run(
      `CREATE (u1:LbUser {id: $u1, runId: $runId})
       CREATE (u2:LbUser {id: $u2, runId: $runId})
       CREATE (d:LbThing:LbDoc {id: $d, runId: $runId, rank: 4})
       CREATE (p:LbThing:LbPost {id: $p, runId: $runId, rank: 9})
       CREATE (u1)-[:LB_HAS_THING]->(d), (u2)-[:LB_HAS_THING]->(d)
       CREATE (u1)-[:LB_HAS_THING]->(p)`,
      { u1: h.id('u1'), u2: h.id('u2'), d: h.id('d'), p: h.id('p') },
    );
  });

  afterAll(() => h.teardown());

  const byId = (rows: Record<string, unknown>[]) =>
    Object.fromEntries(rows.map((r) => [r.id as string, r]));

  it("projects an implementer's @cypher field through an inline fragment", async () => {
    const rows = await h.ogm.interfaceModel('LbThing').find({
      where: { runId: h.runId } as never,
      selectionSet: '{ id ... on LbDoc { dcount } }',
    });
    const got = byId(rows as Record<string, unknown>[]);
    expect(got[h.id('d')].dcount).toBe(40);
    expect(got[h.id('d')].__typename).toBe('LbDoc');
    // Not an LbDoc → the fragment doesn't apply.
    expect(got[h.id('p')].dcount ?? null).toBeNull();
  });

  it('aggregating implementer @cypher fields work at the top level', async () => {
    const rows = await h.ogm.interfaceModel('LbThing').find({
      where: { runId: h.runId } as never,
      selectionSet:
        '{ id ... on LbDoc { owners dcount } ... on LbPost { rank } }',
    });
    const got = byId(rows as Record<string, unknown>[]);
    expect(got[h.id('d')]).toMatchObject({ owners: 2, dcount: 40 });
    expect(got[h.id('p')]).toMatchObject({ rank: 9 });
    expect(got[h.id('p')].owners ?? null).toBeNull();
  });

  it('works on a nested interface relationship target', async () => {
    const [u] = await h.ogm.model('LbUser').find({
      where: { id: h.id('u1') } as never,
      selectionSet: '{ id things { id ... on LbDoc { dcount } } }',
    });
    const things = byId(u.things as Record<string, unknown>[]);
    expect(things[h.id('d')].dcount).toBe(40);
    expect(things[h.id('p')].dcount ?? null).toBeNull();
  });
});
