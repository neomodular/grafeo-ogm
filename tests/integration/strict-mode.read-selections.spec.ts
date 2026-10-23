/**
 * Live suite for selectionSet shapes that 2.x silently drops or
 * truncates (vNEXT, strict items 31–36). Default mode keeps the old result
 * and warns once; `strict: true` does the corrected thing.
 *
 * Opt-in on NEO4J_URI. Labels are `Lr`-prefixed, every node carries this
 * run's `runId` and is removed in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

jest.setTimeout(60_000);

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

const typeDefs = /* GraphQL */ `
  type LrUser @node {
    id: ID! @unique
    runId: String
    name: String
    loc: Point
    cloc: CartesianPoint
    locs: [Point!]
    friends: [LrUser!]! @relationship(type: "LR_FRIEND", direction: OUT)
    items: [LrItem!]! @relationship(type: "LR_HAS_ITEM", direction: OUT)
  }
  union LrItem = LrPost | LrDoc
  type LrPost @node {
    id: ID! @unique
    runId: String
    title: String
    rank: Int
  }
  type LrDoc @node {
    id: ID! @unique
    runId: String
    body: String
    rank: Int
  }
`;

type Row = Record<string, unknown>;

describeLive('selectionSet shapes 2.x drops — live Neo4j', () => {
  const runId = `lr-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;
  let driver: Driver;
  let warns: string[];
  const ogm = (strict?: boolean) =>
    new OGM({
      typeDefs,
      driver,
      strict,
      logger: { warn: (m: string) => warns.push(m), debug: () => undefined },
    });
  const run = async (cypher: string, params: Row = {}) => {
    const s = driver.session();
    try {
      await s.run(cypher, { runId, ...params });
    } finally {
      await s.close();
    }
  };

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    await run(
      `CREATE (a:LrUser {id: $a, runId: $runId, name: 'Alice',
         loc: point({longitude: 1.5, latitude: 2.5}),
         cloc: point({x: 1.0, y: 2.0, z: 3.0}),
         locs: [point({longitude: 1.0, latitude: 2.0, height: 3.0}), point({longitude: 4.0, latitude: 5.0, height: 6.0})]})
       CREATE (b:LrUser {id: $b, runId: $runId, name: 'Bob'})
       CREATE (c:LrUser {id: $c, runId: $runId, name: 'Carol'})
       CREATE (a)-[:LR_FRIEND]->(b) CREATE (b)-[:LR_FRIEND]->(c)
       CREATE (c)-[:LR_FRIEND]->(a)
       CREATE (p1:LrPost {id: $p1, runId: $runId, title: 'hello', rank: 1})
       CREATE (p2:LrPost {id: $p2, runId: $runId, title: 'graph', rank: 5})
       CREATE (d1:LrDoc {id: $d1, runId: $runId, body: 'manual', rank: 3})
       CREATE (a)-[:LR_HAS_ITEM]->(p1) CREATE (a)-[:LR_HAS_ITEM]->(p2)
       CREATE (a)-[:LR_HAS_ITEM]->(d1)`,
      {
        a: id('a'),
        b: id('b'),
        c: id('c'),
        p1: id('p1'),
        p2: id('p2'),
        d1: id('d1'),
      },
    );
  });
  beforeEach(() => {
    warns = [];
  });
  afterAll(async () => {
    if (!driver) return;
    await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
    await driver.close();
  });

  describe('strict item 33 — a selection deeper than maxDepth', () => {
    const nested = (levels: number) => {
      let sel = '{ name }';
      for (let i = 0; i < levels; i++) sel = `{ name friends ${sel} }`;
      return sel;
    };
    const depthOf = (row: Row | undefined): number => {
      let d = 0;
      let cur = row;
      while (cur && Array.isArray(cur.friends) && cur.friends.length > 0) {
        d++;
        cur = cur.friends[0] as Row;
      }
      return d;
    };

    it('default: 6 levels are truncated to 5 and warn once', async () => {
      const m = ogm().model('LrUser');
      const rows = (await m.find({
        where: { id: id('a') },
        selectionSet: nested(6),
      })) as Row[];
      expect(depthOf(rows[0])).toBe(5);
      await m.find({ where: { id: id('a') }, selectionSet: nested(6) });
      const w = warns.filter((x) => x.includes('maximum selection depth'));
      expect(w).toHaveLength(1);
      expect(w[0]).toContain('strict: true');
    });

    it('strict: 6 levels throw; 5 levels run unchanged', async () => {
      const m = ogm(true).model('LrUser');
      await expect(
        m.find({ where: { id: id('a') }, selectionSet: nested(6) }),
      ).rejects.toThrow(/nested deeper than the maximum selection depth \(5\)/);
      const rows = (await m.find({
        where: { id: id('a') },
        selectionSet: nested(5),
      })) as Row[];
      expect(depthOf(rows[0])).toBe(5);
      expect(warns).toEqual([]);
    });

    it('strict: a raised maxDepth accepts the deeper selection', async () => {
      const m = ogm(true).model('LrUser');
      m.maxDepth = 6;
      const rows = (await m.find({
        where: { id: id('a') },
        selectionSet: nested(6),
      })) as Row[];
      expect(depthOf(rows[0])).toBe(6);
    });
  });

  describe('Point / CartesianPoint sub-selection (both modes)', () => {
    for (const strict of [undefined, true]) {
      it(`strict: ${strict} — projects the upstream point fields`, async () => {
        const m = ogm(strict).model('LrUser');
        const rows = (await m.find({
          where: { id_IN: [id('a'), id('b')] },
          selectionSet: `{ name
            loc { longitude latitude height srid crs __typename }
            cloc { x y z crs }
            locs { lng: longitude height }
          }`,
          options: { sort: [{ name: 'ASC' }] },
        })) as Row[];
        expect(rows).toEqual([
          {
            name: 'Alice',
            loc: {
              longitude: 1.5,
              latitude: 2.5,
              height: null,
              srid: 4326,
              crs: 'wgs-84',
              __typename: 'Point',
            },
            cloc: { x: 1, y: 2, z: 3, crs: 'cartesian-3d' },
            locs: [
              { lng: 1, height: 3 },
              { lng: 4, height: 6 },
            ],
          },
          { name: 'Bob', loc: null, cloc: null, locs: null },
        ]);
        expect(warns).toEqual([]);
      });
    }

    it('an unknown point sub-field keeps the old behaviour', async () => {
      const rows = (await ogm()
        .model('LrUser')
        .find({
          where: { id: id('a') },
          selectionSet: '{ name loc { longitude x } }',
        })) as Row[];
      expect(rows).toEqual([{ name: 'Alice' }]);
      expect(warns.join('\n')).toContain('"loc"');
      await expect(
        ogm(true)
          .model('LrUser')
          .find({
            where: { id: id('a') },
            selectionSet: '{ name loc { longitude x } }',
          }),
      ).rejects.toThrow(/is a Point field, whose sub-selection takes only/);
    });
  });

  describe('strict item 32 — named fragment spreads', () => {
    const sel = `{ name ...U items { ...P ... on LrDoc { body } } }
      fragment U on LrUser { friends { name } }
      fragment P on LrPost { title }`;
    const sortItems = (rows: Row[]) =>
      rows.map((r) => ({
        ...r,
        items: [...(r.items as Row[])].sort((x, y) =>
          String(x.title ?? x.body).localeCompare(String(y.title ?? y.body)),
        ),
      }));

    it('default: the spreads are left out and warn once', async () => {
      const m = ogm().model('LrUser');
      const rows = (await m.find({
        where: { id: id('a') },
        selectionSet: sel,
      })) as Row[];
      expect(rows).toEqual([{ name: 'Alice', items: expect.any(Array) }]);
      expect(
        sortItems(rows)[0].items.map((i: Row) => Object.keys(i).sort()),
      ).toEqual([
        ['__typename', 'body'],
        ['__typename', 'body'],
        ['__typename', 'body'],
      ]);
      await m.find({ where: { id: id('a') }, selectionSet: sel });
      expect(warns.filter((w) => w.includes('...U'))).toHaveLength(1);
      expect(warns.filter((w) => w.includes('...P'))).toHaveLength(1);
    });

    it('strict: the spreads are expanded, on the root and on a union member', async () => {
      const rows = (await ogm(true)
        .model('LrUser')
        .find({ where: { id: id('a') }, selectionSet: sel })) as Row[];
      expect(sortItems(rows)).toEqual([
        {
          name: 'Alice',
          friends: [{ name: 'Bob' }],
          items: [
            { __typename: 'LrPost', title: 'graph', body: null },
            { __typename: 'LrPost', title: 'hello', body: null },
            { __typename: 'LrDoc', body: 'manual', title: null },
          ],
        },
      ]);
      expect(warns).toEqual([]);
    });

    it('strict: a spread without its definition throws', async () => {
      await expect(
        ogm(true)
          .model('LrUser')
          .find({ where: { id: id('a') }, selectionSet: '{ name ...U }' }),
      ).rejects.toThrow(/Unknown fragment "U" in selectionSet/);
    });
  });
});
