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
       CREATE (c)-[:LR_FRIEND]->(a)`,
      { a: id('a'), b: id('b'), c: id('c') },
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
});
