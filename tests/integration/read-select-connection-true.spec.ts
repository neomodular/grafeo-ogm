/**
 * Live typed-`select` connection `true` forms (v2.5.3).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * The generated `SelectFields` type offers `xConnection: true`,
 * `edges: true`, `node: true` and `properties: true`, but the normalizer
 * only read the `{ select: … }` object forms: every `true` form came back
 * as `edges: [{}]`. `true` now selects all scalars, as it does for a plain
 * relationship field.
 */
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

describeLive('Typed select connection `true` forms — live Neo4j', () => {
  const h = liveHarness();

  beforeAll(async () => {
    await h.setup();
    await h.run(
      `CREATE (u:LbUser {id: $u, runId: $runId})
       CREATE (p:LbPost {id: $p, runId: $runId, title: 'T', rank: 1, secret: false})
       CREATE (u)-[:LB_WROTE {note: 'n', stars: 4}]->(p)`,
      { u: h.id('u'), p: h.id('p') },
    );
  });

  afterAll(() => h.teardown());

  const conn = async (postsConnection: unknown) => {
    const rows = (await h.ogm.model('LbUser').find({
      where: { id: h.id('u') },
      select: { postsConnection } as never,
    })) as Array<{ postsConnection: { edges: Array<Record<string, any>> } }>;
    return rows[0].postsConnection.edges;
  };

  it('node: true and properties: true select all scalars', async () => {
    const edges = await conn({
      select: { edges: { node: true, properties: true } },
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].node).toMatchObject({ id: h.id('p'), title: 'T' });
    expect(edges[0].properties).toEqual({ note: 'n', stars: 4 });
  });

  it('edges: true selects node and edge scalars', async () => {
    const edges = await conn({ select: { edges: true } });
    expect(edges[0].node).toMatchObject({ id: h.id('p'), title: 'T' });
    expect(edges[0].properties).toEqual({ note: 'n', stars: 4 });
  });

  it('xConnection: true selects node and edge scalars', async () => {
    const edges = await conn(true);
    expect(edges[0].node).toMatchObject({ id: h.id('p'), title: 'T' });
    expect(edges[0].properties).toEqual({ note: 'n', stars: 4 });
  });

  it('the object forms are unchanged', async () => {
    const edges = await conn({
      select: {
        edges: {
          node: { select: { title: true } },
          properties: { select: { stars: true } },
        },
      },
    });
    expect(edges).toEqual([{ node: { title: 'T' }, properties: { stars: 4 } }]);
  });
});
