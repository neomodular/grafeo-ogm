/**
 * Live suite — raw-fragment policy params collide across types (v2.12.1).
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId`, all labels start with `ItRp`, and `afterAll` deletes by runId.
 *
 * Pre-2.12.1 a policy's `cypher.params` were namespaced `policy_p<N>_<key>`
 * with `N` restarting at 0 in every compile frame, so two types whose
 * policies used the same raw key both bound `$policy_p0_<key>` and the
 * frame compiled LAST overwrote the value in the shared params. Here
 * `ItRpTop` is readable only when `tier = 'gold'` and `ItRpKid` only when
 * `tier = 'silver'`, both through `$v`. Each scenario asserts a DATABASE
 * outcome; they fail on v2.12.0 and pass with the fix.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive, restrictive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = `
type ItRpTop @node {
  id: ID! @unique
  runId: String!
  tier: String
  kids: [ItRpKid!]! @relationship(type: "IT_RP_HAS", direction: OUT)
}
type ItRpKid @node {
  id: ID! @unique
  runId: String!
  tier: String
}
`;

const tierIs = (v: string) => ({
  fragment: (_c: unknown, a: { node: string }) => `${a.node}.tier = $v`,
  params: () => ({ v }),
});

const policies = {
  ItRpTop: [
    permissive({ operations: ['read'], when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'top.gold',
      cypher: tierIs('gold'),
    }),
    permissive({
      operations: ['update'],
      name: 'top.update-gold',
      cypher: tierIs('gold'),
    }),
  ],
  ItRpKid: [
    permissive({ operations: ['read'], when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'kid.silver',
      cypher: tierIs('silver'),
    }),
  ],
};

describeLive(
  'NLS — raw policy params collide across types (v2.12.1) — live Neo4j',
  () => {
    const runId = `it-${randomUUID()}`;
    const id = (suffix: string) => `${runId}-${suffix}`;
    let driver: Driver;
    let ogm: OGM;

    async function run(
      cypher: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>[]> {
      const session = driver.session();
      try {
        const res = await session.run(cypher, { runId, ...params });
        return res.records.map((r) => r.toObject());
      } finally {
        await session.close();
      }
    }

    async function linked(fromId: string, toId: string): Promise<boolean> {
      const rows = await run(
        'MATCH ({id: $fromId})-[r:IT_RP_HAS]->({id: $toId}) RETURN count(r) AS c',
        { fromId, toId },
      );
      return Number(rows[0].c) > 0;
    }

    const bound = () => ogm.withContext({ uid: 'u1' });
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

    beforeAll(async () => {
      driver = neo4j.driver(
        URI!,
        neo4j.auth.basic(
          process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
          process.env.NEO4J_PASSWORD ?? 'password',
        ),
        { disableLosslessIntegers: true },
      );
      await driver.verifyConnectivity();
      ogm = new OGM({ typeDefs, driver, policies });

      // A (gold)   → K1 (silver), K2 (gold)      visible; K1 visible, K2 hidden
      // B (silver) → K3 (silver)                 HIDDEN by the root policy
      // C (gold)   → K4 (gold)                   visible; its only kid hidden
      await run(
        `CREATE (a:ItRpTop {id: $a, runId: $runId, tier: 'gold'})
       CREATE (b:ItRpTop {id: $b, runId: $runId, tier: 'silver'})
       CREATE (c:ItRpTop {id: $c, runId: $runId, tier: 'gold'})
       CREATE (k1:ItRpKid {id: $k1, runId: $runId, tier: 'silver'})
       CREATE (k2:ItRpKid {id: $k2, runId: $runId, tier: 'gold'})
       CREATE (k3:ItRpKid {id: $k3, runId: $runId, tier: 'silver'})
       CREATE (k4:ItRpKid {id: $k4, runId: $runId, tier: 'gold'})
       CREATE (a)-[:IT_RP_HAS]->(k1), (a)-[:IT_RP_HAS]->(k2)
       CREATE (b)-[:IT_RP_HAS]->(k3)
       CREATE (c)-[:IT_RP_HAS]->(k4)`,
        {
          a: id('A'),
          b: id('B'),
          c: id('C'),
          k1: id('K1'),
          k2: id('K2'),
          k3: id('K3'),
          k4: id('K4'),
        },
      );
    });

    afterAll(async () => {
      if (driver) {
        await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
        await driver.close();
      }
    });

    it('a nested selection over the other type does not replace the root restrictive value', async () => {
      // Pre-fix: the nested `ItRpKid` frame rebound `$policy_p0_v` to
      // 'silver', so the ROOT filter became `tier = 'silver'` — B (hidden)
      // was returned and A / C (allowed) disappeared.
      const tops = (await bound()
        .model('ItRpTop')
        .find({
          where: { runId },
          select: { id: true, kids: { select: { id: true } } },
        })) as { id: string; kids: { id: string }[] }[];
      expect(ids(tops)).toEqual([id('A'), id('C')]);
      const byId = new Map(tops.map((t) => [t.id, ids(t.kids)]));
      expect(byId.get(id('A'))).toEqual([id('K1')]);
      expect(byId.get(id('C'))).toEqual([]);
    });

    it('a traversal filter over the other type does not replace the root restrictive value', async () => {
      // Pre-fix the ROOT frame compiled last and rebound `$policy_p0_v` to
      // 'gold', so the `kids_SOME` filter admitted GOLD kids: C (whose only
      // kid is hidden) matched through a node the context cannot see.
      const tops = (await bound()
        .model('ItRpTop')
        .find({
          where: { runId, kids_SOME: { runId } },
          select: { id: true },
        })) as { id: string }[];
      expect(ids(tops)).toEqual([id('A')]);
    });

    it('a connect target read filter keeps its own value next to the root update filter', async () => {
      // Three frames bind `$v` in one update statement: the root `update`
      // permissive (gold), the connect target's `read` filter (silver) and
      // the response projection's root `read` filter (gold). Pre-fix the
      // LAST one won for all three, so the connect target filter admitted
      // GOLD kids: K4, hidden from this context, was linked to A.
      await bound()
        .model('ItRpTop')
        .update({
          where: { id: id('A') },
          connect: { kids: [{ where: { node: { id: id('K4') } } }] },
        });
      expect(await linked(id('A'), id('K4'))).toBe(false);

      // Control: the same write to a VISIBLE kid succeeds (pre-fix it was
      // silently refused, since 'silver' no longer passed the rebound filter).
      await bound()
        .model('ItRpTop')
        .update({
          where: { id: id('A') },
          connect: { kids: [{ where: { node: { id: id('K3') } } }] },
        });
      expect(await linked(id('A'), id('K3'))).toBe(true);
    });
  },
);
