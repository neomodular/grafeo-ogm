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
      `CREATE (a:LrUser {id: $a, runId: $runId, name: 'Alice'})
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
});
