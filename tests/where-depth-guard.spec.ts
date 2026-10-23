/**
 * Statement-wide where depth limit (v2.12.2, finding S5p-4).
 *
 * Pre-2.12.2 the where compiler's depth guard counted only `AND` / `OR` /
 * `NOT` nesting, and every relationship / connection / union-member
 * boundary restarted the count at 0. So a 12-deep `AND` threw "exceeds
 * maximum (10)" while a 12-deep relationship filter compiled, a filter
 * ~1000 relationship levels deep overflowed the JS stack (a raw
 * `RangeError` out of the compiler), and anything shallower reached the
 * server, whose cost for nested `EXISTS` is super-linear in the number of
 * HOPS (DoS). The fix counts hops and logical levels toward ONE limit —
 * +1 per AND / OR / NOT level, +1 per relationship or connection hop
 * whatever its wrapper (`node` / `edge` / member keys are the same hop) —
 * checked before each frame recurses, through every path into the compiler.
 *
 * The golden block pins that every filter within the limit still compiles
 * BYTE-IDENTICALLY to v2.12.0 (`tests/fixtures/where-depth.v2_12_0.golden.json`
 * was captured on d165c66 with the same shapes).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { OGMError } from '../src/errors';
import { WhereCompiler } from '../src/compilers/where.compiler';
import { connectionWhereToNodeWhere } from '../src/compilers/mutation.compiler';
import { parseSchema } from '../src/schema/parser';
import { permissive } from '../src/policy/types';
import { CTX, policies, typeDefs } from './fixtures/nls-enforcement.fixture';

/** The limit: unchanged from the logical-nesting limit the compiler always had. */
const LIMIT = 10;
const DEPTH_ERROR = /WHERE clause nesting depth exceeds maximum \(10\)/;

type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Builders — all iterative, so the TEST never recurses.
// ---------------------------------------------------------------------------

/**
 * `levels` relationship hops from `ItTag` (`charts_SOME` → `ItChart`,
 * `tags_SOME` → `ItTag`, …), `leaf` at the innermost target.
 */
function relChainFromTag(levels: number, leaf: Rec): Rec {
  let where = leaf;
  for (let i = levels - 1; i >= 0; i--)
    where = { [i % 2 === 0 ? 'charts_SOME' : 'tags_SOME']: where };
  return where;
}

/** Same, starting from `ItChart` (`tags_SOME` first). */
function relChainFromChart(levels: number, leaf: Rec): Rec {
  let where = leaf;
  for (let i = levels - 1; i >= 0; i--)
    where = { [i % 2 === 0 ? 'tags_SOME' : 'charts_SOME']: where };
  return where;
}

/** `links` connection hops from `ItTag`; each link is ONE hop (`…Connection_SOME` + `node` are the same hop). */
function connChainFromTag(links: number, leaf: Rec): Rec {
  let where = leaf;
  for (let i = links - 1; i >= 0; i--)
    where = {
      [i % 2 === 0 ? 'chartsConnection_SOME' : 'tagsConnection_SOME']: {
        node: where,
      },
    };
  return where;
}

function logical(levels: number, leaf: Rec, op: 'AND' | 'OR' | 'NOT'): Rec {
  let where = leaf;
  for (let i = 0; i < levels; i++)
    where = op === 'NOT' ? { NOT: where } : { [op]: [where] };
  return where;
}

/** Depth of the innermost `leaf` as the compiler counts it, for a sanity check. */
function countExists(cypher: string): number {
  return (cypher.match(/EXISTS \{/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Mock driver — records the Cypher that WOULD run; nothing reaches a server.
// ---------------------------------------------------------------------------

interface Recorded {
  cypher: string;
  params: Rec;
}

function mockDriver(records: Recorded[]): Driver {
  const session = {
    run: (cypher: string, params: Rec) => {
      records.push({ cypher, params });
      return Promise.resolve({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 0,
              nodesDeleted: 0,
              relationshipsCreated: 0,
              relationshipsDeleted: 0,
              propertiesSet: 0,
            }),
          },
        },
      });
    },
    close: () => Promise.resolve(),
  };
  return { session: () => session } as unknown as Driver;
}

