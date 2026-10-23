/**
 * Live `@fulltext(indexes: [{ indexName }])` (vNEXT, scan-5 S5t-5).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed in `afterAll`; the `It`-prefixed fulltext
 * index is dropped there too.
 *
 * Pre-vNEXT `indexName` (the `@neo4j/graphql` 4+ spelling) was ignored:
 * `assertIndexesAndConstraints({ create: true })` made no index and a
 * fulltext search on it threw "Unknown fulltext index".
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const INDEX = 'ItSsdlTitleSearch';

const typeDefs = /* GraphQL */ `
  type ItSsdlBook
    @node
    @fulltext(
      indexes: [
        { indexName: "${INDEX}", queryName: "booksByTitle", fields: ["title"] }
      ]
    ) {
    id: ID! @id
    title: String!
    runId: String
  }
`;

describeLive('schema strict SDL — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const word = `ssdl${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let driver: Driver;

  const run = async (cypher: string, params: Record<string, unknown> = {}) => {
    const session = driver.session();
    try {
      return (await session.run(cypher, params)).records.map((r) =>
        r.toObject(),
      );
    } finally {
      await session.close();
    }
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
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n', { runId });
      await run(`DROP INDEX ${INDEX} IF EXISTS`);
      await driver.close();
    }
  });

  it('creates and searches a fulltext index declared with indexName', async () => {
    const ogm = new OGM({ typeDefs, driver });
    await ogm.assertIndexesAndConstraints({ options: { create: true } });
    const indexes = await run(
      'SHOW FULLTEXT INDEXES YIELD name, labelsOrTypes, properties WHERE name = $name RETURN *',
      { name: INDEX },
    );
    expect(indexes).toEqual([
      { name: INDEX, labelsOrTypes: ['ItSsdlBook'], properties: ['title'] },
    ]);

    const books = ogm.model('ItSsdlBook');
    await books.create({ input: [{ title: `${word} one`, runId }] });
    await run('CALL db.awaitIndexes(60)');
    let found: unknown[] = [];
    for (let i = 0; i < 50 && found.length === 0; i++) {
      found = await books.find({
        fulltext: { [INDEX]: { phrase: word } } as never,
        selectionSet: '{ title }',
      });
      if (found.length === 0) await new Promise((r) => setTimeout(r, 200));
    }
    expect(found).toEqual([{ title: `${word} one` }]);
  });
});
