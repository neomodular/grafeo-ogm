/**
 * Live `_SINGLE` / `Connection_SINGLE` suite (v2.5.0).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * Every `_SINGLE` shape compiled to `size([r0 IN [((n)-[...]->(r0) ...)]])`
 * — an extra `(` in front of a pattern that already starts with `(` — so
 * Neo4j rejected the query with "Invalid input 'WHERE'". These tests run
 * each shape (relationship, interface target, single- and multi-member
 * union, connection) and check `_SINGLE` still counts only the related
 * nodes the target's `read` policy lets the caller see.
 */
import {
  describeLive,
  liveHarness,
  type Row,
} from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

describeLive('_SINGLE quantifiers — live Neo4j', () => {
  const h = liveHarness();
  const ids = (rows: unknown) =>
    (rows as Row[]).map((r) => r.id as string).sort();

  beforeAll(async () => {
    await h.setup();
    // u1: two posts titled 'a' (one secret), one 'b'; things/items hold
    //     one rank-1 and one rank-2 doc, plus a rank-1 post in items.
    // u2: exactly one 'a' post; one rank-1 doc in things and items.
    await h.run(
      `CREATE (u1:LbUser {id: $u1, runId: $runId})
       CREATE (u2:LbUser {id: $u2, runId: $runId})
       CREATE (u1)-[:LB_WROTE {stars: 5}]->(:LbPost {id: $p1, runId: $runId, title: 'a', secret: false, rank: 1})
       CREATE (u1)-[:LB_WROTE {stars: 5}]->(:LbPost {id: $p2, runId: $runId, title: 'a', secret: true, rank: 2})
       CREATE (u1)-[:LB_WROTE {stars: 1}]->(:LbPost {id: $p3, runId: $runId, title: 'b', secret: false, rank: 3})
       CREATE (u2)-[:LB_WROTE {stars: 5}]->(:LbPost {id: $p4, runId: $runId, title: 'a', secret: false, rank: 1})
       CREATE (d1:LbDoc {id: $d1, runId: $runId, rank: 1})
       CREATE (d2:LbDoc {id: $d2, runId: $runId, rank: 2})
       CREATE (d3:LbDoc {id: $d3, runId: $runId, rank: 1})
       CREATE (u1)-[:LB_HAS_THING]->(d1), (u1)-[:LB_HAS_THING]->(d2)
       CREATE (u1)-[:LB_HAS_ITEM]->(d1), (u1)-[:LB_HAS_ITEM]->(d2)
       WITH u1, u2, d3
       MATCH (p1:LbPost {id: $p1})
       CREATE (u1)-[:LB_HAS_ITEM]->(p1)
       CREATE (u2)-[:LB_HAS_THING]->(d3), (u2)-[:LB_HAS_ITEM]->(d3)`,
      {
        u1: h.id('u1'),
        u2: h.id('u2'),
        p1: h.id('p1'),
        p2: h.id('p2'),
        p3: h.id('p3'),
        p4: h.id('p4'),
        d1: h.id('d1'),
        d2: h.id('d2'),
        d3: h.id('d3'),
      },
    );
  });

  afterAll(() => h.teardown());

  const mine = (where: Row) => ({ runId: h.runId, ...where }) as never;
  const find = (where: Row, secured = false) =>
    (secured ? h.secured.withContext({}) : h.ogm)
      .model('LbUser')
      .find({ where: mine(where), selectionSet: '{ id }' });

  it('relationship _SINGLE matches exactly one related node', async () => {
    expect(ids(await find({ posts_SINGLE: { title: 'a' } }))).toEqual([
      h.id('u2'),
    ]);
  });

  it('relationship _SINGLE counts only nodes the read policy shows', async () => {
    // u1's second 'a' post is secret, so u1 now has exactly one.
    expect(ids(await find({ posts_SINGLE: { title: 'a' } }, true))).toEqual([
      h.id('u1'),
      h.id('u2'),
    ]);
  });

  it('Connection_SINGLE matches exactly one edge', async () => {
    expect(
      ids(await find({ postsConnection_SINGLE: { edge: { stars: 5 } } })),
    ).toEqual([h.id('u2')]);
  });

  it('Connection_SINGLE counts only nodes the read policy shows', async () => {
    expect(
      ids(await find({ postsConnection_SINGLE: { edge: { stars: 5 } } }, true)),
    ).toEqual([h.id('u1'), h.id('u2')]);
  });

  it('interface-target _SINGLE', async () => {
    expect(ids(await find({ things_SINGLE: { rank: 1 } }))).toEqual([
      h.id('u1'),
      h.id('u2'),
    ]);
    expect(ids(await find({ things_SINGLE: { rank_GTE: 1 } }))).toEqual([
      h.id('u2'),
    ]);
  });

  it('single-member union _SINGLE', async () => {
    expect(ids(await find({ items_SINGLE: { LbDoc: { rank: 1 } } }))).toEqual([
      h.id('u1'),
      h.id('u2'),
    ]);
  });

  it('multi-member union _SINGLE counts across members', async () => {
    // u1 has a rank-1 doc AND a rank-1 post → two matches, not one.
    expect(
      ids(
        await find({
          items_SINGLE: { LbDoc: { rank: 1 }, LbPost: { rank: 1 } },
        }),
      ),
    ).toEqual([h.id('u2')]);
  });
});
