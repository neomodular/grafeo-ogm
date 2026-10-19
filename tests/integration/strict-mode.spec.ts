/**
 * Live strict-mode suite, write paths (v2.6.0).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed in `afterAll`.
 *
 * For each shape strict mode corrects: the default OGM still returns the
 * v2.5.3 result and logs exactly one warning; a `strict: true` OGM throws
 * or returns the corrected result.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItSmWrote @relationshipProperties {
    role: String
  }
  type ItSmUser @node {
    id: ID! @unique
    email: String @unique
    name: String
    runId: String
    pets: [ItSmPet!]! @relationship(type: "IT_SM_HAS", direction: OUT)
    toys: [ItSmToy!]! @relationship(type: "IT_SM_HAS", direction: OUT)
    posts: [ItSmPost!]!
      @relationship(
        type: "IT_SM_WROTE"
        direction: OUT
        properties: "ItSmWrote"
      )
  }
  type ItSmPet @node {
    id: ID! @unique
    runId: String
  }
  type ItSmToy @node {
    id: ID! @unique
    runId: String
  }
  type ItSmPost @node {
    id: ID! @unique
    runId: String
  }
`;

type Row = Record<string, unknown>;

describeLive('Strict mode, write paths — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;
  let driver: Driver;

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

  /** A default (`strict` unset) or strict OGM with a capturing logger. */
  function makeOgm(strict?: boolean) {
    const warnings: string[] = [];
    const logger = {
      debug: () => {},
      warn: (m: string) => {
        warnings.push(m);
      },
    };
    const ogm = new OGM({
      typeDefs,
      driver,
      logger,
      ...(strict === undefined ? {} : { strict }),
    });
    // Item 4 warns at construction; the per-call assertions skip it.
    const callWarnings = () =>
      warnings.filter((w) => !w.includes('share relationship type'));
    return { ogm, warnings, callWarnings };
  }

  /** Ids of the `label` nodes linked from user `userId` by `type`. */
  async function linked(
    userId: string,
    type: string,
    label: string,
  ): Promise<string[]> {
    const rows = await run(
      `MATCH (:ItSmUser {id: $userId})-[:${type}]->(t:${label})
       RETURN t.id AS id ORDER BY id`,
      { userId },
    );
    return rows.map((r) => r.id as string);
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
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await driver.close();
    }
  });

  describe('item 1 — unknown connect / disconnect item keys', () => {
    async function seed(tag: string) {
      await run(
        `CREATE (:ItSmUser {id: $u, runId: $runId})
         CREATE (:ItSmPet {id: $p1, runId: $runId})
         CREATE (:ItSmPet {id: $p2, runId: $runId})`,
        { u: id(`${tag}-u`), p1: id(`${tag}-p1`), p2: id(`${tag}-p2`) },
      );
      return { u: id(`${tag}-u`), p1: id(`${tag}-p1`), p2: id(`${tag}-p2`) };
    }

    it('default: a typo’d connect key links every target, warning once', async () => {
      const { u, p1, p2 } = await seed('c-def');
      const { ogm, callWarnings } = makeOgm();
      await ogm.model('ItSmUser').update({
        where: { id: u },
        connect: { pets: [{ wehre: { node: { id: p1 } } }] },
      });
      const all = await linked(u, 'IT_SM_HAS', 'ItSmPet');
      expect(all).toEqual(expect.arrayContaining([p1, p2]));
      expect(callWarnings()).toHaveLength(1);
      expect(callWarnings()[0]).toContain(
        'Unknown key(s) "wehre" in a connect item on "pets"',
      );
    });

    it('strict: a typo’d connect key throws and links nothing', async () => {
      const { u } = await seed('c-str');
      const { ogm } = makeOgm(true);
      await expect(
        ogm.model('ItSmUser').update({
          where: { id: u },
          connect: { pets: [{ wehre: { node: { id: 'x' } } }] },
        }),
      ).rejects.toThrow('Unknown key(s) "wehre" in a connect item on "pets"');
      expect(await linked(u, 'IT_SM_HAS', 'ItSmPet')).toEqual([]);
    });

    it('default: a typo’d disconnect key unlinks every related target, warning once', async () => {
      const { u, p1, p2 } = await seed('d-def');
      await run(
        `MATCH (u:ItSmUser {id: $u}), (p:ItSmPet) WHERE p.id IN [$p1, $p2]
         CREATE (u)-[:IT_SM_HAS]->(p)`,
        { u, p1, p2 },
      );
      const { ogm, callWarnings } = makeOgm();
      await ogm.model('ItSmUser').update({
        where: { id: u },
        disconnect: { pets: [{ wehre: { node: { id: p1 } } }] },
      });
      expect(await linked(u, 'IT_SM_HAS', 'ItSmPet')).toEqual([]);
      expect(callWarnings()).toHaveLength(1);
    });

    it('strict: a typo’d disconnect key throws and unlinks nothing', async () => {
      const { u, p1, p2 } = await seed('d-str');
      await run(
        `MATCH (u:ItSmUser {id: $u}), (p:ItSmPet) WHERE p.id IN [$p1, $p2]
         CREATE (u)-[:IT_SM_HAS]->(p)`,
        { u, p1, p2 },
      );
      const { ogm } = makeOgm(true);
      await expect(
        ogm.model('ItSmUser').update({
          where: { id: u },
          disconnect: { pets: [{ wehre: { node: { id: p1 } } }] },
        }),
      ).rejects.toThrow('in a disconnect item on "pets"');
      expect(await linked(u, 'IT_SM_HAS', 'ItSmPet')).toEqual([p1, p2].sort());
    });
  });

  describe('item 2 — unknown edge-property keys', () => {
    async function edgeProps(u: string, p: string): Promise<Row | null> {
      const [row] = await run(
        `MATCH (:ItSmUser {id: $u})-[r:IT_SM_WROTE]->(:ItSmPost {id: $p})
         RETURN properties(r) AS props`,
        { u, p },
      );
      return (row?.props ?? null) as Row | null;
    }

    async function seed(tag: string) {
      const [u, p] = [id(`${tag}-u`), id(`${tag}-p`)];
      await run(
        'CREATE (:ItSmUser {id: $u, runId: $runId}), (:ItSmPost {id: $p, runId: $runId})',
        { u, p },
      );
      return { u, p };
    }

    it('default: a typo’d edge key is stored as a stray property, warning once', async () => {
      const { u, p } = await seed('e-def');
      const { ogm, callWarnings } = makeOgm();
      await ogm.model('ItSmUser').update({
        where: { id: u },
        connect: {
          posts: [{ where: { node: { id: p } }, edge: { rolee: 'x' } }],
        },
      });
      expect(await edgeProps(u, p)).toEqual({ rolee: 'x' });
      expect(callWarnings()).toHaveLength(1);
      expect(callWarnings()[0]).toContain(
        'Unknown field "rolee" in the edge input of "posts"',
      );
    });

    it('strict: a typo’d edge key throws and writes nothing', async () => {
      const { u, p } = await seed('e-str');
      const { ogm } = makeOgm(true);
      await expect(
        ogm.model('ItSmUser').update({
          where: { id: u },
          update: {
            posts: [
              {
                create: [
                  {
                    node: { id: id('e-str-p2'), runId },
                    edge: { rolee: 'x' },
                  },
                ],
              },
            ],
          },
        }),
      ).rejects.toThrow(
        'Unknown field "rolee" in the edge input (nested create)',
      );
      expect(await edgeProps(u, id('e-str-p2'))).toBeNull();
      // A declared edge field still works in strict mode.
      await ogm.model('ItSmUser').update({
        where: { id: u },
        connect: {
          posts: [{ where: { node: { id: p } }, edge: { role: 'r' } }],
        },
      });
      expect(await edgeProps(u, p)).toEqual({ role: 'r' });
    });
  });

  describe('item 3 — upsert where with several unique keys', () => {
    const usersWithEmail = async (email: string) =>
      (
        await run(
          'MATCH (u:ItSmUser {email: $email}) RETURN u.id AS id ORDER BY id',
          { email },
        )
      ).map((r) => r.id as string);

    it('default: { id, email } misses the node with that email and creates a duplicate, warning once', async () => {
      const email = `${runId}-dup@x`;
      await run('CREATE (:ItSmUser {id: $u, email: $email, runId: $runId})', {
        u: id('up-def-a'),
        email,
      });
      const { ogm, callWarnings } = makeOgm();
      await ogm.model('ItSmUser').upsert({
        where: { id: id('up-def-b'), email },
        create: { runId },
        update: { name: 'updated' },
      });
      expect(await usersWithEmail(email)).toEqual(
        [id('up-def-a'), id('up-def-b')].sort(),
      );
      expect(callWarnings()).toHaveLength(1);
      expect(callWarnings()[0]).toContain(
        'with several unique keys in "where" ("id", "email")',
      );
    });

    it('strict: two unique keys throw; one key matches the existing node', async () => {
      const email = `${runId}-one@x`;
      await run('CREATE (:ItSmUser {id: $u, email: $email, runId: $runId})', {
        u: id('up-str-a'),
        email,
      });
      const { ogm } = makeOgm(true);
      await expect(
        ogm.model('ItSmUser').upsert({
          where: { id: id('up-str-b'), email },
          create: { runId },
          update: { name: 'updated' },
        }),
      ).rejects.toThrow('must name exactly one @id / @unique field');
      const res = (await ogm.model('ItSmUser').upsert({
        where: { email },
        create: { id: id('up-str-b'), runId },
        update: { name: 'updated' },
        selectionSet: '{ id name }',
      })) as Row;
      expect(res).toEqual({ id: id('up-str-a'), name: 'updated' });
      expect(await usersWithEmail(email)).toEqual([id('up-str-a')]);
    });
  });

  describe('item 4 — blanket disconnect on a shared relationship type', () => {
    async function seed(tag: string) {
      const [u, p, t] = [id(`${tag}-u`), id(`${tag}-p`), id(`${tag}-t`)];
      await run(
        `CREATE (u:ItSmUser {id: $u, runId: $runId})
         CREATE (u)-[:IT_SM_HAS]->(:ItSmPet {id: $p, runId: $runId})
         CREATE (u)-[:IT_SM_HAS]->(:ItSmToy {id: $t, runId: $runId})`,
        { u, p, t },
      );
      return { u, p, t };
    }
    const shared = (warnings: string[]) =>
      warnings.filter((w) => w.includes('share relationship type'));

    it('default: disconnecting all pets also unlinks the toys, warning once at construction', async () => {
      const { u } = await seed('b-def');
      const { ogm, warnings } = makeOgm();
      await ogm
        .model('ItSmUser')
        .update({ where: { id: u }, disconnect: { pets: {} } });
      expect(await linked(u, 'IT_SM_HAS', 'ItSmPet')).toEqual([]);
      expect(await linked(u, 'IT_SM_HAS', 'ItSmToy')).toEqual([]);
      expect(shared(warnings)).toEqual([
        expect.stringContaining(
          'ItSmUser.pets (ItSmPet) and ItSmUser.toys (ItSmToy) share relationship type "IT_SM_HAS" (OUT)',
        ),
      ]);
      expect(warnings).toHaveLength(1);
    });

    it('strict: disconnecting all pets keeps the toys (top-level and nested)', async () => {
      const { ogm, warnings } = makeOgm(true);
      const a = await seed('b-str');
      await ogm
        .model('ItSmUser')
        .update({ where: { id: a.u }, disconnect: { pets: null } });
      expect(await linked(a.u, 'IT_SM_HAS', 'ItSmPet')).toEqual([]);
      expect(await linked(a.u, 'IT_SM_HAS', 'ItSmToy')).toEqual([a.t]);

      const b = await seed('b-str-nested');
      await ogm.model('ItSmUser').update({
        where: { id: b.u },
        update: { pets: [{ disconnect: [{}] }] },
      });
      expect(await linked(b.u, 'IT_SM_HAS', 'ItSmPet')).toEqual([]);
      expect(await linked(b.u, 'IT_SM_HAS', 'ItSmToy')).toEqual([b.t]);
      expect(warnings).toEqual([]);
    });
  });
});
