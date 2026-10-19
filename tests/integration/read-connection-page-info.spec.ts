/**
 * Live connection `pageInfo` / `cursor` suite (v2.7.1).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * The generated connection types declare `pageInfo` and the edge
 * `cursor`, but the runtime dropped both, in the selectionSet and in the
 * typed select. They now follow upstream `@neo4j/graphql` 5.x for a
 * connection read without `first` / `after`: `cursor` is
 * `offsetToCursor(<offset in the filtered, sorted edges>)` — base64 of
 * `arrayconnection:<offset>` — `hasNextPage` / `hasPreviousPage` are
 * false and `startCursor` / `endCursor` are the first / last edge's
 * cursors (null with no edge). Everything counts the same filtered list
 * as `edges` and `totalCount`, so the target read policy applies.
 */
import { Model } from '../../src/model';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';
import {
  describeLive,
  liveHarness,
  policies,
  typeDefs,
  type Row,
} from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

/** Upstream `offsetToCursor` (graphql-relay). */
const cursor = (offset: number) =>
  Buffer.from(`arrayconnection:${offset}`).toString('base64');

/**
 * Each edge's cursor is its offset in the list. (No APOC on the default
 * live container, so these cases don't sort: the list order is the
 * server's, the offsets must follow it.)
 */
function expectOffsets(edges: Row[], key = 'cursor'): void {
  expect(edges.map((e) => e[key])).toEqual(edges.map((_, i) => cursor(i)));
}

const titles = (edges: Row[]) =>
  edges.map((e) => (e.node as Row).title as string).sort();

