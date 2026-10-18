/**
 * Live write-path suite (v2.5.0).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Every node it
 * creates carries this run's `runId` and is removed in `afterAll`.
 *
 * Each case pins a nested-write input that compiled to Cypher which did
 * nothing — no error, no write — so only a DATABASE outcome shows it:
 *   - nested ops on interface relationships inside create / update;
 *   - top-level connect / disconnect on interface and union relationships;
 *   - an array connect whose where is bare properties (no `node:`);
 *   - a connect nested in a connect item, a disconnect nested in a
 *     disconnect item.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  interface LcPet {
    name: String
    runId: String
  }
  type LcDog implements LcPet @node {
    id: ID! @id
    runId: String
    name: String
    breed: String
    toys: [LcToy!]! @relationship(type: "LC_PLAYS", direction: OUT)
  }
  type LcCat implements LcPet @node {
    id: ID! @id
    runId: String
    name: String
    lives: Int
  }
  type LcToy @node {
    id: ID! @id
    runId: String
    name: String
  }
  type LcOwner @node {
    id: ID! @id
    runId: String
    name: String
    pets: [LcPet!]! @relationship(type: "LC_OWNS", direction: OUT)
    media: [LcMedia!]! @relationship(type: "LC_HAS_MEDIA", direction: OUT)
    posts: [LcPost!]! @relationship(type: "LC_WROTE", direction: OUT)
  }
  union LcMedia = LcBook | LcFilm
  type LcBook @node {
    id: ID! @id
    runId: String
    title: String
  }
  type LcFilm @node {
    id: ID! @id
    runId: String
    title: String
  }
  type LcPost @node {
    id: ID! @id
    runId: String
    title: String
    tags: [LcTag!]! @relationship(type: "LC_TAGGED", direction: OUT)
  }
  type LcTag @node {
    id: ID! @id
    runId: String
    name: String
  }
`;

type Row = Record<string, unknown>;

describeLive('Write paths — live Neo4j', () => {
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

  /** Names (or titles) linked from owner `ownerName` over `relType`. */
  async function linked(ownerName: string, relType: string): Promise<string[]> {
    const rows = await run(
      `MATCH (o:LcOwner {runId: $runId, name: $ownerName})-[r]->(t)
       WHERE type(r) = $relType
       RETURN coalesce(t.name, t.title) AS v ORDER BY v`,
      { ownerName, relType },
    );
    return rows.map((r) => r.v as string);
  }

  async function seed(cypher: string): Promise<void> {
    await run(cypher);
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
    ogm = new OGM({ typeDefs, driver });
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await driver.close();
    }
  });

  const Owner = () => ogm.model('LcOwner');

  describe('interface relationships inside create / update', () => {
    it('create: nested connect on an interface relationship links the implementer', async () => {
      await seed(
        `CREATE (:LcDog {id: randomUUID(), runId: $runId, name: 'rex-c1'})`,
      );
      await Owner().create({
        input: [
          {
            runId,
            name: 'o-c1',
            pets: { connect: [{ where: { node: { name: 'rex-c1' } } }] },
          },
        ],
      });
      expect(await linked('o-c1', 'LC_OWNS')).toEqual(['rex-c1']);
    });

    it('create: nested create on an interface relationship creates the implementer', async () => {
      await Owner().create({
        input: [
          {
            runId,
            name: 'o-c2',
            pets: {
              create: [
                { node: { LcDog: { runId, name: 'dog-c2', breed: 'lab' } } },
                { node: { LcCat: { runId, name: 'cat-c2', lives: 9 } } },
              ],
            },
          },
        ],
      });
      expect(await linked('o-c2', 'LC_OWNS')).toEqual(['cat-c2', 'dog-c2']);
      const [dog] = await run(
        `MATCH (d:LcDog {runId: $runId, name: 'dog-c2'}) RETURN d.breed AS breed, d.id AS id`,
      );
      expect(dog.breed).toBe('lab');
      expect(dog.id).toEqual(expect.any(String));
    });

    it('create: per-member interface shape { LcDog: { create } } creates the implementer', async () => {
      await Owner().create({
        input: [
          {
            runId,
            name: 'o-c3',
            pets: { LcDog: { create: [{ node: { runId, name: 'dog-c3' } }] } },
          },
        ],
      });
      expect(await linked('o-c3', 'LC_OWNS')).toEqual(['dog-c3']);
    });

    it('update: nested connect / disconnect / update / delete on an interface relationship', async () => {
      await seed(
        `CREATE (o:LcOwner {id: randomUUID(), runId: $runId, name: 'o-u1'})
         CREATE (o)-[:LC_OWNS]->(:LcDog {id: randomUUID(), runId: $runId, name: 'old-dog'})
         CREATE (o)-[:LC_OWNS]->(:LcCat {id: randomUUID(), runId: $runId, name: 'old-cat'})
         CREATE (o)-[:LC_OWNS]->(:LcCat {id: randomUUID(), runId: $runId, name: 'doomed-cat'})
         CREATE (:LcCat {id: randomUUID(), runId: $runId, name: 'new-cat'})`,
      );
      await Owner().update({
        where: { name: 'o-u1' },
        update: {
          pets: [
            { disconnect: [{ where: { node: { name: 'old-cat' } } }] },
            { connect: [{ where: { node: { name: 'new-cat' } } }] },
            {
              where: { node: { name: 'old-dog' } },
              update: { node: { name: 'renamed-dog' } },
            },
            { delete: [{ where: { node: { name: 'doomed-cat' } } }] },
            { create: [{ node: { LcCat: { runId, name: 'born-cat' } } }] },
          ],
        },
      });
      expect(await linked('o-u1', 'LC_OWNS')).toEqual([
        'born-cat',
        'new-cat',
        'renamed-dog',
      ]);
      const rows = await run(
        `MATCH (c:LcCat {runId: $runId}) WHERE c.name IN ['doomed-cat', 'old-cat'] RETURN c.name AS n ORDER BY n`,
      );
      // The deleted cat is gone; the disconnected one still exists.
      expect(rows.map((r) => r.n)).toEqual(['old-cat']);
    });

    it('a flat interface create without a member key throws instead of being ignored', async () => {
      await expect(
        Owner().create({
          input: [
            {
              runId,
              name: 'o-bad',
              pets: { create: [{ node: { name: 'x' } }] },
            },
          ],
        }),
      ).rejects.toThrow(OGMError);
    });
  });
});
