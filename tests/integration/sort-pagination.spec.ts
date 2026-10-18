/**
 * Live sort / pagination suite (v2.4.3).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Every node it
 * creates carries this run's `runId` and is removed in `afterAll`; the
 * `It`-prefixed fulltext index is dropped there too.
 *
 * ORDER BY / SKIP / LIMIT trailed `RETURN n { ... }`. After that RETURN the
 * column `n` is the projected MAP, so sorting on a field the selection
 * didn't include read a missing key: every row sorted as null, so the
 * sort — and every page built on it — was silently ignored.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(120_000);

const typeDefs = /* GraphQL */ `
  interface ItSortThing {
    id: ID!
    rank: Int
  }
  type ItSortPerson implements ItSortThing
    @node(labels: ["ItSortThing", "ItSortPerson"])
    @fulltext(indexes: [{ name: "ItSortBioSearch", fields: ["bio"] }]) {
    id: ID! @unique
    runId: String
    rank: Int
    bio: String
    lowerId: String
      @cypher(
        statement: "RETURN toLower(this.id) AS lowerId"
        columnName: "lowerId"
      )
  }
`;

type Row = Record<string, unknown>;

describeLive('Sort and pagination — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const word = `kw${runId.replace(/-/g, '')}`;
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

  const ids = (rows: unknown) => (rows as Row[]).map((r) => r.id as string);

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
    await run(
      'CREATE FULLTEXT INDEX ItSortBioSearch IF NOT EXISTS FOR (n:ItSortPerson) ON EACH [n.bio]',
    );
    // ids sort a<b<c<d; ranks deliberately disagree with that order.
    await run(
      `UNWIND [['a', 30], ['b', 50], ['c', 10], ['d', 40]] AS row
       CREATE (:ItSortThing:ItSortPerson {id: $runId + '-' + row[0], runId: $runId, rank: row[1], bio: $word})`,
      { word },
    );
    await run('CALL db.awaitIndexes(60)');
    for (let i = 0; i < 50; i++) {
      const [r] = await run(
        `CALL db.index.fulltext.queryNodes('ItSortBioSearch', $word) YIELD node RETURN count(node) AS c`,
        { word },
      );
      if (Number(r.c) >= 4) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    ogm = new OGM({ typeDefs, driver });
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await run('DROP INDEX ItSortBioSearch IF EXISTS');
      await driver.close();
    }
  });

  const P = () => ogm.model('ItSortPerson');
  const mine = () => ({ runId }) as never;
  const BY_RANK_DESC = [id('b'), id('d'), id('a'), id('c')];

  it('sorts by a field that is not in the selection', async () => {
    const rows = await P().find({
      where: mine(),
      selectionSet: '{ id }',
      options: { sort: [{ rank: 'DESC' }] },
    } as never);
    expect(ids(rows)).toEqual(BY_RANK_DESC);
  });

  it('pages (offset + limit) in sort order', async () => {
    const rows = await P().find({
      where: mine(),
      selectionSet: '{ id }',
      options: { sort: [{ rank: 'DESC' }], offset: 1, limit: 2 },
    } as never);
    expect(ids(rows)).toEqual(BY_RANK_DESC.slice(1, 3));
  });

  it('findFirst returns the top row by an unselected field', async () => {
    const top = await P().findFirst({
      where: mine(),
      selectionSet: '{ id }',
      options: { sort: [{ rank: 'ASC' }] },
    } as never);
    expect((top as Row).id).toBe(id('c'));
  });

  it('sorts by a selected field (unchanged)', async () => {
    const rows = await P().find({
      where: mine(),
      selectionSet: '{ id rank }',
      options: { sort: [{ rank: 'DESC' }] },
    } as never);
    expect(ids(rows)).toEqual(BY_RANK_DESC);
  });

  it('sorts by a @cypher field and selects another @cypher field', async () => {
    const rows = await P().find({
      where: mine(),
      selectionSet: '{ id lowerId }',
      options: { sort: [{ lowerId: 'DESC' }], limit: 2 },
    } as never);
    expect(ids(rows)).toEqual([id('d'), id('c')]);
  });

  it('InterfaceModel sorts by an unselected field', async () => {
    const rows = await ogm.interfaceModel('ItSortThing').find({
      where: { id_STARTS_WITH: runId } as never,
      selectionSet: '{ id }',
      options: { sort: [{ rank: 'DESC' }], limit: 3 },
    } as never);
    expect(ids(rows)).toEqual(BY_RANK_DESC.slice(0, 3));
  });

  it('fulltext find sorts by an unselected field', async () => {
    const rows = await P().find({
      fulltext: { ItSortBioSearch: { phrase: word } } as never,
      selectionSet: '{ id }',
      options: { sort: [{ rank: 'ASC' }] },
    } as never);
    expect(ids(rows)).toEqual([...BY_RANK_DESC].reverse());
  });
});
