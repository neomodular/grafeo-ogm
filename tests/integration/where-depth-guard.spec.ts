/**
 * Live where-depth-limit suite (v2.12.2, finding S5p-4).
 *
 * Opt-in on NEO4J_URI. Labels are `ItWd`-prefixed, every node carries this
 * run's `runId`, and `afterAll` deletes them.
 *
 * Pre-2.12.2 only AND / OR / NOT nesting counted toward the where depth
 * limit; relationship, connection and union-member boundaries restarted
 * it, so a filter ~1000 relationship levels deep crashed the compiler with
 * a raw `RangeError` and anything shallower ran on the server, where
 * nested `EXISTS` is super-linear (measured on 5.26: planning a 20-deep
 * filter ~9 s even on a two-node graph; see `MAX_WHERE_DEPTH`). This suite
 * proves, against a real server, that
 *
 *   - a filter AT the limit (10 hops / logical levels, every shape — a
 *     connection hop's `node` / `edge` are the same hop) is valid Neo4j
 *     5.x Cypher and returns the right rows, with and without Node-Level
 *     Security;
 *   - one level past the limit, and 3000 levels, are rejected with an
 *     `OGMError` before any Cypher is sent — on every path: reads,
 *     nested selections, connection filters, aggregates, nested writes.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';
import { permissive, restrictive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;
jest.setTimeout(60_000);

const LIMIT = 10;
const DEPTH_ERROR = /WHERE clause nesting depth exceeds maximum \(10\)/;

const typeDefs = /* GraphQL */ `
  type ItWdEdge @relationshipProperties {
    weight: Int
  }
  type ItWdNode @node {
    id: ID! @unique
    runId: String
    kind: String
    secret: Boolean
    next: [ItWdNode!]!
      @relationship(type: "IT_WD_NEXT", direction: OUT, properties: "ItWdEdge")
  }
`;

type Rec = Record<string, unknown>;

function relChain(levels: number, leaf: Rec): Rec {
  let where = leaf;
  for (let i = 0; i < levels; i++) where = { next_SOME: where };
  return where;
}

/** `links` connection hops, one level each (`nextConnection_SOME` + `node` are the same hop). */
function connChain(links: number, leaf: Rec): Rec {
  let where = leaf;
  for (let i = 0; i < links; i++)
    where = { nextConnection_SOME: { node: where } };
  return where;
}

