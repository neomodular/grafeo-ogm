/**
 * Live suite (v2.18.0): `@id` on a `@relationshipProperties` field.
 *
 * Pre-v2.18.0 the id was never generated — every relationship stored it as
 * null, though the generated output type declares it non-null. It is now a
 * `randomUUID()` set when the relationship is created (nested create, nested
 * create in an update, connect, array connect), in every mode; a connect
 * that finds the relationship already in place keeps its id.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItEiM @node {
    id: ID! @id
    runId: String
    name: String
    ks: [ItEiK!]!
      @relationship(type: "IT_EI_MK", direction: OUT, properties: "ItEiMK")
  }
  type ItEiK @node {
    id: ID! @id
    runId: String
    name: String
  }
  type ItEiMK @relationshipProperties {
    eid: ID! @id
    note: String
  }
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Row = Record<string, unknown>;

describe.each([false, true])('edge @id generation (strict=%s)', (strict) => {
  describeLive('live Neo4j', () => {
    const runId = `it-${randomUUID()}`;
    let driver: Driver;
    let ogm: OGM;

    async function run(
      cypher: string,
      params: Record<string, unknown> = {},
    ): Promise<Row[]> {
      const session = driver.session();
      try {
        const res = await session.run(cypher, { runId, ...params });
        return res.records.map((r) => r.toObject());
      } finally {
        await session.close();
      }
    }

    const edges = async (id: string) =>
      (
        await run(
          'MATCH (:ItEiM {id: $id})-[r:IT_EI_MK]->(k) RETURN k.name AS k, r.eid AS eid ORDER BY k',
          { id },
        )
      ).map((r) => ({ k: r.k as string, eid: r.eid as string | null }));

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
      ogm = new OGM({ typeDefs, driver, strict });
    });

    afterAll(async () => {
      if (driver) {
        await run(
          'MATCH (n) WHERE (n:ItEiM OR n:ItEiK) AND n.runId = $runId DETACH DELETE n',
        );
        await driver.close();
      }
    });

    it('generates a UUID on every relationship-creating path and reads it back', async () => {
      const K = ogm.model('ItEiK');
      const M = ogm.model('ItEiM');
      await K.create({
        input: [
          { runId, name: 'c1' },
          { runId, name: 'a1' },
          { runId, name: 'a2' },
        ],
      });
      const r = await M.create({
        input: [
          {
            runId,
            name: 'm',
            ks: {
              create: [{ node: { runId, name: 'n1' }, edge: { note: 'a' } }],
              connect: [{ where: { node: { runId, name: 'c1' } } }],
            },
          },
        ],
      });
      const id = (Object.values(r).find(Array.isArray) as { id: string }[])[0]
        .id;
      await M.update({
        where: { id },
        update: { ks: [{ create: [{ node: { runId, name: 'n2' } }] }] },
      });
      await M.update({
        where: { id },
        connect: {
          ks: [
            { where: { node: { runId, name: 'a1' } }, edge: { note: 'x' } },
            { where: { node: { runId, name: 'a2' } }, edge: { note: 'y' } },
          ],
        },
      });
      const before = await edges(id);
      expect(before.map((e) => e.k)).toEqual(['a1', 'a2', 'c1', 'n1', 'n2']);
      for (const e of before) expect(e.eid).toMatch(UUID);
      expect(new Set(before.map((e) => e.eid)).size).toBe(5);

      // A connect that finds the relationship in place keeps its id.
      await M.update({
        where: { id },
        connect: {
          ks: { where: { node: { runId, name: 'c1' } }, edge: { note: 'z' } },
        },
      });
      expect(await edges(id)).toEqual(before);

      const read = await M.find({
        where: { id },
        selectionSet:
          '{ ksConnection { edges { properties { eid } node { name } } } }',
      });
      const readIds = (
        read[0].ksConnection as { edges: { properties: { eid: string } }[] }
      ).edges.map((e) => e.properties.eid);
      expect(readIds.sort()).toEqual(before.map((e) => e.eid).sort());
    });

    it('an explicitly supplied edge id wins', async () => {
      const M = ogm.model('ItEiM');
      const r = await M.create({
        input: [
          {
            runId,
            name: 'g',
            ks: {
              create: [
                {
                  node: { runId, name: 'g1' },
                  edge: { eid: 'given-id' } as never,
                },
              ],
            },
          },
        ],
      });
      const id = (Object.values(r).find(Array.isArray) as { id: string }[])[0]
        .id;
      expect(await edges(id)).toEqual([{ k: 'g1', eid: 'given-id' }]);
    });
  });
});
