/**
 * Live row-cardinality suite for mutations (issue #8, v2.3.2).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Every node it
 * creates carries this run's `runId` and is removed in `afterAll`, so it
 * is safe to point at a shared development database.
 *
 * A disconnect is an `OPTIONAL MATCH ... DELETE`, which yields one row per
 * matched relationship. Emitted inline, that fan-out multiplied every
 * later clause: a nested `create` after a disconnect-all ran once per
 * previously connected node. These tests assert DATABASE OUTCOMES (nodes
 * created, rows returned), which mock-driver string checks cannot see.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItCardChapter @node {
    id: ID! @unique
    runId: String
    title: String
    books: [ItCardBook!]! @relationship(type: "IT_CARD_HAS", direction: IN)
  }
  type ItCardBook @node {
    id: ID! @unique
    runId: String
    title: String
    chapters: [ItCardChapter!]!
      @relationship(type: "IT_CARD_HAS", direction: OUT)
  }
`;

type Row = Record<string, unknown>;

describeLive('Mutation row cardinality — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const id = (suffix: string) => `${runId}-${suffix}`;
  let driver: Driver;
  let ogm: OGM;
  let plural: string;

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

  /** A book linked to `n` chapters titled `old-<i>`. */
  async function seedBook(tag: string, n: number): Promise<string> {
    const bookId = id(`${tag}-book`);
    await run(
      `CREATE (b:ItCardBook {id: $bookId, runId: $runId})
       WITH b UNWIND range(1, $n) AS i
       CREATE (b)-[:IT_CARD_HAS]->(:ItCardChapter {id: $bookId + '-c' + i, runId: $runId, title: 'old-' + i})`,
      { bookId, n: neo4j.int(n) },
    );
    return bookId;
  }

  async function chapterIds(bookId: string): Promise<string[]> {
    const rows = await run(
      `MATCH (:ItCardBook {id: $bookId})-[:IT_CARD_HAS]->(c) RETURN c.id AS id ORDER BY id`,
      { bookId },
    );
    return rows.map((r) => r.id as string);
  }

  async function countTitled(title: string): Promise<number> {
    const rows = await run(
      'MATCH (c:ItCardChapter {runId: $runId, title: $title}) RETURN count(c) AS c',
      { title },
    );
    return Number(rows[0].c);
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
    plural = (
      ogm.model('ItCardBook') as unknown as {
        nodeDef: { pluralName: string };
      }
    ).nodeDef.pluralName;
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await driver.close();
    }
  });

  it('nested disconnect-all then create creates exactly one node', async () => {
    const bookId = await seedBook('nested-all', 3);
    const res = (await ogm.model('ItCardBook').update({
      where: { id: bookId },
      update: {
        chapters: [
          { disconnect: [{}] },
          {
            create: [
              { node: { id: id('nested-all-new'), runId, title: 'new-a' } },
            ],
          },
        ],
      },
      select: { [plural]: { id: true } },
    })) as Row;
    expect(res[plural]).toEqual([{ id: bookId }]);
    expect(await countTitled('new-a')).toBe(1);
    expect(await chapterIds(bookId)).toEqual([id('nested-all-new')]);
  });

  it('nested conditional disconnect then create creates exactly one node', async () => {
    const bookId = await seedBook('nested-where', 3);
    const res = (await ogm.model('ItCardBook').update({
      where: { id: bookId },
      update: {
        chapters: [
          { disconnect: [{ where: { node: { title_STARTS_WITH: 'old' } } }] },
          {
            create: [
              { node: { id: id('nested-where-new'), runId, title: 'new-b' } },
            ],
          },
        ],
      },
      select: { [plural]: { id: true } },
    })) as Row;
    expect(res[plural]).toEqual([{ id: bookId }]);
    expect(await countTitled('new-b')).toBe(1);
  });

  it('top-level disconnect-all then connect returns the node once', async () => {
    const bookId = await seedBook('top-all', 3);
    const keep = id('top-all-keep');
    await run(
      'CREATE (:ItCardChapter {id: $keep, runId: $runId, title: "keep"})',
      { keep },
    );
    const res = (await ogm.model('ItCardBook').update({
      where: { id: bookId },
      disconnect: { chapters: [{}] },
      connect: { chapters: [{ where: { node: { id: keep } } }] },
      select: { [plural]: { id: true } },
    })) as Row;
    expect(res[plural]).toEqual([{ id: bookId }]);
    expect(await chapterIds(bookId)).toEqual([keep]);
  });

  it('top-level conditional disconnect keeps the other links and one row', async () => {
    const bookId = await seedBook('top-where', 3);
    const res = (await ogm.model('ItCardBook').update({
      where: { id: bookId },
      update: { title: 'renamed' },
      disconnect: {
        chapters: [
          { where: { node: { id_IN: [`${bookId}-c1`, `${bookId}-c2`] } } },
        ],
      },
      select: { [plural]: { id: true, title: true } },
    })) as Row;
    expect(res[plural]).toEqual([{ id: bookId, title: 'renamed' }]);
    expect(await chapterIds(bookId)).toEqual([`${bookId}-c3`]);
  });

  // #10 — connect to a target that doesn't exist is a no-op (as in
  // @neo4j/graphql): the SET commits AND the node is returned.
  it('connect to a missing target is a no-op that still returns the node', async () => {
    const bookId = await seedBook('conn-missing', 0);
    const res = (await ogm.model('ItCardBook').update({
      where: { id: bookId },
      update: { title: 'set-anyway' },
      connect: { chapters: [{ where: { node: { id: id('nope') } } }] },
      select: { [plural]: { id: true, title: true } },
    })) as Row;
    expect(res[plural]).toEqual([{ id: bookId, title: 'set-anyway' }]);
    expect(await chapterIds(bookId)).toEqual([]);
  });

  it('single (non-array) connect to a missing target still returns the node', async () => {
    const bookId = await seedBook('conn-missing-single', 0);
    const res = (await ogm.model('ItCardBook').update({
      where: { id: bookId },
      update: { title: 'single' },
      connect: { chapters: { where: { node: { id: id('nope') } } } },
      select: { [plural]: { id: true, title: true } },
    })) as Row;
    expect(res[plural]).toEqual([{ id: bookId, title: 'single' }]);
  });

  it('array connect to several targets returns the node once', async () => {
    const bookId = await seedBook('conn-many', 0);
    const a = id('conn-many-a');
    const b = id('conn-many-b');
    await run(
      `CREATE (:ItCardChapter {id: $a, runId: $runId}), (:ItCardChapter {id: $b, runId: $runId})`,
      { a, b },
    );
    const res = (await ogm.model('ItCardBook').update({
      where: { id: bookId },
      connect: {
        chapters: [
          { where: { node: { id: a } } },
          { where: { node: { id: b } } },
        ],
      },
      select: { [plural]: { id: true } },
    })) as Row;
    expect(res[plural]).toEqual([{ id: bookId }]);
    expect(await chapterIds(bookId)).toEqual([a, b].sort());
  });

  it('connect with an empty array still returns the node', async () => {
    const bookId = await seedBook('conn-empty', 0);
    const res = (await ogm.model('ItCardBook').update({
      where: { id: bookId },
      update: { title: 'empty-connect' },
      connect: { chapters: [] },
      select: { [plural]: { id: true, title: true } },
    })) as Row;
    expect(res[plural]).toEqual([{ id: bookId, title: 'empty-connect' }]);
  });

  // #12 — a multi-input create returned only the first created node.
  it('create with several inputs returns every node, in order', async () => {
    const res = (await ogm.model('ItCardBook').create({
      input: [
        { id: id('multi-1'), runId, title: 'one' },
        { id: id('multi-2'), runId, title: 'two' },
        { id: id('multi-3'), runId, title: 'three' },
      ],
      select: { [plural]: { id: true, title: true } },
    })) as Row;
    expect(res[plural]).toEqual([
      { id: id('multi-1'), title: 'one' },
      { id: id('multi-2'), title: 'two' },
      { id: id('multi-3'), title: 'three' },
    ]);
  });

  it('create with several inputs and nested creates returns every root once', async () => {
    const res = (await ogm.model('ItCardBook').create({
      input: [
        {
          id: id('mn-1'),
          runId,
          chapters: {
            create: [
              { node: { id: id('mn-1-a'), runId } },
              { node: { id: id('mn-1-b'), runId } },
            ],
          },
        },
        {
          id: id('mn-2'),
          runId,
          chapters: { create: [{ node: { id: id('mn-2-a'), runId } }] },
        },
      ],
      selectionSet: `{ ${plural} { id chapters { id } } }`,
    })) as Row;
    const books = res[plural] as { id: string; chapters: { id: string }[] }[];
    expect(books.map((b) => b.id)).toEqual([id('mn-1'), id('mn-2')]);
    expect(books[0].chapters.map((c) => c.id).sort()).toEqual(
      [id('mn-1-a'), id('mn-1-b')].sort(),
    );
    expect(books[1].chapters.map((c) => c.id)).toEqual([id('mn-2-a')]);
  });

  it('disconnect on a node with no relationships still returns it', async () => {
    const bookId = await seedBook('empty', 0);
    const res = (await ogm.model('ItCardBook').update({
      where: { id: bookId },
      update: { title: 'still-here' },
      disconnect: { chapters: [{}] },
      select: { [plural]: { id: true, title: true } },
    })) as Row;
    expect(res[plural]).toEqual([{ id: bookId, title: 'still-here' }]);
  });
});
