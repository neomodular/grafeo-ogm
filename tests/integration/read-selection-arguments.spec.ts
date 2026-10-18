/**
 * Live selectionSet arguments + aliases suite (v2.5.0, BREAKING).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * The selectionSet parser never read `field.arguments` and never used
 * `alias`: `posts(where: ...)` and `posts(options: { limit })` returned
 * every post, `r: rank` came back as `rank`, and `a: posts {..} b: posts
 * {..}` collapsed into one `posts` key. Arguments are now honoured on
 * relationship fields (with the target `read` policy applied exactly as
 * for a nested `select.where`), aliases name the output keys, and any
 * argument the OGM can't honour throws instead of being ignored.
 *
 * `options.sort` needs APOC (absent from the test database); its shape is
 * pinned in `tests/read-paths.spec.ts`.
 */
import { OGMError } from '../../src/errors';
import {
  describeLive,
  liveHarness,
  type Row,
} from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

describeLive('selectionSet arguments and aliases — live Neo4j', () => {
  const h = liveHarness();

  beforeAll(async () => {
    await h.setup();
    await h.run(
      `CREATE (u:LbUser {id: $u, runId: $runId, name: 'U'})
       CREATE (u)-[:LB_WROTE {stars: 5}]->(:LbPost {id: $p1, runId: $runId, title: 'a', rank: 1, secret: false})
       CREATE (u)-[:LB_WROTE {stars: 4}]->(:LbPost {id: $p2, runId: $runId, title: 'a', rank: 2, secret: true})
       CREATE (u)-[:LB_WROTE {stars: 3}]->(:LbPost {id: $p3, runId: $runId, title: 'b', rank: 3, secret: false})
       CREATE (u)-[:LB_WROTE {stars: 2}]->(:LbPost {id: $p4, runId: $runId, title: 'b', rank: 4, secret: false})`,
      {
        u: h.id('u'),
        p1: h.id('p1'),
        p2: h.id('p2'),
        p3: h.id('p3'),
        p4: h.id('p4'),
      },
    );
  });

  afterAll(() => h.teardown());

  const findU = async (selectionSet: string, secured = false) => {
    const [u] = await (secured ? h.secured.withContext({}) : h.ogm)
      .model('LbUser')
      .find({ where: { id: h.id('u') } as never, selectionSet });
    return u as Row;
  };
  const ids = (v: unknown) => (v as Row[]).map((r) => r.id as string).sort();

  it('where on a relationship field filters it', async () => {
    const u = await findU('{ posts(where: { title: "a" }) { id } }');
    expect(ids(u.posts)).toEqual([h.id('p1'), h.id('p2')]);
  });

  it('where on a relationship field keeps the target read policy', async () => {
    const u = await findU('{ posts(where: { title: "a" }) { id } }', true);
    expect(ids(u.posts)).toEqual([h.id('p1')]);
  });

  it('where on a connection field filters it', async () => {
    const u = await findU(
      '{ postsConnection(where: { edge: { stars_GTE: 4 } }) { totalCount edges { node { id } } } }',
    );
    expect((u.postsConnection as Row).totalCount).toBe(2);
  });

  it('options.limit / offset page the relationship list', async () => {
    const all = await findU('{ posts { id } }');
    const page = await findU(
      '{ posts(options: { offset: 1, limit: 2 }) { id } }',
    );
    expect(page.posts).toHaveLength(2);
    expect(page.posts).toEqual((all.posts as Row[]).slice(1, 3));
    const head = await findU('{ posts(options: { limit: 1 }) { id } }');
    expect(head.posts).toHaveLength(1);
  });

  it('aliases name the output keys', async () => {
    const u = await findU(
      '{ ident: id label: name a: posts(where: { title: "a" }) { pid: id } b: posts(where: { title: "b" }) { id r: rank } }',
    );
    expect(u.ident).toBe(h.id('u'));
    expect(u.label).toBe('U');
    expect(u.id).toBeUndefined();
    expect((u.a as Row[]).map((p) => p.pid).sort()).toEqual([
      h.id('p1'),
      h.id('p2'),
    ]);
    expect((u.b as Row[]).map((p) => [p.id, p.r]).sort()).toEqual([
      [h.id('p3'), 3],
      [h.id('p4'), 4],
    ]);
  });

  it('an aliased @cypher field', async () => {
    const u = await findU('{ n: postCount postCount }');
    expect(u).toMatchObject({ n: 4, postCount: 4 });
  });

  it('unsupported arguments throw instead of being ignored', async () => {
    await expect(findU('{ name(format: "x") }')).rejects.toThrow(OGMError);
    await expect(findU('{ posts(first: 1) { id } }')).rejects.toThrow(
      /Unsupported argument "first"/,
    );
    await expect(
      findU('{ posts(options: { limit: 1, cursor: "x" }) { id } }'),
    ).rejects.toThrow(/Unsupported option "cursor"/);
    await expect(findU('{ posts(where: $w) { id } }')).rejects.toThrow(
      /variables are not supported/,
    );
  });
});
