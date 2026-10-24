/**
 * Live suite — unknown keys in nested write objects (v2.10.0, strict
 * item 22).
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
 *
 * Default mode keeps the 2.x behaviour: a typo'd `wher` in a nested update
 * item is ignored, so the item's `update` rewrites EVERY related node, and
 * a typo'd `creat` in `create()` writes no related node; each logs one
 * warning. `strict: true` throws `OGMError` and writes nothing.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGMError } from '../../src/errors';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItNwkAuthor @node {
    id: ID! @unique
    runId: String
    name: String
    posts: [ItNwkPost!]! @relationship(type: "IT_NWK_WROTE", direction: OUT)
  }
  type ItNwkPost @node {
    id: ID! @unique
    runId: String
    title: String
  }
`;

type Row = Record<string, unknown>;

describeLive('Unknown keys in nested write objects — live Neo4j', () => {
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
    return { authors: ogm.model('ItNwkAuthor'), warnings };
  }

  /** An author linked to posts `a` and `b`, both titled "old". */
  async function seed() {
    seq++;
    const u = `${runId}-u-${seq}`;
    await run(
      `CREATE (u:ItNwkAuthor {id: $u, runId: $runId})
       CREATE (u)-[:IT_NWK_WROTE]->(:ItNwkPost {id: $a, runId: $runId, title: 'old'})
       CREATE (u)-[:IT_NWK_WROTE]->(:ItNwkPost {id: $b, runId: $runId, title: 'old'})`,
      { u, a: `${u}-a`, b: `${u}-b` },
    );
    return { u, a: `${u}-a`, b: `${u}-b` };
  }

  async function titles(u: string): Promise<Record<string, string>> {
    const rows = await run(
      `MATCH (:ItNwkAuthor {id: $u})-[:IT_NWK_WROTE]->(p:ItNwkPost)
       RETURN p.id AS id, p.title AS title ORDER BY id`,
      { u },
    );
    return Object.fromEntries(
      rows.map((r) => [r.id as string, r.title as string]),
    );
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
      'MATCH (n) WHERE (n:ItNwkAuthor OR n:ItNwkPost) AND n.runId = $runId DETACH DELETE n',
    );
    await driver.close();
  });

  const keyWarnings = (w: string[]) =>
    w.filter((m) => m.includes('Unknown key(s)'));

  const whereTypo = (u: string, a: string) => ({
    where: { id: u },
    update: {
      posts: [
        { wher: { node: { id: a } }, update: { node: { title: 'new' } } },
      ],
    },
  });

  it('default: a typo\'d "wher" is ignored, so every related post is renamed (and warns)', async () => {
    const { u, a, b } = await seed();
    const { authors, warnings } = makeOgm();
    await authors.update(whereTypo(u, a));
    expect(await titles(u)).toEqual({ [a]: 'new', [b]: 'new' });
    expect(keyWarnings(warnings)).toEqual([
      expect.stringContaining(
        'Unknown key(s) "wher" in a nested update item on "posts" is ignored; with no "where", ' +
          'the item\'s "update" applies to EVERY related "ItNwkPost" node.',
      ),
    ]);
  });

  it('strict: a typo\'d "wher" throws and renames nothing', async () => {
    const { u, a, b } = await seed();
    const { authors, warnings } = makeOgm(true);
    await expect(authors.update(whereTypo(u, a))).rejects.toThrow(
      new OGMError(
        'Unknown key(s) "wher" in a nested update item on "posts". ' +
          'Allowed: "where", "update", "connect", "disconnect", "create", "delete", "connectOrCreate".',
      ),
    );
    expect(await titles(u)).toEqual({ [a]: 'old', [b]: 'old' });
    expect(warnings).toEqual([]);
  });

  it('strict: the correct "where" renames only that post', async () => {
    const { u, a, b } = await seed();
    const { authors } = makeOgm(true);
    await authors.update({
      where: { id: u },
      update: {
        posts: [
          { where: { node: { id: a } }, update: { node: { title: 'new' } } },
        ],
      },
    });
    expect(await titles(u)).toEqual({ [a]: 'new', [b]: 'old' });
  });

  it('a typo\'d "creat" in create(): default writes the author alone (and warns), strict writes nothing', async () => {
    seq++;
    const input = (u: string) => ({
      input: [
        {
          id: u,
          runId,
          posts: { creat: [{ node: { id: `${u}-p`, runId, title: 't' } }] },
        },
      ],
    });
    const lenient = makeOgm();
    const u1 = `${runId}-c-${seq}-default`;
    await lenient.authors.create(input(u1));
    expect(
      await run('MATCH (u:ItNwkAuthor {id: $u1}) RETURN u.id AS id', { u1 }),
    ).toEqual([{ id: u1 }]);
    expect(await titles(u1)).toEqual({});
    expect(keyWarnings(lenient.warnings)).toHaveLength(1);

    const strict = makeOgm(true);
    const u2 = `${runId}-c-${seq}-strict`;
    await expect(strict.authors.create(input(u2))).rejects.toThrow(
      'Unknown key(s) "creat" in the nested create input on "posts". Allowed: "create", "connect".',
    );
    expect(
      await run('MATCH (n) WHERE n.id STARTS WITH $u2 RETURN count(n) AS c', {
        u2,
      }),
    ).toEqual([{ c: 0 }]);
  });
});
