/**
 * Live suite for write-path regressions introduced in 2.4.8 (fixed in 2.5.1).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Every node it
 * creates carries this run's `runId` and is removed in `afterEach`.
 *
 * - `connect: { rel: null }` linked EVERY target node.
 * - Sibling nested connects (connect-in-connect) shared param names, so
 *   links went to the wrong node and edge values were overwritten.
 * - Nested update / nested and cascade delete through an INTERFACE
 *   relationship also touched non-member nodes on the same relationship
 *   type — renaming or deleting them.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  interface ItWrPet {
    id: ID!
    name: String
  }
  type ItWrDog implements ItWrPet @node {
    id: ID! @unique
    runId: String
    name: String
  }
  type ItWrToy @node {
    id: ID! @unique
    runId: String
    name: String
  }
  type ItWrOwner @node {
    id: ID! @unique
    runId: String
    pets: [ItWrPet!]! @relationship(type: "IT_WR_HAS", direction: OUT)
    toys: [ItWrToy!]! @relationship(type: "IT_WR_HAS", direction: OUT)
  }
  type ItWrTagged @relationshipProperties {
    weight: Int
  }
  type ItWrTag @node {
    id: ID! @unique
    runId: String
    name: String
  }
  type ItWrPost @node {
    id: ID! @unique
    runId: String
    tags: [ItWrTag!]!
      @relationship(
        type: "IT_WR_TAGGED"
        direction: OUT
        properties: "ItWrTagged"
      )
  }
  type ItWrUser @node {
    id: ID! @unique
    runId: String
    pinned: ItWrPost @relationship(type: "IT_WR_PIN", direction: OUT)
    featured: ItWrPost @relationship(type: "IT_WR_FEAT", direction: OUT)
  }
`;

type Row = Record<string, unknown>;

describeLive('Write-path regressions (2.4.8) — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;
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

  const tagsOf = async (postId: string) =>
    (
      await run(
        'MATCH (:ItWrPost {id: $postId})-[r:IT_WR_TAGGED]->(t) RETURN t.id AS t, r.weight AS w ORDER BY t',
        { postId },
      )
    ).map((r) => ({ t: r.t, w: r.w }));

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
    ogm = new OGM({ typeDefs, driver });
  });

  afterEach(() => run('MATCH (n {runId: $runId}) DETACH DELETE n'));

  afterAll(async () => {
    if (driver) await driver.close();
  });

  describe('connect with a null value', () => {
    beforeEach(() =>
      run(
        `CREATE (:ItWrPost {id: $p, runId: $runId}), (:ItWrTag {id: $a, runId: $runId}), (:ItWrTag {id: $b, runId: $runId})`,
        { p: id('p'), a: id('ta'), b: id('tb') },
      ),
    );

    it('`connect: { tags: null }` links nothing', async () => {
      await ogm
        .model('ItWrPost')
        .update({ where: { id: id('p') }, connect: { tags: null } } as never);
      expect(await tagsOf(id('p'))).toEqual([]);
    });

    it('a null connect item throws OGMError and links nothing', async () => {
      await expect(
        ogm
          .model('ItWrPost')
          .update({
            where: { id: id('p') },
            connect: { tags: [null] },
          } as never),
      ).rejects.toThrow(OGMError);
      expect(await tagsOf(id('p'))).toEqual([]);
    });
  });

  describe('sibling nested connects', () => {
    beforeEach(() =>
      run(
        `CREATE (:ItWrUser {id: $u, runId: $runId}), (:ItWrPost {id: $p1, runId: $runId}), (:ItWrPost {id: $p2, runId: $runId}),
                (:ItWrTag {id: $a, runId: $runId, name: 'a'}), (:ItWrTag {id: $b, runId: $runId, name: 'b'})`,
        { u: id('u'), p1: id('p1'), p2: id('p2'), a: id('ta'), b: id('tb') },
      ),
    );

    it('each sibling links its own targets and edge values', async () => {
      await ogm.model('ItWrUser').update({
        where: { id: id('u') },
        connect: {
          pinned: {
            where: { node: { id: id('p1') } },
            connect: {
              tags: { where: { node: { name: 'a' } }, edge: { weight: 1 } },
            },
          },
          featured: {
            where: { node: { id: id('p2') } },
            connect: {
              tags: { where: { node: { name: 'b' } }, edge: { weight: 2 } },
            },
          },
        },
      } as never);
      expect(await tagsOf(id('p1'))).toEqual([{ t: id('ta'), w: 1 }]);
      expect(await tagsOf(id('p2'))).toEqual([{ t: id('tb'), w: 2 }]);
    });
  });

  describe('interface relationships touch member nodes only', () => {
    beforeEach(() =>
      run(
        `CREATE (o:ItWrOwner {id: $o, runId: $runId})
         CREATE (o)-[:IT_WR_HAS]->(:ItWrDog {id: $dog, runId: $runId, name: 'x'})
         CREATE (o)-[:IT_WR_HAS]->(:ItWrToy {id: $toy, runId: $runId, name: 'x'})`,
        { o: id('o'), dog: id('dog'), toy: id('toy') },
      ),
    );
    const node = async (nodeId: string) =>
      (
        await run('MATCH (n {id: $nodeId}) RETURN n.name AS name', { nodeId })
      )[0];

    it('a nested update on `pets` leaves the Toy unchanged', async () => {
      await ogm.model('ItWrOwner').update({
        where: { id: id('o') },
        update: {
          pets: [
            {
              where: { node: { name: 'x' } },
              update: { node: { name: 'renamed' } },
            },
          ],
        },
      } as never);
      expect(await node(id('dog'))).toEqual({ name: 'renamed' });
      expect(await node(id('toy'))).toEqual({ name: 'x' });
    });

    it('a nested delete on `pets` deletes the Dog and keeps the Toy', async () => {
      await ogm.model('ItWrOwner').update({
        where: { id: id('o') },
        update: { pets: [{ delete: [{ where: { node: { name: 'x' } } }] }] },
      } as never);
      expect(await node(id('dog'))).toBeUndefined();
      expect(await node(id('toy'))).toEqual({ name: 'x' });
    });

    it('a cascade delete through `pets` keeps the Toy', async () => {
      await ogm.model('ItWrOwner').delete({
        where: { id: id('o') },
        delete: { pets: [{ where: { node: { name: 'x' } } }] },
      } as never);
      expect(await node(id('dog'))).toBeUndefined();
      expect(await node(id('toy'))).toEqual({ name: 'x' });
    });
  });
});