describeLive('Connection pageInfo / cursor — live Neo4j', () => {
  const h = liveHarness();

  beforeAll(async () => {
    await h.setup();
    await h.run(
      `CREATE (u:LbUser {id: $u, runId: $runId, name: 'u'})
       CREATE (v:LbUser {id: $v, runId: $runId, name: 'v'})
       CREATE (u)-[:LB_WROTE {stars: 5}]->(p1:LbPost {id: $p1, runId: $runId, title: 'a', secret: false})
       CREATE (u)-[:LB_WROTE {stars: 4}]->(:LbPost {id: $p2, runId: $runId, title: 'b', secret: true})
       CREATE (u)-[:LB_WROTE {stars: 3}]->(p3:LbPost {id: $p3, runId: $runId, title: 'c', secret: false})
       CREATE (v)-[:LB_WROTE {stars: 1}]->(p1)
       CREATE (u)-[:LB_HAS_ITEM]->(p3)`,
      {
        u: h.id('u'),
        v: h.id('v'),
        p1: h.id('p1'),
        p2: h.id('p2'),
        p3: h.id('p3'),
      },
    );
  });

  afterAll(() => h.teardown());
  beforeEach(() => Model.clearSelectionCache());

  const whereU = () => ({ id: h.id('u') }) as never;
  const one = async (
    ogm: Pick<OGM, 'model'>,
    args: Record<string, unknown>,
  ): Promise<Row> => {
    const rows = (await ogm
      .model('LbUser')
      .find({ where: whereU(), ...args } as never)) as Row[];
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  it('selectionSet: a cursor per edge (its offset) and pageInfo', async () => {
    const u = await one(h.ogm, {
      selectionSet: `{ id postsConnection {
        totalCount
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        edges { cursor node { title } }
      } }`,
    });
    const conn = u.postsConnection as { edges: Row[] } & Row;
    expect(conn.totalCount).toBe(3);
    expect(conn.pageInfo).toEqual({
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: cursor(0),
      endCursor: cursor(2),
    });
    expectOffsets(conn.edges);
    expect(titles(conn.edges)).toEqual(['a', 'b', 'c']);
  });

  it('selectionSet: aliases, __typename, edge properties, where', async () => {
    const u = await one(h.ogm, {
      selectionSet: `{ c: postsConnection(where: { node: { title_IN: ["a", "b"] } }) {
        page: pageInfo { t: __typename more: hasNextPage last: endCursor }
        e: edges { at: cursor properties { stars } }
      } }`,
    });
    const conn = u.c as { e: Row[] } & Row;
    expect(conn.page).toEqual({ t: 'PageInfo', more: false, last: cursor(1) });
    expectOffsets(conn.e, 'at');
    expect(conn.e.map((e) => (e.properties as Row).stars).sort()).toEqual([
      4, 5,
    ]);
  });

  it('an empty connection: no cursors, null start / end', async () => {
    const u = await one(h.ogm, {
      selectionSet: `{ postsConnection(where: { node: { title: "zzz" } }) {
        totalCount pageInfo { hasNextPage startCursor endCursor } edges { cursor }
      } }`,
    });
    expect(u.postsConnection).toEqual({
      totalCount: 0,
      pageInfo: { hasNextPage: false, startCursor: null, endCursor: null },
      edges: [],
    });
  });

  it('pageInfo without edges', async () => {
    const u = await one(h.ogm, {
      selectionSet:
        '{ postsConnection { totalCount pageInfo { startCursor endCursor } } }',
    });
    expect(u.postsConnection).toEqual({
      totalCount: 3,
      pageInfo: { startCursor: cursor(0), endCursor: cursor(2) },
    });
  });

  it('the read policy: totalCount, pageInfo and cursors count readable edges only', async () => {
    const u = await one(h.secured.withContext({}), {
      selectionSet: `{ postsConnection {
        totalCount pageInfo { endCursor } edges { cursor node { title } }
      } }`,
    });
    const conn = u.postsConnection as { edges: Row[] } & Row;
    expect(conn.totalCount).toBe(2);
    expect(conn.pageInfo).toEqual({ endCursor: cursor(1) });
    expectOffsets(conn.edges);
    expect(titles(conn.edges)).toEqual(['a', 'c']);
  });

  it('nested connections keep their own offsets', async () => {
    const u = await one(h.ogm, {
      selectionSet: `{ postsConnection {
        edges { cursor node { title author { authorOf: postsConnection {
          pageInfo { endCursor } edges { cursor node { title } }
        } } } }
      } }`,
    });
    const edges = (u.postsConnection as { edges: Row[] }).edges;
    expectOffsets(edges);
    // Every post's author is u (p1 was also written by v, but `author` is
    // singular: head() of either; check the shape, not who).
    for (const e of edges) {
      const conn = ((e.node as Row).author as Row).authorOf as {
        pageInfo: Row;
        edges: Row[];
      };
      expect(conn.edges.map((x) => x.cursor)).toEqual(
        conn.edges.map((_, i) => cursor(i)),
      );
      expect(conn.pageInfo.endCursor).toBe(cursor(conn.edges.length - 1));
    }
  });

  it('typed select: pageInfo true, edges.cursor and where', async () => {
    const u = await one(h.ogm, {
      select: {
        id: true,
        postsConnection: {
          where: { node: { title_IN: ['a', 'c'] } },
          select: {
            pageInfo: true,
            edges: { cursor: true, node: { select: { title: true } } },
          },
        },
      },
    });
    const conn = u.postsConnection as { edges: Row[] } & Row;
    expect(conn.pageInfo).toEqual({
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: cursor(0),
      endCursor: cursor(1),
    });
    expectOffsets(conn.edges);
    expect(titles(conn.edges)).toEqual(['a', 'c']);
  });

  it('typed select: pageInfo { select } with totalCount, under the read policy', async () => {
    const u = await one(h.secured.withContext({}), {
      select: {
        postsConnection: {
          select: {
            totalCount: true,
            pageInfo: { select: { endCursor: true, hasNextPage: true } },
          },
        },
      },
    });
    expect(u.postsConnection).toEqual({
      totalCount: 2,
      pageInfo: { endCursor: cursor(1), hasNextPage: false },
    });
  });

  it('a connection selected through a union member fragment', async () => {
    const u = await one(h.ogm, {
      selectionSet: `{ items { ... on LbPost { title authorConnection {
        pageInfo { endCursor } edges { cursor node { id } }
      } } } }`,
    });
    expect(u.items).toEqual([
      {
        __typename: 'LbPost',
        title: 'c',
        authorConnection: {
          pageInfo: { endCursor: cursor(0) },
          edges: [{ cursor: cursor(0), node: { id: h.id('u') } }],
        },
      },
    ]);
  });

  it('pageInfo alone keeps the pre-2.7.1 edges key (additive)', async () => {
    // Pre-2.7.1 `{ pageInfo { … } }` compiled to `{ edges: [{}, …] }` (one
    // empty map per edge); the selected `pageInfo` is added next to it.
    const u = await one(h.ogm, {
      selectionSet: '{ friendsConnection { pageInfo { endCursor } } }',
    });
    expect(u.friendsConnection).toEqual({
      edges: [],
      pageInfo: { endCursor: null },
    });
  });

  it('strict: edges under two aliases each carry their own cursors', async () => {
    const strict = new OGM({ typeDefs, driver: h.driver, strict: true });
    const u = await one(strict, {
      selectionSet: `{ postsConnection(where: { node: { title: "a" } }) {
        a: edges { cursor } b: edges { k: cursor node { title } }
      } }`,
    });
    expect(u.postsConnection).toEqual({
      a: [{ cursor: cursor(0) }],
      b: [{ k: cursor(0), node: { title: 'a' } }],
    });
  });

  describe('unprojectable pageInfo / cursor selections', () => {
    const make = (strict?: boolean) => {
      const logger = { debug: jest.fn(), warn: jest.fn() };
      const ogm = new OGM({
        typeDefs,
        driver: h.driver,
        logger,
        policies,
        ...(strict === undefined ? {} : { strict }),
      });
      return { ogm: ogm.withContext({}), logger };
    };

    it('default mode: left out, one warning each', async () => {
      const { ogm, logger } = make();
      const u = await one(ogm, {
        selectionSet: `{ postsConnection {
          pageInfo { endCursor nope }
          edges { cursor { x } node { title } }
        } }`,
      });
      const conn = u.postsConnection as { edges: Row[] } & Row;
      expect(conn.pageInfo).toEqual({ endCursor: cursor(1) });
      expect(conn.edges.map((e) => Object.keys(e))).toEqual([
        ['node'],
        ['node'],
      ]);
      const messages = logger.warn.mock.calls.map((c) => String(c[0]));
      expect(messages).toEqual([
        expect.stringContaining(
          'selects "nope", which is not a field of type "PageInfo"; 2.x leaves it out of the result.',
        ),
        expect.stringContaining(
          'selects "cursor" on type "LbUserPostsRelationship" in the wrong shape: it is a scalar field (String) and takes no sub-selection: select it as "cursor"; 2.x leaves it out of the result.',
        ),
      ]);
    });

    it('strict: throws before running', async () => {
      const { ogm } = make(true);
      await expect(
        one(ogm, { selectionSet: '{ postsConnection { pageInfo } }' }),
      ).rejects.toThrow(
        new OGMError(
          'Field "pageInfo" in selectionSet on type "LbUserPostsConnection" is an object (PageInfo) and needs a sub-selection, e.g. "pageInfo { hasNextPage endCursor }".',
        ),
      );
      await expect(
        one(ogm, {
          select: {
            postsConnection: {
              select: { pageInfo: { select: { nope: true } } },
            },
          },
        }),
      ).rejects.toThrow(
        new OGMError('Unknown field "nope" in select on type "PageInfo".'),
      );
    });
  });
});
