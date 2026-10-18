/**
 * Live write-path suite (v2.4.8).
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

  describe('top-level connect / disconnect on abstract relationships', () => {
    it('update.connect on an interface relationship links the implementer', async () => {
      await seed(
        `CREATE (:LcOwner {id: randomUUID(), runId: $runId, name: 'o-t1'})
         CREATE (:LcDog {id: randomUUID(), runId: $runId, name: 'rex-t1'})
         CREATE (:LcCat {id: randomUUID(), runId: $runId, name: 'tom-t1'})`,
      );
      await Owner().update({
        where: { name: 'o-t1' },
        connect: { pets: [{ where: { node: { name: 'rex-t1' } } }] },
      });
      await Owner().update({
        where: { name: 'o-t1' },
        connect: { pets: { LcCat: [{ where: { node: { name: 'tom-t1' } } }] } },
      });
      expect(await linked('o-t1', 'LC_OWNS')).toEqual(['rex-t1', 'tom-t1']);

      await Owner().update({
        where: { name: 'o-t1' },
        disconnect: { pets: [{ where: { node: { name: 'rex-t1' } } }] },
      });
      expect(await linked('o-t1', 'LC_OWNS')).toEqual(['tom-t1']);
    });

    it('update.connect on a union relationship links only the filtered member', async () => {
      await seed(
        `CREATE (:LcOwner {id: randomUUID(), runId: $runId, name: 'o-t2'})
         CREATE (:LcBook {id: randomUUID(), runId: $runId, title: 'book-t2'})
         CREATE (:LcBook {id: randomUUID(), runId: $runId, title: 'other-book-t2'})
         CREATE (:LcFilm {id: randomUUID(), runId: $runId, title: 'film-t2'})`,
      );
      await Owner().update({
        where: { name: 'o-t2' },
        connect: {
          media: {
            LcBook: [{ where: { node: { title: 'book-t2' } } }],
            LcFilm: [{ where: { node: { title: 'film-t2' } } }],
          },
        },
      });
      expect(await linked('o-t2', 'LC_HAS_MEDIA')).toEqual([
        'book-t2',
        'film-t2',
      ]);

      await Owner().update({
        where: { name: 'o-t2' },
        disconnect: {
          media: { LcFilm: [{ where: { node: { title: 'film-t2' } } }] },
        },
      });
      expect(await linked('o-t2', 'LC_HAS_MEDIA')).toEqual(['book-t2']);
    });
  });

  describe('array connect with a bare-property where', () => {
    it('links every item, like the { node } shape', async () => {
      await seed(
        `CREATE (:LcOwner {id: randomUUID(), runId: $runId, name: 'o-b1'})
         CREATE (:LcPost {id: randomUUID(), runId: $runId, title: 'p-b1'})
         CREATE (:LcPost {id: randomUUID(), runId: $runId, title: 'q-b1'})`,
      );
      await Owner().update({
        where: { name: 'o-b1' },
        connect: {
          posts: [{ where: { title: 'p-b1' } }, { where: { title: 'q-b1' } }],
        },
      });
      expect(await linked('o-b1', 'LC_WROTE')).toEqual(['p-b1', 'q-b1']);
    });
  });

  describe('nested connect / disconnect inside a connect / disconnect item', () => {
    async function postTags(title: string): Promise<string[]> {
      const rows = await run(
        `MATCH (:LcPost {runId: $runId, title: $title})-[:LC_TAGGED]->(t) RETURN t.name AS n ORDER BY n`,
        { title },
      );
      return rows.map((r) => r.n as string);
    }

    it('update.connect: connect inside a connect item links the deeper node', async () => {
      await seed(
        `CREATE (:LcOwner {id: randomUUID(), runId: $runId, name: 'o-n1'})
         CREATE (:LcPost {id: randomUUID(), runId: $runId, title: 'p-n1'})
         CREATE (:LcTag {id: randomUUID(), runId: $runId, name: 't-n1'})`,
      );
      await Owner().update({
        where: { name: 'o-n1' },
        connect: {
          posts: [
            {
              where: { node: { title: 'p-n1' } },
              connect: [{ tags: [{ where: { node: { name: 't-n1' } } }] }],
            },
          ],
        },
      });
      expect(await linked('o-n1', 'LC_WROTE')).toEqual(['p-n1']);
      expect(await postTags('p-n1')).toEqual(['t-n1']);
    });

    it('create: connect inside a nested connect item links the deeper node', async () => {
      await seed(
        `CREATE (:LcPost {id: randomUUID(), runId: $runId, title: 'p-n2'})
         CREATE (:LcTag {id: randomUUID(), runId: $runId, name: 't-n2'})`,
      );
      await Owner().create({
        input: [
          {
            runId,
            name: 'o-n2',
            posts: {
              connect: [
                {
                  where: { node: { title: 'p-n2' } },
                  connect: [{ tags: [{ where: { node: { name: 't-n2' } } }] }],
                },
              ],
            },
          },
        ],
      });
      expect(await linked('o-n2', 'LC_WROTE')).toEqual(['p-n2']);
      expect(await postTags('p-n2')).toEqual(['t-n2']);
    });

    it('update.disconnect: disconnect inside a disconnect item unlinks the deeper node', async () => {
      await seed(
        `CREATE (o:LcOwner {id: randomUUID(), runId: $runId, name: 'o-n3'})
         CREATE (o)-[:LC_WROTE]->(p:LcPost {id: randomUUID(), runId: $runId, title: 'p-n3'})
         CREATE (p)-[:LC_TAGGED]->(:LcTag {id: randomUUID(), runId: $runId, name: 't-n3'})
         CREATE (p)-[:LC_TAGGED]->(:LcTag {id: randomUUID(), runId: $runId, name: 'keep-n3'})`,
      );
      await Owner().update({
        where: { name: 'o-n3' },
        disconnect: {
          posts: [
            {
              where: { node: { title: 'p-n3' } },
              disconnect: { tags: [{ where: { node: { name: 't-n3' } } }] },
            },
          ],
        },
      });
      expect(await linked('o-n3', 'LC_WROTE')).toEqual([]);
      expect(await postTags('p-n3')).toEqual(['keep-n3']);
    });

    it('nested update: disconnect inside a disconnect item unlinks the deeper node', async () => {
      await seed(
        `CREATE (o:LcOwner {id: randomUUID(), runId: $runId, name: 'o-n4'})
         CREATE (o)-[:LC_WROTE]->(p:LcPost {id: randomUUID(), runId: $runId, title: 'p-n4'})
         CREATE (p)-[:LC_TAGGED]->(:LcTag {id: randomUUID(), runId: $runId, name: 't-n4'})`,
      );
      await Owner().update({
        where: { name: 'o-n4' },
        update: {
          posts: [
            {
              disconnect: [
                {
                  where: { node: { title: 'p-n4' } },
                  disconnect: { tags: [{ where: { node: { name: 't-n4' } } }] },
                },
              ],
            },
          ],
        },
      });
      expect(await linked('o-n4', 'LC_WROTE')).toEqual([]);
      expect(await postTags('p-n4')).toEqual([]);
    });
  });
});
