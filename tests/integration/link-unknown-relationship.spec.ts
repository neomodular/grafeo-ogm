/**
 * Live suite — unknown relationship in a connect / disconnect map (vNEXT,
 * strict item 28).
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
 *
 * Default mode keeps the 2.x behaviour: the unknown key is skipped, the
 * rest of the write runs and reports success, and one warning is logged.
 * `strict: true` throws `OGMError` and writes nothing.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGMError } from '../../src/errors';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItLurAuthor @node {
    id: ID! @unique
    runId: String
    posts: [ItLurPost!]! @relationship(type: "IT_LUR_WROTE", direction: OUT)
  }
  type ItLurPost @node {
    id: ID! @unique
    runId: String
    tags: [ItLurTag!]! @relationship(type: "IT_LUR_TAGGED", direction: OUT)
  }
  type ItLurTag @node {
    id: ID! @unique
    runId: String
  }
`;

type Row = Record<string, unknown>;

describeLive(
  'Unknown relationship in connect / disconnect — live Neo4j',
  () => {
    const runId = `it-${randomUUID()}`;
    let seq = 0;
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

    function makeOgm(strict?: boolean) {
      const warnings: string[] = [];
      const ogm = new OGM({
        typeDefs,
        driver,
        logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
        ...(strict === undefined ? {} : { strict }),
      });
      return { authors: ogm.model('ItLurAuthor'), warnings };
    }

    /** Author `u` linked to post `a`; post `b` and tag `t` unlinked. */
    async function seed() {
      seq++;
      const u = `${runId}-u-${seq}`;
      await run(
        `CREATE (u:ItLurAuthor {id: $u, runId: $runId})
       CREATE (u)-[:IT_LUR_WROTE]->(:ItLurPost {id: $a, runId: $runId})
       CREATE (:ItLurPost {id: $b, runId: $runId})
       CREATE (:ItLurTag {id: $t, runId: $runId})`,
        { u, a: `${u}-a`, b: `${u}-b`, t: `${u}-t` },
      );
      return { u, a: `${u}-a`, b: `${u}-b`, t: `${u}-t` };
    }

    async function links(u: string): Promise<string[]> {
      const rows = await run(
        `MATCH (:ItLurAuthor {id: $u})-[:IT_LUR_WROTE]->(p:ItLurPost)
       OPTIONAL MATCH (p)-[:IT_LUR_TAGGED]->(t:ItLurTag)
       RETURN p.id + coalesce('>' + t.id, '') AS l ORDER BY l`,
        { u },
      );
      return rows.map((r) => r.l as string);
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
      await run(
        'MATCH (n) WHERE (n:ItLurAuthor OR n:ItLurPost OR n:ItLurTag) AND n.runId = $runId DETACH DELETE n',
      );
      await driver.close();
    });

    const relWarnings = (w: string[]) =>
      w.filter((m) => m.includes('Unknown relationship'));

    it('default: a root connect on "post" links nothing, succeeds and warns once', async () => {
      const { u, a, b } = await seed();
      const { authors, warnings } = makeOgm();
      await authors.update({
        where: { id: u },
        connect: { post: [{ where: { node: { id: b } } }] },
      });
      expect(await links(u)).toEqual([a]);
      expect(relWarnings(warnings)).toHaveLength(1);
    });

    it('default: a root disconnect on "post" unlinks nothing', async () => {
      const { u, a } = await seed();
      const { authors } = makeOgm();
      await authors.update({
        where: { id: u },
        disconnect: { post: [{ where: { node: { id: a } } }] },
      });
      expect(await links(u)).toEqual([a]);
    });

    it('default: a nested connect on "tag" links the post but not the tag', async () => {
      const { u, a, b, t } = await seed();
      const { authors, warnings } = makeOgm();
      await authors.update({
        where: { id: u },
        connect: {
          posts: [
            {
              where: { node: { id: b } },
              connect: { tag: [{ where: { node: { id: t } } }] },
            },
          ],
        },
      });
      expect(await links(u)).toEqual([a, b]);
      expect(relWarnings(warnings)).toHaveLength(1);
    });

    it.each([
      [
        'root connect',
        { connect: { post: [{ where: { node: { id: 'x' } } }] } },
      ],
      ['root disconnect', { disconnect: { post: null } }],
    ])('strict: %s on an unknown relationship throws', async (_n, args) => {
      const { u, a } = await seed();
      const { authors, warnings } = makeOgm(true);
      await expect(
        authors.update({ where: { id: u }, ...args }),
      ).rejects.toThrow(OGMError);
      expect(await links(u)).toEqual([a]);
      expect(warnings).toEqual([]);
    });

    it('strict: a nested connect on "tag" throws and links nothing', async () => {
      const { u, a, b, t } = await seed();
      const { authors } = makeOgm(true);
      await expect(
        authors.update({
          where: { id: u },
          connect: {
            posts: [
              {
                where: { node: { id: b } },
                connect: { tag: [{ where: { node: { id: t } } }] },
              },
            ],
          },
        }),
      ).rejects.toThrow(
        'Unknown relationship "tag" in the connect input of ItLurPost',
      );
      expect(await links(u)).toEqual([a]);
    });

    it('strict: known nested connect still links post and tag', async () => {
      const { u, a, b, t } = await seed();
      const { authors } = makeOgm(true);
      await authors.update({
        where: { id: u },
        connect: {
          posts: [
            {
              where: { node: { id: b } },
              connect: { tags: [{ where: { node: { id: t } } }] },
            },
          ],
        },
      });
      expect(await links(u)).toEqual([a, `${b}>${t}`]);
    });
  },
);