describeLive('where depth limit — live Neo4j (v2.12.2)', () => {
  const runId = `it-${randomUUID()}`;
  const id = (suffix: string) => `${runId}-${suffix}`;
  let driver: Driver;
  let ogm: OGM;
  let queries: string[] = [];

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

  /** Every statement the OGM sends, so a rejection can be shown to send none. */
  function recordingDriver(inner: Driver): Driver {
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop !== 'session') return Reflect.get(target, prop, receiver);
        return (...args: unknown[]) => {
          const session = (
            target.session as (...a: unknown[]) => ReturnType<Driver['session']>
          )(...args);
          return new Proxy(session, {
            get(s, p, r) {
              if (p !== 'run') return Reflect.get(s, p, r);
              return (cypher: string, ...rest: unknown[]) => {
                queries.push(cypher);
                return (s.run as (...a: unknown[]) => unknown)(cypher, ...rest);
              };
            },
          });
        };
      },
    });
  }

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
    ogm = new OGM({
      typeDefs,
      driver: recordingDriver(driver),
      policies: {
        ItWdNode: [
          permissive({
            operations: ['read', 'update', 'delete', 'create'],
            name: 'wd.read-all',
            when: () => ({}),
          }),
          restrictive({
            operations: ['read'],
            name: 'wd.no-secret',
            when: () => ({ secret: false }),
          }),
        ],
      },
    });
    // a → b → a (visible cycle), a → s → a (s is hidden by the read policy).
    await run(
      `CREATE (a:ItWdNode {id: $a, runId: $runId, kind: 'a', secret: false}),
              (b:ItWdNode {id: $b, runId: $runId, kind: 'b', secret: false}),
              (s:ItWdNode {id: $s, runId: $runId, kind: 's', secret: true}),
              (a)-[:IT_WD_NEXT {weight: 1}]->(b), (b)-[:IT_WD_NEXT {weight: 1}]->(a),
              (a)-[:IT_WD_NEXT {weight: 9}]->(s), (s)-[:IT_WD_NEXT {weight: 9}]->(a)`,
      { a: id('a'), b: id('b'), s: id('s') },
    );
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n:ItWdNode) WHERE n.runId = $runId DETACH DELETE n');
      await driver.close();
    }
  });

  beforeEach(() => {
    queries = [];
  });

  const plain = () => ogm.model('ItWdNode');
  const bound = () => ogm.withContext({}).model('ItWdNode');
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  describe('at the limit: valid 5.x Cypher, correct rows', () => {
    it(`${LIMIT} relationship levels run and match`, async () => {
      // Every hop alternates `a` with `b` or `s`, so an even number of hops
      // from `a` lands on `a` and from `b` / `s` lands on `b` or `s`.
      const rows = await plain().find({
        where: { runId, ...relChain(LIMIT, { id: id('a') }) },
        select: { id: true },
      });
      expect(ids(rows as { id: string }[])).toEqual([id('a')]);
    });

    it(`${LIMIT} levels through the hidden node are refused by the policy at every level`, async () => {
      // Without NLS, 10 hops from `b` or `s` can end on the secret `s`.
      const open = await plain().find({
        where: { runId, ...relChain(LIMIT, { secret: true }) },
        select: { id: true },
      });
      expect(ids(open as { id: string }[])).toEqual([id('b'), id('s')]);
      // With NLS the hidden node is invisible at each of the 10 levels.
      const guarded = await bound().find({
        where: { runId, ...relChain(LIMIT, { secret: true }) },
        select: { id: true },
      });
      expect(guarded).toEqual([]);
      // …and the visible cycle still matches at depth 10 under NLS.
      const visible = await bound().find({
        where: { runId, ...relChain(LIMIT, { id: id('b') }) },
        select: { id: true },
      });
      expect(ids(visible as { id: string }[])).toEqual([id('b')]);
    });

    it(`${LIMIT} connection hops with an edge filter run and match`, async () => {
      const rows = await bound().find({
        where: {
          runId,
          nextConnection_SOME: {
            edge: { weight: 1 },
            node: connChain(LIMIT - 1, { id: id('a') }),
          },
        },
        select: { id: true },
      });
      // From `a`: a→b on the weight-1 edge, then 9 more hops land on `a`.
      // From `b`: b→a, then 9 hops land on `b` / `s`. `s` only reaches `a`
      // over its weight-9 edge (and is hidden by the read policy anyway).
      expect(ids(rows as { id: string }[])).toEqual([id('a')]);
    });

    it('mixed logical + relationship nesting at the limit runs', async () => {
      // AND(next_SOME(OR(next_SOME(NOT(next_SOME(AND(next_SOME(…))))))) — 10 levels.
      const where: Rec = {
        AND: [
          {
            next_SOME: {
              OR: [
                {
                  next_SOME: {
                    NOT: {
                      next_SOME: {
                        AND: [{ next_SOME: { next_SOME: { kind: 'zzz' } } }],
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      };
      const rows = await bound().find({
        where: { runId, ...where },
        select: { id: true },
      });
      expect(ids(rows as { id: string }[])).toEqual([id('a'), id('b')]);
    });

    it('nested selection, connection and aggregate filters at the limit run', async () => {
      const [a] = (await bound().find({
        where: { id: id('a') },
        select: {
          id: true,
          next: {
            where: relChain(LIMIT, { id: id('a') }),
            select: { id: true },
          },
          nextConnection: {
            where: { node: relChain(LIMIT, { id: id('b') }) },
            select: { edges: { node: { select: { id: true } } } },
          },
          nextAggregate: {
            where: relChain(LIMIT, { id: id('a') }),
            select: { count: true },
          },
        },
      })) as unknown as [
        {
          next: { id: string }[];
          nextConnection: { edges: { node: { id: string } }[] };
          nextAggregate: { count: number };
        },
      ];
      // a's visible neighbour is b; 10 hops from b land on b, not a.
      expect(a.next).toEqual([]);
      expect(a.nextConnection.edges.map((e) => e.node.id)).toEqual([id('b')]);
      expect(Number(a.nextAggregate.count)).toBe(0);
    });

    it('a nested write filter at the limit runs', async () => {
      await bound().update({
        where: { id: id('b') },
        connect: {
          next: [
            {
              where: { node: relChain(LIMIT, { id: id('b') }) },
              edge: { weight: 5 },
            },
          ],
        },
      });
      // 10 hops from a visible node reaching `b`: `b` itself (via the cycle).
      const rows = await run(
        `MATCH (:ItWdNode {id: $b})-[r:IT_WD_NEXT {weight: 5}]->(t) RETURN t.id AS id`,
        { b: id('b') },
      );
      expect(rows.map((r) => r.id)).toEqual([id('b')]);
      await run(
        `MATCH (:ItWdNode {id: $b})-[r:IT_WD_NEXT {weight: 5}]->() DELETE r`,
        { b: id('b') },
      );
    });
  });

  describe('past the limit: rejected before any Cypher is sent', () => {
    const past = relChain(LIMIT + 1, { id: 'x' });

    it('root where', async () => {
      await expect(plain().find({ where: past })).rejects.toThrow(DEPTH_ERROR);
      await expect(bound().count({ where: past })).rejects.toThrow(DEPTH_ERROR);
      await expect(plain().deleteMany({ where: past })).rejects.toThrow(
        DEPTH_ERROR,
      );
      expect(queries).toEqual([]);
    });

    it('connection chain', async () => {
      await expect(
        plain().find({ where: connChain(LIMIT + 1, { id: 'x' }) }),
      ).rejects.toThrow(DEPTH_ERROR);
      await expect(
        plain().find({ where: connChain(LIMIT, { AND: [{ id: 'x' }] }) }),
      ).rejects.toThrow(DEPTH_ERROR);
      expect(queries).toEqual([]);
    });

    it('nested selection / connection / aggregate where', async () => {
      await expect(
        plain().find({
          select: { next: { where: past, select: { id: true } } },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      await expect(
        plain().find({
          select: {
            nextConnection: {
              where: { node: past },
              select: { edges: { node: { select: { id: true } } } },
            },
          },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      await expect(
        plain().find({
          select: { nextAggregate: { where: past, select: { count: true } } },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      expect(queries).toEqual([]);
    });

    it('nested write where (connect / disconnect / nested update / cascade delete)', async () => {
      await expect(
        bound().update({
          where: { id: id('a') },
          connect: { next: [{ where: { node: past } }] },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      await expect(
        bound().update({
          where: { id: id('a') },
          disconnect: { next: [{ where: { node: past } }] },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      await expect(
        bound().update({
          where: { id: id('a') },
          update: {
            next: [{ where: { node: past }, update: { node: { kind: 'x' } } }],
          },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      // A root that does not exist, so a missed guard could not delete data.
      await expect(
        bound().delete({
          where: { id: id('nope') },
          delete: { next: [{ where: { node: past } }] },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      expect(queries).toEqual([]);
    });

    it('3000 levels is an OGMError in milliseconds, not a stack overflow', async () => {
      const started = Date.now();
      await expect(
        plain().find({ where: relChain(3000, { id: 'x' }) }),
      ).rejects.toThrow(OGMError);
      await expect(
        plain().find({
          where: {
            nextConnection_SOME: { node: connChain(1500, { id: 'x' }) },
          },
        }),
      ).rejects.toThrow(OGMError);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(queries).toEqual([]);
    });
  });
});