function plainOgm(records: Recorded[] = []): OGM {
  return new OGM({ typeDefs, driver: mockDriver(records) });
}

type Policies = NonNullable<ConstructorParameters<typeof OGM>[0]['policies']>;

/** A policy-bound context wrapper, exposed through the `OGM` surface the cases use. */
function boundOgm(records: Recorded[] = [], extra: Policies = policies): OGM {
  const ogm = new OGM({
    typeDefs,
    driver: mockDriver(records),
    policies: extra,
  });
  const bound = ogm.withContext(CTX);
  return {
    model: (n: string) => bound.model(n),
    interfaceModel: (n: string) => bound.interfaceModel(n),
  } as unknown as OGM;
}

const schema = parseSchema(typeDefs);
const tagDef = schema.nodes.get('ItTag')!;

describe('where depth limit — one statement-wide count (v2.12.2)', () => {
  let compiler: WhereCompiler;
  beforeEach(() => {
    compiler = new WhereCompiler(schema);
  });

  describe('relationship filters', () => {
    it(`compiles ${LIMIT} relationship levels`, () => {
      const result = compiler.compile(
        relChainFromTag(LIMIT, { id: 'x' }),
        'n',
        tagDef,
      );
      expect(countExists(result.cypher)).toBe(LIMIT);
    });

    it(`throws OGMError at ${LIMIT + 1} relationship levels`, () => {
      expect(() =>
        compiler.compile(relChainFromTag(LIMIT + 1, { id: 'x' }), 'n', tagDef),
      ).toThrow(OGMError);
      expect(() =>
        compiler.compile(relChainFromTag(LIMIT + 1, { id: 'x' }), 'n', tagDef),
      ).toThrow(DEPTH_ERROR);
    });

    it('a 12-deep relationship filter is rejected like a 12-deep AND (the S5p-4 asymmetry)', () => {
      expect(() =>
        compiler.compile(logical(12, { id: 'x' }, 'AND'), 'n', tagDef),
      ).toThrow(DEPTH_ERROR);
      expect(() =>
        compiler.compile(relChainFromTag(12, { id: 'x' }), 'n', tagDef),
      ).toThrow(DEPTH_ERROR);
    });

    it('3000 relationship levels throw OGMError quickly — the RangeError is unreachable', () => {
      const where = relChainFromTag(3000, { id: 'x' });
      const started = Date.now();
      expect(() => compiler.compile(where, 'n', tagDef)).toThrow(OGMError);
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('a bare relationship key (implicit _SOME) counts a level too', () => {
      let where: Rec = { id: 'x' };
      for (let i = LIMIT; i >= 0; i--)
        where = { [i % 2 === 0 ? 'charts' : 'tags']: where };
      expect(() => compiler.compile(where, 'n', tagDef)).toThrow(DEPTH_ERROR);
    });

    it('_NONE / _ALL / _SINGLE share the count', () => {
      for (const suffix of ['_NONE', '_ALL', '_SINGLE'] as const) {
        let where: Rec = { id: 'x' };
        for (let i = LIMIT; i >= 0; i--)
          where = { [(i % 2 === 0 ? 'charts' : 'tags') + suffix]: where };
        expect(() => compiler.compile(where, 'n', tagDef)).toThrow(DEPTH_ERROR);
      }
    });
  });

  describe('connection filters', () => {
    it(`compiles ${LIMIT} connection hops (a hop costs one, like _SOME)`, () => {
      const result = compiler.compile(
        connChainFromTag(LIMIT, { id: 'x' }),
        'n',
        tagDef,
      );
      expect(countExists(result.cypher)).toBe(LIMIT);
    });

    it(`compiles ${LIMIT - 1} connection hops + 1 AND, throws at ${LIMIT + 1} hops or one more level`, () => {
      expect(() =>
        compiler.compile(
          connChainFromTag(LIMIT - 1, { AND: [{ id: 'x' }] }),
          'n',
          tagDef,
        ),
      ).not.toThrow();
      expect(() =>
        compiler.compile(
          connChainFromTag(LIMIT, { AND: [{ id: 'x' }] }),
          'n',
          tagDef,
        ),
      ).toThrow(DEPTH_ERROR);
      expect(() =>
        compiler.compile(connChainFromTag(LIMIT + 1, { id: 'x' }), 'n', tagDef),
      ).toThrow(DEPTH_ERROR);
    });

    it('`node` / `node_NOT` / `edge` are the same hop as their connection input', () => {
      // root 0 → hop 1 (input, node) → 9 ANDs → leaf at 10: ok.
      expect(() =>
        compiler.compile(
          {
            chartsConnection_SOME: {
              node: logical(9, { id: 'x' }, 'AND'),
              edge: { weight_NOT: null },
            },
          },
          'n',
          tagDef,
        ),
      ).not.toThrow();
      expect(() =>
        compiler.compile(
          {
            chartsConnection_SOME: { node_NOT: logical(9, { id: 'x' }, 'AND') },
          },
          'n',
          tagDef,
        ),
      ).not.toThrow();
      // … 10 ANDs → leaf at 11: rejected.
      expect(() =>
        compiler.compile(
          { chartsConnection_SOME: { node: logical(10, { id: 'x' }, 'AND') } },
          'n',
          tagDef,
        ),
      ).toThrow(DEPTH_ERROR);
      expect(() =>
        compiler.compile(
          {
            chartsConnection_SOME: {
              node_NOT: logical(10, { id: 'x' }, 'AND'),
            },
          },
          'n',
          tagDef,
        ),
      ).toThrow(DEPTH_ERROR);
    });

    it('logical groups INSIDE a connection input count a level each (free wrappers cannot stack)', () => {
      // hop 1 → AND 2 → NOT 3 → node (same hop) → 7 ANDs → 10: ok.
      expect(() =>
        compiler.compile(
          {
            chartsConnection_SOME: {
              AND: [{ NOT: { node: logical(7, { id: 'x' }, 'AND') } }],
            },
          },
          'n',
          tagDef,
        ),
      ).not.toThrow();
      // … 8 ANDs → 11: rejected.
      expect(() =>
        compiler.compile(
          {
            chartsConnection_SOME: {
              AND: [{ NOT: { node: logical(8, { id: 'x' }, 'AND') } }],
            },
          },
          'n',
          tagDef,
        ),
      ).toThrow(DEPTH_ERROR);
    });

    it('logical nesting INSIDE a connection where is bounded (pre-2.12.2 it was not guarded at all)', () => {
      const where = {
        chartsConnection_SOME: logical(3000, { node: { id: 'x' } }, 'AND'),
      };
      const started = Date.now();
      expect(() => compiler.compile(where, 'n', tagDef)).toThrow(OGMError);
      expect(() => compiler.compile(where, 'n', tagDef)).toThrow(DEPTH_ERROR);
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('connection NOT / OR groups count like AND', () => {
      expect(() =>
        compiler.compile(
          { chartsConnection_SOME: logical(10, { node: { id: 'x' } }, 'NOT') },
          'n',
          tagDef,
        ),
      ).toThrow(DEPTH_ERROR);
      expect(() =>
        compiler.compile(
          { chartsConnection_SOME: logical(10, { node: { id: 'x' } }, 'OR') },
          'n',
          tagDef,
        ),
      ).toThrow(DEPTH_ERROR);
    });
  });

  describe('mixed logical + relationship nesting', () => {
    it('counts both toward the same limit', () => {
      // AND(rel(AND(rel(…)))) — 5 relationship hops, each wrapped in AND: leaf at 10.
      let ok: Rec = { id: 'x' };
      for (let i = 4; i >= 0; i--)
        ok = { AND: [{ [i % 2 === 0 ? 'charts_SOME' : 'tags_SOME']: ok }] };
      expect(() => compiler.compile(ok, 'n', tagDef)).not.toThrow();
      // One extra NOT around the leaf: 11.
      let bad: Rec = { NOT: { id: 'x' } };
      for (let i = 4; i >= 0; i--)
        bad = { AND: [{ [i % 2 === 0 ? 'charts_SOME' : 'tags_SOME']: bad }] };
      expect(() => compiler.compile(bad, 'n', tagDef)).toThrow(DEPTH_ERROR);
    });
  });

  describe('union and interface targets', () => {
    it('`{ rel_SOME: { Member: X } }` is one hop — the member key is free', () => {
      // root 0 → hop 1 (member key: same hop) → 9 ANDs → 10: ok.
      expect(() =>
        compiler.compile(
          { items_SOME: { ItChart: logical(9, { id: 'x' }, 'AND') } },
          'n',
          tagDef,
        ),
      ).not.toThrow();
      expect(() =>
        compiler.compile(
          { items_SOME: { ItChart: logical(10, { id: 'x' }, 'AND') } },
          'n',
          tagDef,
        ),
      ).toThrow(DEPTH_ERROR);
    });

    it('a union relationship chain thousands deep throws OGMError, not RangeError', () => {
      // ItTag.items_SOME → { ItChart: { tags_SOME: { items_SOME: { ItChart: … } } } }
      let where: Rec = { id: 'x' };
      for (let i = 0; i < 1500; i++)
        where = { items_SOME: { ItChart: { tags_SOME: where } } };
      expect(() => compiler.compile(where, 'n', tagDef)).toThrow(OGMError);
      expect(() => compiler.compile(where, 'n', tagDef)).toThrow(DEPTH_ERROR);
    });

    it('an interface target counts a level', () => {
      // root 0 → resources_SOME target 1 → 9 ANDs → 10: ok; 10 ANDs → 11.
      expect(() =>
        compiler.compile(
          { resources_SOME: logical(9, { id: 'x' }, 'AND') },
          'n',
          tagDef,
        ),
      ).not.toThrow();
      expect(() =>
        compiler.compile(
          { resources_SOME: logical(10, { id: 'x' }, 'AND') },
          'n',
          tagDef,
        ),
      ).toThrow(DEPTH_ERROR);
    });

    it('a union member key inside a union target where is free (same hop)', async () => {
      // `items.where` compiles per member at depth 0 → a `tags_SOME` chain
      // of 10 is fine, 11 is rejected.
      const select = (hops: number) => ({
        items: {
          where: { ItChart: relChainFromChart(hops, { id: 'x' }) },
          select: { id: true },
        },
      });
      await expect(
        plainOgm()
          .model('ItTag')
          .find({ select: select(LIMIT) }),
      ).resolves.toEqual([]);
      await expect(
        plainOgm()
          .model('ItTag')
          .find({ select: select(LIMIT + 1) }),
      ).rejects.toThrow(DEPTH_ERROR);
    });
  });

  describe('pure chains of every shape (dedicated schema)', () => {
    const chainTypeDefs = /* GraphQL */ `
      type WdEdge @relationshipProperties {
        weight: Int
      }
      union WdItem = WdNode | WdOther
      type WdNode @node {
        id: ID! @unique
        kind: String
        next: [WdNode!]!
          @relationship(type: "WD_NEXT", direction: OUT, properties: "WdEdge")
        items: [WdItem!]! @relationship(type: "WD_ITEM", direction: OUT)
      }
      type WdOther @node {
        id: ID! @unique
      }
    `;
    const chainSchema = parseSchema(chainTypeDefs);
    const wdDef = chainSchema.nodes.get('WdNode')!;
    let wd: WhereCompiler;
    beforeEach(() => {
      wd = new WhereCompiler(chainSchema);
    });

    const rel = (hops: number, leaf: Rec): Rec => {
      let w = leaf;
      for (let i = 0; i < hops; i++) w = { next_SOME: w };
      return w;
    };
    /** Connection hop with `node` AND an `edge` predicate. */
    const conn = (hops: number, leaf: Rec): Rec => {
      let w = leaf;
      for (let i = 0; i < hops; i++)
        w = { nextConnection_SOME: { node: w, edge: { weight_NOT: null } } };
      return w;
    };
    /** Union hop, one member mentioned. */
    const union1 = (hops: number, leaf: Rec): Rec => {
      let w = leaf;
      for (let i = 0; i < hops; i++) w = { items_SOME: { WdNode: w } };
      return w;
    };
    /** Union hop, both members mentioned (two EXISTS per hop). */
    const union2 = (hops: number, leaf: Rec): Rec => {
      let w = leaf;
      for (let i = 0; i < hops; i++)
        w = { items_SOME: { WdNode: w, WdOther: { id: 'none' } } };
      return w;
    };
    /** Member-keyed union CONNECTION hop: `{ Member: { node } }` is one hop. */
    const unionConn = (hops: number, leaf: Rec): Rec => {
      let w = leaf;
      for (let i = 0; i < hops; i++)
        w = { itemsConnection_SOME: { WdNode: { node: w } } };
      return w;
    };
    const shapes = { rel, conn, union1, union2, unionConn };

    for (const [name, build] of Object.entries(shapes)) {
      it(`${name}: ${LIMIT - 1} hops + 1 AND and ${LIMIT} hops compile; ${LIMIT + 1} hops throw`, () => {
        expect(() =>
          wd.compile(build(LIMIT - 1, { AND: [{ id: 'x' }] }), 'n', wdDef),
        ).not.toThrow();
        const atLimit = wd.compile(build(LIMIT, { id: 'x' }), 'n', wdDef);
        expect(countExists(atLimit.cypher)).toBe(
          name === 'union2' ? LIMIT * 2 : LIMIT,
        );
        expect(() =>
          wd.compile(build(LIMIT, { AND: [{ id: 'x' }] }), 'n', wdDef),
        ).toThrow(DEPTH_ERROR);
        expect(() =>
          wd.compile(build(LIMIT + 1, { id: 'x' }), 'n', wdDef),
        ).toThrow(DEPTH_ERROR);
      });

      it(`${name}: 3000 hops throw OGMError in milliseconds`, () => {
        const where = build(3000, { id: 'x' });
        const started = Date.now();
        expect(() => wd.compile(where, 'n', wdDef)).toThrow(OGMError);
        expect(() => wd.compile(where, 'n', wdDef)).toThrow(DEPTH_ERROR);
        expect(Date.now() - started).toBeLessThan(500);
      });
    }

    it('a realistic filter — 3 connection hops + 2 logical groups + a union member — compiles', () => {
      // AND 1 → conn 2 → OR 3 → conn 4 → conn 5 → union hop 6 (member free).
      const where: Rec = {
        AND: [
          {
            nextConnection_SOME: {
              edge: { weight_NOT: null },
              node: {
                OR: [
                  {
                    nextConnection_SOME: {
                      node: {
                        nextConnection_SOME: {
                          node: {
                            items_SOME: {
                              WdNode: { kind: 'leaf' },
                              WdOther: { id: 'o' },
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      };
      const result = wd.compile(where, 'n', wdDef);
      expect(countExists(result.cypher)).toBe(5);
      // The same filter under a connection chain that brings it to the limit still compiles…
      expect(() =>
        wd.compile(conn(LIMIT - 6, where), 'n', wdDef),
      ).not.toThrow();
      // …one more hop does not.
      expect(() => wd.compile(conn(LIMIT - 5, where), 'n', wdDef)).toThrow(
        DEPTH_ERROR,
      );
    });
  });

  describe('policy-injected where', () => {
    it('a policy partial nested beyond the limit is rejected', async () => {
      const ogm = boundOgm([], {
        ItTag: [
          permissive({
            operations: ['read'],
            when: () => relChainFromTag(LIMIT + 1, { id: 'x' }),
          }),
        ],
      });
      await expect(ogm.model('ItTag').find({})).rejects.toThrow(DEPTH_ERROR);
    });

    it('a traversal target policy counts toward the SAME statement-wide depth', async () => {
      // User filter: 9 hops from ItTag ends on an ItChart at depth 9.
      const where = relChainFromTag(9, { id: 'x' });
      // Without policies: fine.
      await expect(plainOgm().model('ItTag').find({ where })).resolves.toEqual(
        [],
      );
      // ItChart's read policy adds one level at every ItChart on the path
      // (depth 9 → 10): still fine.
      await expect(
        boundOgm([], {
          ItChart: [
            permissive({
              operations: ['read'],
              when: () => ({ tags_SOME: { id: 'owner' } }),
            }),
          ],
        })
          .model('ItTag')
          .find({ where }),
      ).resolves.toEqual([]);
      // A two-level partial at depth 9 reaches 11: rejected.
      await expect(
        boundOgm([], {
          ItChart: [
            permissive({
              operations: ['read'],
              when: () => ({ tags_SOME: { charts_SOME: { id: 'owner' } } }),
            }),
          ],
        })
          .model('ItTag')
          .find({ where }),
      ).rejects.toThrow(DEPTH_ERROR);
    });
  });

  describe('every entry path into the compiler', () => {
    const deepFromChart = relChainFromChart(LIMIT + 1, { id: 'x' });
    const deepFromTag = relChainFromTag(LIMIT + 1, { id: 'x' });

    it('root where of find / findFirst / count / aggregate / deleteMany / updateMany', async () => {
      const m = plainOgm().model('ItTag');
      await expect(m.find({ where: deepFromTag })).rejects.toThrow(DEPTH_ERROR);
      await expect(m.findFirst({ where: deepFromTag })).rejects.toThrow(
        DEPTH_ERROR,
      );
      await expect(m.count({ where: deepFromTag })).rejects.toThrow(
        DEPTH_ERROR,
      );
      await expect(
        m.aggregate({ where: deepFromTag, aggregate: { count: true } }),
      ).rejects.toThrow(DEPTH_ERROR);
      await expect(m.deleteMany({ where: deepFromTag })).rejects.toThrow(
        DEPTH_ERROR,
      );
      await expect(
        m.updateMany({ where: deepFromTag, data: { runId: 'r' } }),
      ).rejects.toThrow(DEPTH_ERROR);
    });

    it('nested selection where (relationship projection)', async () => {
      await expect(
        plainOgm()
          .model('ItTag')
          .find({
            select: {
              charts: { where: deepFromChart, select: { id: true } },
            },
          }),
      ).rejects.toThrow(DEPTH_ERROR);
    });

    it('connection where in a selection (`node`, member-keyed, logical)', async () => {
      const ogm = plainOgm();
      await expect(
        ogm.model('ItTag').find({
          select: {
            chartsConnection: {
              where: { node: deepFromChart },
              select: { edges: { node: { select: { id: true } } } },
            },
          },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      await expect(
        ogm.model('ItTag').find({
          select: {
            itemsConnection: {
              where: { ItChart: { node: deepFromChart } },
              select: { edges: { node: { select: { id: true } } } },
            },
          },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      // (Connection-level AND / OR / NOT in a selection where is rejected
      // by the selection compiler itself; deep nesting goes inside `node`.)
      await expect(
        ogm.model('ItTag').find({
          select: {
            chartsConnection: {
              where: { node: logical(3000, { id: 'x' }, 'AND') },
              select: { edges: { node: { select: { id: true } } } },
            },
          },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
    });

    it('<rel>Aggregate(where) in a selection', async () => {
      await expect(
        plainOgm()
          .model('ItTag')
          .find({
            select: {
              chartsAggregate: {
                where: deepFromChart,
                select: { count: true },
              },
            },
          }),
      ).rejects.toThrow(DEPTH_ERROR);
    });

    it('nested mutation where: connect / disconnect / nested delete / nested update', async () => {
      const m = plainOgm().model('ItTag');
      const root = { id: 't' };
      await expect(
        m.update({
          where: root,
          connect: { charts: [{ where: { node: deepFromChart } }] },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      await expect(
        m.update({
          where: root,
          disconnect: { charts: [{ where: { node: deepFromChart } }] },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      await expect(
        m.delete({
          where: root,
          delete: { charts: [{ where: { node: deepFromChart } }] },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      await expect(
        m.update({
          where: root,
          update: {
            charts: [
              {
                where: { node: deepFromChart },
                update: { node: { title: 'x' } },
              },
            ],
          },
        }),
      ).rejects.toThrow(DEPTH_ERROR);
      await expect(
        m.create({
          input: [
            {
              id: 'new',
              charts: { connect: [{ where: { node: deepFromChart } }] },
            },
          ],
        }),
      ).rejects.toThrow(DEPTH_ERROR);
    });

    it('the mutation connection-where pre-walk is bounded too (NOT chain of 3000)', () => {
      const spec = logical(3000, { node: { id: 'x' } }, 'NOT');
      const started = Date.now();
      expect(() => connectionWhereToNodeWhere(spec)).toThrow(OGMError);
      expect(() => connectionWhereToNodeWhere(spec)).toThrow(DEPTH_ERROR);
      expect(Date.now() - started).toBeLessThan(500);
      // Within the limit it still rewrites as before.
      expect(connectionWhereToNodeWhere({ node: { id: 'x' } })).toEqual({
        id: 'x',
      });
      expect(
        connectionWhereToNodeWhere({ NOT: { node: { id: 'x' } } }),
      ).toEqual({ NOT: { id: 'x' } });
    });

    it('InterfaceModel root where', async () => {
      await expect(
        plainOgm()
          .interfaceModel('ItResource')
          .find({ where: logical(LIMIT + 1, { id: 'x' }, 'AND') }),
      ).rejects.toThrow(DEPTH_ERROR);
    });

    it('explainPolicies (compileForExplain)', async () => {
      await expect(
        boundOgm().model('ItTag').explainPolicies({ where: deepFromTag }),
      ).rejects.toThrow(DEPTH_ERROR);
    });

    it('fulltext search where (same root compile)', async () => {
      const ftTypeDefs = `
        type ItFtNode @node @fulltext(indexes: [{ name: "ItFtIdx", fields: ["title"] }]) {
          id: ID! @unique
          title: String
          next: [ItFtNode!]! @relationship(type: "IT_FT_NEXT", direction: OUT)
        }
      `;
      const ogm = new OGM({ typeDefs: ftTypeDefs, driver: mockDriver([]) });
      let where: Rec = { id: 'x' };
      for (let i = 0; i < LIMIT + 1; i++) where = { next_SOME: where };
      await expect(
        ogm.model('ItFtNode').find({
          fulltext: { ItFtIdx: { phrase: 'hello' } },
          where,
        }),
      ).rejects.toThrow(DEPTH_ERROR);
    });
  });

  // -------------------------------------------------------------------------
  // Byte-identical to v2.12.0 for everything within the limit.
  // -------------------------------------------------------------------------
  describe('deep-but-legal filters compile byte-identically to v2.12.0', () => {
    const golden = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, 'fixtures', 'where-depth.v2_12_0.golden.json'),
        'utf-8',
      ),
    ) as Record<string, { plain: Recorded[]; policy: Recorded[] }>;

    /** The same shapes the golden was captured with (d165c66). */
    const cases: Record<string, (ogm: OGM) => Promise<unknown>> = {
      rel5_logical: (ogm) =>
        ogm.model('ItTag').find({
          where: {
            AND: [
              { id_STARTS_WITH: 'x' },
              {
                OR: [
                  {
                    charts_SOME: {
                      tags_SOME: {
                        charts_ALL: {
                          categories_SOME: {
                            charts_NONE: { NOT: { title: 'a' } },
                          },
                        },
                      },
                    },
                  },
                  { charts_NONE: { secret: true } },
                ],
              },
            ],
          },
          select: { id: true },
        }),
      connection_chain: (ogm) =>
        ogm.model('ItTag').find({
          where: {
            chartsConnection_SOME: {
              AND: [
                {
                  node: {
                    tagsConnection_SOME: {
                      node: { charts_SOME: { id: 'c' } },
                      edge: { weight_NOT: null },
                    },
                  },
                },
                { edge: { weight_NOT: null } },
              ],
              NOT: { node: { secret: true } },
            },
          },
          select: { id: true },
        }),
      union_interface: (ogm) =>
        ogm.model('ItTag').find({
          where: {
            items_SOME: {
              ItChart: { tags_SOME: { resources_SOME: { tenantId: 't1' } } },
              ItDoc: { approvedAt_NOT: null },
            },
            resources_NONE: { id: 'r' },
          },
          select: { id: true },
        }),
      selection_paths: (ogm) =>
        ogm.model('ItTag').find({
          where: { id: 't' },
          select: {
            id: true,
            charts: {
              where: { tags_SOME: { charts_SOME: { secret: false } } },
              select: { id: true },
            },
            chartsConnection: {
              where: {
                node: { categories_SOME: { name: 'n' } },
                edge: { weight_NOT: null },
              },
              select: { edges: { node: { select: { id: true } } } },
            },
            chartsAggregate: {
              where: { categories_SOME: { charts_SOME: { title: 'x' } } },
              select: { count: true },
            },
            items: {
              where: { ItChart: { tags_SOME: { id: 'q' } } },
              select: { id: true },
            },
          },
        }),
      mutation_connect: (ogm) =>
        ogm.model('ItTag').update({
          where: { id: 't' },
          connect: {
            charts: [
              {
                where: {
                  node: {
                    AND: [
                      {
                        tags_SOME: {
                          charts_SOME: { categories_SOME: { name: 'n' } },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        }),
      mutation_delete_many: (ogm) =>
        ogm.model('ItChart').deleteMany({
          where: {
            OR: [
              {
                tags_SOME: {
                  charts_SOME: {
                    categories_SOME: { charts_NONE: { title: 'z' } },
                  },
                },
              },
            ],
          },
        }),
      interface_root: (ogm) =>
        ogm.interfaceModel('ItResource').find({
          where: { AND: [{ tenantId: 't1' }, { NOT: { id: 'x' } }] },
        }),
      explain_policies: (ogm) =>
        ogm.model('ItTag').explainPolicies({
          where: {
            charts_SOME: { tags_SOME: { charts_SOME: { secret: false } } },
          },
        }),
    };

    /** Drop driver-specific prototypes (neo4j `Integer`) the way the golden was serialized. */
    const canonical = (rows: Recorded[]): Recorded[] =>
      JSON.parse(JSON.stringify(rows)) as Recorded[];

    it('covers every golden case', () => {
      expect(Object.keys(golden).sort()).toEqual(Object.keys(cases).sort());
    });

    for (const [name, run] of Object.entries(cases)) {
      it(`${name} (no policies)`, async () => {
        if (name === 'explain_policies') {
          // explainPolicies needs a policy-bound model by design.
          await expect(run(plainOgm())).rejects.toThrow(OGMError);
          return;
        }
        const records: Recorded[] = [];
        await run(plainOgm(records));
        expect(canonical(records)).toEqual(golden[name].plain);
      });
      it(`${name} (with policies)`, async () => {
        const records: Recorded[] = [];
        await run(boundOgm(records));
        expect(canonical(records)).toEqual(golden[name].policy);
      });
    }
  });
});
