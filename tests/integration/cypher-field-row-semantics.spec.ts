/**
 * Live `@cypher` row-semantics suite (issue #9, v2.4.0).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Every node it
 * creates carries this run's `runId` and is removed in `afterAll`.
 *
 * A top-level `@cypher` field (SELECT, WHERE and sort preludes alike) was
 * a plain `CALL { <statement> }`: a node whose statement returned no rows
 * VANISHED from the result, and one whose statement returned several rows
 * was DUPLICATED. Each prelude now reduces its column with
 * `head(collect(...))`, so every node is kept exactly once — `null` when
 * the statement returns nothing.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItCfStatus @node {
    id: ID! @unique
    runId: String
    name: String
  }
  type ItCfBook @node {
    id: ID! @unique
    runId: String
    title: String
    status: String
      @cypher(
        statement: "MATCH (this)-[:IT_CF_STATUS]->(s) RETURN s.name AS status ORDER BY s.name"
        columnName: "status"
      )
  }
`;

type Row = Record<string, unknown>;

describeLive('@cypher field row semantics — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const id = (suffix: string) => `${runId}-${suffix}`;
  let driver: Driver;
  let ogm: OGM;
  let plural: string;

  async function run(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    const session = driver.session();
    try {
      await session.run(cypher, { runId, ...params });
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
    // none: no status (0 rows) · one: 1 status · two: 2 statuses (2 rows)
    await run(
      `CREATE (:ItCfBook {id: $none, runId: $runId})
       CREATE (one:ItCfBook {id: $one, runId: $runId})-[:IT_CF_STATUS]->(:ItCfStatus {id: $s1, runId: $runId, name: 'active'})
       CREATE (two:ItCfBook {id: $two, runId: $runId})
       CREATE (two)-[:IT_CF_STATUS]->(:ItCfStatus {id: $s2, runId: $runId, name: 'b-second'})
       CREATE (two)-[:IT_CF_STATUS]->(:ItCfStatus {id: $s3, runId: $runId, name: 'a-first'})`,
      {
        none: id('none'),
        one: id('one'),
        two: id('two'),
        s1: id('s1'),
        s2: id('s2'),
        s3: id('s3'),
      },
    );
    ogm = new OGM({ typeDefs, driver });
    plural = (
      ogm.model('ItCfBook') as unknown as { nodeDef: { pluralName: string } }
    ).nodeDef.pluralName;
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await driver.close();
    }
  });

  const Book = () => ogm.model('ItCfBook');

  it('SELECT keeps every node once: null for no rows, first row for many', async () => {
    const rows = await Book().find({
      where: { runId } as never,
      selectionSet: '{ id status }',
      options: { sort: [{ id: 'ASC' }] },
    } as never);
    expect(rows).toEqual(
      [
        { id: id('none'), status: null },
        { id: id('one'), status: 'active' },
        // the statement's own ORDER BY decides which row is "first"
        { id: id('two'), status: 'a-first' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it('WHERE { status: null } matches the node with no status', async () => {
    const rows = await Book().find({
      where: { runId, status: null } as never,
      selectionSet: '{ id }',
    });
    expect(ids(rows)).toEqual([id('none')]);
  });

  it('WHERE status_NOT returns each non-matching node once', async () => {
    const rows = await Book().find({
      where: { runId, status_NOT: 'active' } as never,
      selectionSet: '{ id }',
      options: { sort: [{ id: 'ASC' }] },
    } as never);
    // `null <> 'active'` is null, so `none` is (correctly) excluded.
    expect(ids(rows)).toEqual([id('two')]);
  });

  it('sort by a @cypher field keeps every node once', async () => {
    const rows = await Book().find({
      where: { runId } as never,
      selectionSet: '{ id }',
      options: { sort: [{ status: 'ASC' }] },
    } as never);
    // 'a-first' < 'active' ('-' sorts before 'c'); ASC puts nulls last.
    expect(ids(rows)).toEqual([id('two'), id('one'), id('none')]);
  });

  it('count with a @cypher where agrees with find', async () => {
    expect(
      await Book().count({ where: { runId, status: null } as never } as never),
    ).toBe(1);
    expect(await Book().count({ where: { runId } as never } as never)).toBe(3);
  });

  it('update projecting a @cypher field returns the node even with no rows', async () => {
    const res = (await Book().update({
      where: { id: id('none') },
      update: { title: 'still-returned' },
      select: { [plural]: { id: true, title: true, status: true } },
    } as never)) as Row;
    expect(res[plural]).toEqual([
      { id: id('none'), title: 'still-returned', status: null },
    ]);
  });

  it('a mutation over a duplicated node returns it once', async () => {
    const res = (await Book().update({
      where: { id: id('two') },
      update: { title: 'once' },
      select: { [plural]: { id: true, status: true } },
    } as never)) as Row;
    expect(res[plural]).toEqual([{ id: id('two'), status: 'a-first' }]);
  });
});
