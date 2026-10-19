/**
 * v2.6.2 — property-suite finding F8 (strict mode): `ItPTag.resources`
 * (interface `ItPResource`: `ItPChart`, `ItPDrug`) shares its relationship
 * type `ITP_RES` with `ItPTag.vaults` (`ItPVault`, not an implementor).
 * Without policies, every read through `resources` binds no target label,
 * so it also returned, counted and matched the vaults (`__typename: null`).
 *
 * Default mode keeps that result (and its Cypher, see
 * `tests/strict-mode.abstract-reads.byte-identical.spec.ts`) and warns once
 * at construction; `strict: true` restricts every read path to the members.
 *
 * Opt-in on NEO4J_URI; property-suite schema and seed (`ItP*` labels, one
 * runId, removed in afterAll); every case runs in a rolled-back transaction.
 */
import type { Transaction } from 'neo4j-driver';
import type { OGM } from '../../src/ogm';
import { describeLive, inRollback } from './properties/harness';
import { useItpFixture, type Rec } from './properties/fixture';

jest.setTimeout(120_000);

describeLive(
  'strict mode: reads of an interface field sharing its relationship type (live Neo4j)',
  () => {
    const f = useItpFixture();

    type Read = (o: OGM, tx: Transaction) => Promise<unknown>;
    const ctx = (tx: Transaction) => ({ context: { transaction: tx } });
    const tagIds = (rows: unknown) =>
      (rows as Rec[]).map((r) => f.short(r.id)).sort();
    const where =
      (w: Rec): Read =>
      async (o, tx) =>
        tagIds(
          await f.model('ItPTag', o).find({
            where: { runId: f.runId, ...w },
            selectionSet: '{ id }',
            ...ctx(tx),
          }),
        );

    /**
     * [name, read, default (v2.6.0) result, strict result]. Seed: t1 ->
     * c1, d1, v1; t2 -> c3, d2, v2; t3 -> c2, v3; t4 -> none. Names: c1, c3,
     * d1, v1, v3 'a'; c2, v2 'b'; d2 'c'.
     */
    const cases: Array<[string, Read, unknown, unknown]> = [
      [
        'typed select: nested list, connection edges and totalCount',
        async (o, tx) => {
          const [t] = await f.model('ItPTag', o).find({
            where: { id: f.id('t1') },
            select: {
              resources: { select: { id: true } },
              resourcesConnection: {
                select: {
                  totalCount: true,
                  edges: { node: { select: { id: true } } },
                },
              },
            },
            ...ctx(tx),
          });
          const conn = t.resourcesConnection as Rec;
          return {
            list: (t.resources as Rec[]).map((r) => f.short(r.id)).sort(),
            edges: (conn.edges as Rec[])
              .map((e) => f.short((e.node as Rec).id))
              .sort(),
            total: conn.totalCount,
          };
        },
        { list: ['c1', 'd1', 'v1'], edges: ['c1', 'd1', 'v1'], total: 3 },
        { list: ['c1', 'd1'], edges: ['c1', 'd1'], total: 2 },
      ],
      [
        'selectionSet: nested list with a where, connection totalCount',
        async (o, tx) => {
          const [t] = await f.model('ItPTag', o).find({
            where: { id: f.id('t1') },
            selectionSet: `{ resources(where: { name: "a" }) { id __typename }
            resourcesConnection(where: { node: { name: "a" } }) { totalCount } }`,
            ...ctx(tx),
          });
          return {
            list: (t.resources as Rec[])
              .map((r) => `${f.short(r.id)}:${String(r.__typename)}`)
              .sort(),
            total: (t.resourcesConnection as Rec).totalCount,
          };
        },
        { list: ['c1:ItPChart', 'd1:ItPDrug', 'v1:null'], total: 3 },
        { list: ['c1:ItPChart', 'd1:ItPDrug'], total: 2 },
      ],
      [
        'resources_SOME',
        where({ resources_SOME: { id: f.id('v1') } }),
        ['t1'],
        [],
      ],
      [
        'resources (bare)',
        where({ resources: { id: f.id('v1') } }),
        ['t1'],
        [],
      ],
      [
        'resources_NONE',
        where({ resources_NONE: { id: f.id('v1') } }),
        ['t2', 't3', 't4'],
        ['t1', 't2', 't3', 't4'],
      ],
      [
        'resources_ALL',
        where({ resources_ALL: { name: 'b' } }),
        ['t4'],
        ['t3', 't4'],
      ],
      [
        'resources_SINGLE',
        where({ resources_SINGLE: { name: 'a' } }),
        ['t2', 't3'],
        ['t2'],
      ],
      [
        'resourcesConnection_SOME',
        where({ resourcesConnection_SOME: { node: { id: f.id('v1') } } }),
        ['t1'],
        [],
      ],
      [
        'resourcesConnection_NONE',
        where({ resourcesConnection_NONE: { node: { name: 'a' } } }),
        ['t4'],
        ['t3', 't4'],
      ],
      [
        'resourcesConnection_ALL',
        where({ resourcesConnection_ALL: { node: { name: 'b' } } }),
        ['t4'],
        ['t3', 't4'],
      ],
      [
        'resources: null (a tag whose only ITP_RES target is a vault)',
        async (o, tx) => {
          await tx.run(
            `MATCH (v:ItPVault {id: $runId + '-v1'})
           CREATE (:ItPTag {id: $runId + '-t9', runId: $runId})-[:ITP_RES]->(v)`,
            { runId: f.runId },
          );
          return where({ resources: null })(o, tx);
        },
        ['t4'],
        ['t4', 't9'],
      ],
      [
        'union field: a non-member node on its relationship type',
        async (o, tx) => {
          await tx.run(
            `MATCH (t:ItPTag {id: $runId + '-t3'}), (v:ItPVault {id: $runId + '-v3'})
             CREATE (t)-[:ITP_ITEM]->(v)`,
            { runId: f.runId },
          );
          const [t] = await f.model('ItPTag', o).find({
            where: { id: f.id('t3') },
            selectionSet: '{ items { __typename ... on ItPDoc { id } } }',
            ...ctx(tx),
          });
          return (t.items as Rec[]).map((i) => String(i.__typename)).sort();
        },
        ['ItPDoc', 'null'],
        ['ItPDoc'],
      ],
      [
        'count',
        async (o, tx) =>
          f.model('ItPTag', o).count({
            where: { runId: f.runId, resources_SOME: { id: f.id('v1') } },
            ...ctx(tx),
          }),
        1,
        0,
      ],
      [
        'aggregate',
        async (o, tx) =>
          f.model('ItPTag', o).aggregate({
            where: {
              runId: f.runId,
              resourcesConnection: { node: { id: f.id('v2') } },
            },
            aggregate: { count: true },
            ...ctx(tx),
          }),
        { count: 1 },
        { count: 0 },
      ],
    ];

    it('default: warns once, at construction', () => {
      expect(f.warnings.filter((w) => w.includes('non-member'))).toEqual([
        '[OGM] ItPTag.resources (interface ItPResource) shares relationship type "ITP_RES" (OUT) with ' +
          'ItPTag.vaults (ItPVault): reads through it also return, count and match the non-member nodes ' +
          'linked that way. Enable `strict: true` (default in 3.0) to restrict every read of an interface / ' +
          'union field to its member types.',
      ]);
    });

    it.each(cases)('%s', async (_name, read, before, after) => {
      await inRollback(f.driver, async (tx) => {
        expect(await read(f.ogm, tx)).toEqual(before);
      });
      await inRollback(f.driver, async (tx) => {
        expect(await read(f.strictOgm, tx)).toEqual(after);
      });
    });
  },
);
