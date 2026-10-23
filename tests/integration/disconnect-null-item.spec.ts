/**
 * Live suite (vNEXT): `null` / `undefined` items inside disconnect arrays.
 *
 * - Root (strict item 26): `disconnect: { posts: [{ where }, undefined] }`
 *   unlinks EVERY related node in default mode (as before, with a one-time
 *   warning); `strict: true` throws an OGMError and leaves the links alone.
 * - Nested (`update: { posts: [{ disconnect: [item, undefined] }] }`, and a
 *   null nested update / create item): pre-vNEXT a raw TypeError; now an
 *   OGMError in both modes, with nothing written.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterEach`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItDnAuthor @node {
    id: ID! @id
    runId: String
    name: String
    posts: [ItDnPost!]! @relationship(type: "IT_DN_WROTE", direction: OUT)
  }
  type ItDnPost @node {
    id: ID! @id
    runId: String
    title: String
  }
`;

describeLive('null items in disconnect arrays (vNEXT) — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let driver: Driver;

  async function titles(id: string): Promise<string[]> {
    const session = driver.session();
    try {
      const res = await session.run(
        'MATCH (:ItDnAuthor {id: $id})-[:IT_DN_WROTE]->(p) RETURN p.title AS t ORDER BY t',
        { id },
      );
      return res.records.map((r) => r.get('t') as string);
    } finally {
      await session.close();
    }
  }

  async function author(ogm: OGM): Promise<string> {
    const r = await ogm.model('ItDnAuthor').create({
      input: [
        {
          runId,
          name: 'a',
          posts: {
            create: [
              { node: { runId, title: 'p1' } },
              { node: { runId, title: 'p2' } },
              { node: { runId, title: 'p3' } },
            ],
          },
        },
      ],
    });
    return (Object.values(r).find(Array.isArray) as { id: string }[])[0].id;
  }

  const make = (strict: boolean) => {
    const logger = { debug: jest.fn(), warn: jest.fn() };
    return { ogm: new OGM({ typeDefs, driver, strict, logger }), logger };
  };

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

  afterEach(async () => {
    const session = driver.session();
    try {
      await session.run(
        'MATCH (n) WHERE (n:ItDnAuthor OR n:ItDnPost) AND n.runId = $runId DETACH DELETE n',
        { runId },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (driver) await driver.close();
  });

  it('default: a root [item, undefined] still unlinks every post, and warns once', async () => {
    const { ogm, logger } = make(false);
    const id = await author(ogm);
    await ogm.model('ItDnAuthor').update({
      where: { id },
      disconnect: { posts: [{ where: { node: { title: 'p1' } } }, undefined] },
    });
    expect(await titles(id)).toEqual([]);
    expect(
      logger.warn.mock.calls.filter((c) =>
        String(c[0]).includes('disconnect array of "posts"'),
      ),
    ).toHaveLength(1);
  });

  it('strict: a root [item, null] throws an OGMError and unlinks nothing', async () => {
    const { ogm } = make(true);
    const id = await author(ogm);
    await expect(
      ogm.model('ItDnAuthor').update({
        where: { id },
        disconnect: { posts: [{ where: { node: { title: 'p1' } } }, null] },
      }),
    ).rejects.toThrow(OGMError);
    expect(await titles(id)).toEqual(['p1', 'p2', 'p3']);
  });

  it.each([false, true])(
    'strict=%s: a root [{}] / null spec stays the blanket disconnect',
    async (strict) => {
      const { ogm } = make(strict);
      const id = await author(ogm);
      await ogm
        .model('ItDnAuthor')
        .update({ where: { id }, disconnect: { posts: [{}] } });
      expect(await titles(id)).toEqual([]);
    },
  );

  it.each([false, true])(
    'strict=%s: null items in nested write arrays throw an OGMError and write nothing',
    async (strict) => {
      const { ogm } = make(strict);
      const id = await author(ogm);
      const A = ogm.model('ItDnAuthor');
      await expect(
        A.update({
          where: { id },
          update: {
            posts: [
              { disconnect: [{ where: { node: { title: 'p1' } } }, undefined] },
            ],
          },
        }),
      ).rejects.toThrow(OGMError);
      await expect(
        A.update({ where: { id }, update: { posts: [null] } }),
      ).rejects.toThrow(OGMError);
      await expect(
        A.update({ where: { id }, update: { posts: [{ create: [null] }] } }),
      ).rejects.toThrow(OGMError);
      expect(await titles(id)).toEqual(['p1', 'p2', 'p3']);
    },
  );
});
