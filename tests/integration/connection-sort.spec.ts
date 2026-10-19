/**
 * Live connection `sort` in a selectionSet (v2.7.0, #25).
 *
 * Opt-in: runs only when NEO4J_APOC_URI is set, because connection sorting
 * compiles to `apoc.coll.sortMulti` (as the typed `select` `orderBy` and
 * relationship `options.sort` do) and the default live container
 * (NEO4J_URI) has no APOC. CI's live job sets NEO4J_APOC_URI. Credentials
 * come from NEO4J_APOC_USER and NEO4J_APOC_PASSWORD. Every node it creates
 * carries this run's `runId` and is removed in `afterAll`.
 *
 * Pre-2.5.0 `chaptersConnection(sort: …)` compiled with the sort dropped;
 * 2.5.0–2.6.x threw. Each case checks the real order, and that the
 * selectionSet form returns exactly what the typed `orderBy` returns.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_APOC_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type CsBook @node {
    id: ID! @unique
    runId: String
    title: String
    chapters: [CsChapter!]!
      @relationship(
        type: "CS_HAS_CHAPTER"
        properties: "CsHasChapter"
        direction: OUT
      )
  }
  type CsChapter @node {
    id: ID! @unique
    runId: String
    title: String
    sections: [CsSection!]!
      @relationship(
        type: "CS_HAS_SECTION"
        properties: "CsHasSection"
        direction: OUT
      )
  }
  type CsSection @node {
    id: ID! @unique
    runId: String
    title: String
  }
  type CsHasChapter @relationshipProperties {
    position: Int
  }
  type CsHasSection @relationshipProperties {
    order: Int
  }
`;

type Row = Record<string, unknown>;
type Edge = { node: Row; properties?: Row };

describeLive('selectionSet connection sort — live Neo4j with APOC', () => {
  let driver: Driver;
  let ogm: OGM;
  const runId = `cs-${randomUUID()}`;
  const id = (suffix: string) => `${runId}-${suffix}`;

  async function run(cypher: string, params: Row = {}): Promise<Row[]> {
    const session = driver.session();
    try {
      const res = await session.run(cypher, { ...params, runId });
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  /**
   * Book b1 with six chapters (title, position):
   * c1 (b, 2), c2 (a, 1), c3 (c, 2), c4 (a, null), c5 (d, 3), c6 (null, 5).
   * Chapter c2 has three sections (order 3, 1, 2).
   */
  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_APOC_USER ?? 'neo4j',
        process.env.NEO4J_APOC_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    await driver.verifyConnectivity();
    ogm = new OGM({ typeDefs, driver });
    await run(
      `CREATE (b:CsBook {id: $b1, runId: $runId, title: 'B'})
       CREATE (b)-[:CS_HAS_CHAPTER {position: 2}]->(:CsChapter {id: $c1, runId: $runId, title: 'b'})
       CREATE (b)-[:CS_HAS_CHAPTER {position: 1}]->(c2:CsChapter {id: $c2, runId: $runId, title: 'a'})
       CREATE (b)-[:CS_HAS_CHAPTER {position: 2}]->(:CsChapter {id: $c3, runId: $runId, title: 'c'})
       CREATE (b)-[:CS_HAS_CHAPTER]->(:CsChapter {id: $c4, runId: $runId, title: 'a'})
       CREATE (b)-[:CS_HAS_CHAPTER {position: 3}]->(:CsChapter {id: $c5, runId: $runId, title: 'd'})
       CREATE (b)-[:CS_HAS_CHAPTER {position: 5}]->(:CsChapter {id: $c6, runId: $runId})
       CREATE (c2)-[:CS_HAS_SECTION {order: 3}]->(:CsSection {id: $s3, runId: $runId, title: 's3'})
       CREATE (c2)-[:CS_HAS_SECTION {order: 1}]->(:CsSection {id: $s1, runId: $runId, title: 's1'})
       CREATE (c2)-[:CS_HAS_SECTION {order: 2}]->(:CsSection {id: $s2, runId: $runId, title: 's2'})`,
      {
        b1: id('b1'),
        ...Object.fromEntries(
          ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 's1', 's2', 's3'].map((k) => [
            k,
            id(k),
          ]),
        ),
      },
    );
  });

  afterAll(async () => {
    if (!driver) return;
    await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
    await driver.close();
  });

  const Book = () => ogm.model('CsBook');
  const where = () => ({ id: id('b1') }) as never;

  async function bySelectionSet(selectionSet: string): Promise<Row> {
    const [book] = (await Book().find({
      where: where(),
      selectionSet,
    })) as Row[];
    return book;
  }
  async function byTyped(select: Row): Promise<Row> {
    const [book] = (await Book().find({
      where: where(),
      select,
    } as never)) as Row[];
    return book;
  }

  const edgesOf = (book: Row, key = 'chaptersConnection'): Edge[] =>
    (book[key] as { edges: Edge[] }).edges;
  /** Chapter ids, without the runId prefix. */
  const ids = (edges: Edge[]) =>
    edges.map((e) => String(e.node.id).slice(runId.length + 1));

  /** The selectionSet sort returns the typed orderBy's result, unchanged. */
  async function expectSameAsTyped(
    sort: string,
    orderBy: Row[],
  ): Promise<Edge[]> {
    const fromString = await bySelectionSet(
      `{ chaptersConnection(sort: ${sort}) { edges { properties { position } node { id title } } } }`,
    );
    const typed = await byTyped({
      chaptersConnection: {
        orderBy,
        select: {
          edges: {
            properties: { select: { position: true } },
            node: { select: { id: true, title: true } },
          },
        },
      },
    });
    expect(fromString).toEqual(typed);
    return edgesOf(fromString);
  }

  /** The edges with a non-null `pick`, in order; nulls sit at one end. */
  function nonNull(edges: Edge[], pick: (e: Edge) => unknown): Edge[] {
    const isNull = edges.map((e) => pick(e) == null);
    const firstNonNull = isNull.indexOf(false);
    const lastNonNull = isNull.lastIndexOf(false);
    // Every null is before the first or after the last non-null value.
    isNull.forEach((n, i) => {
      if (n) expect(i < firstNonNull || i > lastNonNull).toBe(true);
    });
    return edges.filter((e) => pick(e) != null);
  }

  it('edge sort ASC (ties keep both, nulls at one end)', async () => {
    const edges = await expectSameAsTyped('[{ edge: { position: ASC } }]', [
      { edge: { position: 'ASC' } },
    ]);
    expect(edges).toHaveLength(6);
    const sorted = nonNull(edges, (e) => e.properties?.position);
    expect(sorted.map((e) => e.properties!.position)).toEqual([1, 2, 2, 3, 5]);
    expect(ids(sorted)[0]).toBe('c2');
    expect(ids(sorted).slice(1, 3).sort()).toEqual(['c1', 'c3']);
  });

  it('edge sort DESC', async () => {
    const edges = await expectSameAsTyped('[{ edge: { position: DESC } }]', [
      { edge: { position: 'DESC' } },
    ]);
    const sorted = nonNull(edges, (e) => e.properties?.position);
    expect(sorted.map((e) => e.properties!.position)).toEqual([5, 3, 2, 2, 1]);
  });

  it('node sort ASC and DESC', async () => {
    const asc = await expectSameAsTyped('[{ node: { title: ASC } }]', [
      { node: { title: 'ASC' } },
    ]);
    expect(nonNull(asc, (e) => e.node.title).map((e) => e.node.title)).toEqual([
      'a',
      'a',
      'b',
      'c',
      'd',
    ]);
    const desc = await expectSameAsTyped('[{ node: { title: DESC } }]', [
      { node: { title: 'DESC' } },
    ]);
    expect(nonNull(desc, (e) => e.node.title).map((e) => e.node.title)).toEqual(
      ['d', 'c', 'b', 'a', 'a'],
    );
  });

  it('a second entry breaks the ties of the first', async () => {
    const edges = await expectSameAsTyped(
      '[{ edge: { position: ASC } }, { node: { title: DESC } }]',
      [{ edge: { position: 'ASC' } }, { node: { title: 'DESC' } }],
    );
    expect(ids(nonNull(edges, (e) => e.properties?.position))).toEqual([
      'c2',
      'c3',
      'c1',
      'c5',
      'c6',
    ]);
    const flipped = await expectSameAsTyped(
      '[{ node: { title: ASC } }, { edge: { position: DESC } }]',
      [{ node: { title: 'ASC' } }, { edge: { position: 'DESC' } }],
    );
    // The two 'a' chapters: c2 (position 1) and c4 (null position).
    expect(ids(nonNull(flipped, (e) => e.node.title)).slice(2)).toEqual([
      'c1',
      'c3',
      'c5',
    ]);
  });

  it('with where and totalCount: the filtered edges sorted, the count unchanged', async () => {
    const book = await bySelectionSet(
      '{ chaptersConnection(where: { edge: { position_GTE: 2 } }, sort: [{ node: { title: DESC } }]) { totalCount edges { node { id } } } }',
    );
    const conn = book.chaptersConnection as {
      totalCount: number;
      edges: Edge[];
    };
    expect(conn.totalCount).toBe(4);
    const order = ids(conn.edges);
    expect(order.filter((c) => c !== 'c6')).toEqual(['c5', 'c3', 'c1']);
    expect([0, 3]).toContain(order.indexOf('c6'));
  });

  it('nested at depth 2', async () => {
    const book = await bySelectionSet(
      `{ chaptersConnection(where: { node: { id: "${id('c2')}" } }) { edges { node { id sectionsConnection(sort: [{ edge: { order: DESC } }]) { edges { properties { order } node { title } } } } } } }`,
    );
    const [chapter] = edgesOf(book);
    const sections = (chapter.node.sectionsConnection as { edges: Edge[] })
      .edges;
    expect(sections.map((e) => e.node.title)).toEqual(['s3', 's2', 's1']);
  });

  it('in a mutation response selectionSet', async () => {
    const res = (await Book().update({
      where: where(),
      update: { title: 'B2' },
      selectionSet:
        '{ csBooks { title chaptersConnection(sort: [{ edge: { position: DESC } }]) { edges { properties { position } } } } }',
    } as never)) as unknown as { csBooks: Row[] };
    const [book] = res.csBooks;
    expect(book.title).toBe('B2');
    const positions = nonNull(edgesOf(book), (e) => e.properties?.position).map(
      (e) => e.properties!.position,
    );
    expect(positions).toEqual([5, 3, 2, 2, 1]);
  });

  it('through the selectionSet setter, and in strict mode', async () => {
    const strict = new OGM({ typeDefs, driver, strict: true });
    for (const model of [ogm.model('CsBook'), strict.model('CsBook')]) {
      model.selectionSet =
        '{ id chaptersConnection(sort: [{ edge: { position: ASC } }, { node: { title: ASC } }]) { edges { node { id } } } }';
      const [book] = (await model.find({ where: where() })) as Row[];
      expect(ids(edgesOf(book)).filter((c) => c !== 'c4')).toEqual([
        'c2',
        'c1',
        'c3',
        'c5',
        'c6',
      ]);
    }
  });
});
