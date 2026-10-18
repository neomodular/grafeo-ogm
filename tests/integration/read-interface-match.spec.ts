/**
 * Live InterfaceModel matching suite (v2.5.0, BREAKING).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * InterfaceModel matched `(n:<Interface>)`, but implementers never carry
 * the interface label — `Model.create` writes only the type's own labels
 * — so find / count / aggregate returned nothing for nodes the OGM itself
 * created. It now matches the implementers' labels, as upstream
 * @neo4j/graphql does.
 */
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

describeLive('InterfaceModel matches implementers — live Neo4j', () => {
  const h = liveHarness();

  beforeAll(async () => {
    await h.setup();
    await h.ogm.model('LbDoc').create({
      input: [{ id: h.id('d'), runId: h.runId, rank: 2 }],
    } as never);
    await h.ogm.model('LbPost').create({
      input: [
        { id: h.id('p'), runId: h.runId, rank: 5, secret: false },
        { id: h.id('s'), runId: h.runId, rank: 7, secret: true },
      ],
    } as never);
    await h.run('MATCH (d:LbDoc {id: $d}) SET d:LbFlagged', { d: h.id('d') });
  });

  afterAll(() => h.teardown());

  const T = (secured = false) =>
    (secured ? h.secured.withContext({}) : h.ogm).interfaceModel('LbThing');
  const mine = () => ({ runId: h.runId }) as never;

  it('find returns nodes created through Model.create, with __typename', async () => {
    const rows = (await T().find({
      where: mine(),
      selectionSet: '{ id rank }',
      options: { sort: [{ rank: 'ASC' }] },
    })) as Record<string, unknown>[];
    expect(rows.map((r) => [r.id, r.__typename])).toEqual([
      [h.id('d'), 'LbDoc'],
      [h.id('p'), 'LbPost'],
      [h.id('s'), 'LbPost'],
    ]);
  });

  it('count and aggregate see them too', async () => {
    expect(await T().count({ where: mine() })).toBe(3);
    const agg = await T().aggregate({
      where: mine(),
      aggregate: { count: true, rank: true },
    });
    expect(agg).toMatchObject({ count: 3, rank: { min: 2, max: 7 } });
  });

  it('the labels filter still narrows the match', async () => {
    const rows = await T().find({ where: mine(), labels: ['LbFlagged'] });
    expect(rows.map((r) => r.id as string)).toEqual([h.id('d')]);
  });

  it('per-member read policies still apply', async () => {
    const rows = await T(true).find({ where: mine() });
    expect(rows.map((r) => r.id as string).sort()).toEqual(
      [h.id('d'), h.id('p')].sort(),
    );
    expect(await T(true).count({ where: mine() })).toBe(2);
  });
});
