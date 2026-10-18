/**
 * Live connection `totalCount` suite (v2.4.8).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * The generated connection type declares `totalCount: Int`, but the
 * selection compiler only ever emitted `edges`, so a selected `totalCount`
 * was silently dropped (undefined). It must count exactly the edges the
 * `edges` list would return: same `where`, same target `read` policy.
 */
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

describeLive('Connection totalCount — live Neo4j', () => {
  const h = liveHarness();

  beforeAll(async () => {
    await h.setup();
    await h.run(
      `CREATE (u:LbUser {id: $u, runId: $runId})
       CREATE (u)-[:LB_WROTE {stars: 5}]->(:LbPost {id: $p1, runId: $runId, title: 'a', secret: false})
       CREATE (u)-[:LB_WROTE {stars: 4}]->(:LbPost {id: $p2, runId: $runId, title: 'a', secret: true})
       CREATE (u)-[:LB_WROTE {stars: 3}]->(:LbPost {id: $p3, runId: $runId, title: 'b', secret: false})`,
      { u: h.id('u'), p1: h.id('p1'), p2: h.id('p2'), p3: h.id('p3') },
    );
  });

  afterAll(() => h.teardown());

  const where = () => ({ id: h.id('u') }) as never;
  type Conn = { totalCount?: number; edges?: unknown[] };
  const conn = (row: Record<string, unknown>) => row.postsConnection as Conn;

  it('selectionSet totalCount counts every edge', async () => {
    const [u] = await h.ogm.model('LbUser').find({
      where: where(),
      selectionSet:
        '{ id postsConnection { totalCount edges { node { id } } } }',
    });
    expect(conn(u).totalCount).toBe(3);
    expect(conn(u).edges).toHaveLength(3);
  });

  it('totalCount alone', async () => {
    const [u] = await h.ogm.model('LbUser').find({
      where: where(),
      selectionSet: '{ id postsConnection { totalCount } }',
    });
    expect(conn(u)).toEqual({ totalCount: 3 });
  });

  it('totalCount does not count nodes the read policy hides', async () => {
    const [u] = await h.secured.withContext({}).model('LbUser').find({
      where: where(),
      selectionSet:
        '{ id postsConnection { totalCount edges { node { id } } } }',
    });
    expect(conn(u).totalCount).toBe(2);
    expect(conn(u).edges).toHaveLength(2);
  });

  it('typed select totalCount respects the connection where and policy', async () => {
    const [u] = await h.secured
      .withContext({})
      .model('LbUser')
      .find({
        where: where(),
        select: {
          id: true,
          postsConnection: {
            where: { node: { title: 'a' } },
            select: {
              totalCount: true,
              edges: { node: { select: { id: true } } },
            },
          },
        },
      } as never);
    expect(conn(u).totalCount).toBe(1);
    expect(conn(u).edges).toEqual([{ node: { id: h.id('p1') } }]);
  });

  it('typed select totalCount with an edge filter', async () => {
    const [u] = await h.ogm.model('LbUser').find({
      where: where(),
      select: {
        id: true,
        postsConnection: {
          where: { edge: { stars_GTE: 4 } },
          select: { totalCount: true },
        },
      },
    } as never);
    expect(conn(u)).toEqual({ totalCount: 2 });
  });
});
