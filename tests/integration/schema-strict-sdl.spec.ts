/**
 * Live `@fulltext(indexes: [{ indexName }])` and strict root types (v2.17.0,
 * scan-5 S5t-5 / S5t-14).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed in `afterAll`; the `It`-prefixed fulltext
 * index is dropped there too.
 *
 * Pre-v2.17.0 `indexName` (the `@neo4j/graphql` 4+ spelling) was ignored:
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

  type Query {
    books: [ItSsdlBook!]!
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

  it('strict: a type Query in the SDL is skipped and the nodes still work', async () => {
    const ogm = new OGM({ typeDefs, driver, strict: true });
    expect(() => ogm.model('Query')).toThrow();
    const books = ogm.model('ItSsdlBook');
    await books.create({ input: [{ title: `${word} two`, runId }] });
    const rows = await books.find({
      where: { runId, title: `${word} two` },
      selectionSet: '{ title }',
    });
    expect(rows).toEqual([{ title: `${word} two` }]);
  });

  // v2.21.0 — strict item 40: an index with no fields (or no name) never
  // worked: no index is created and a search naming it throws.
  const incompleteDefs = /* GraphQL */ `
    type ItSsdlNote @node @fulltext(indexes: [{ name: "ItSsdlNoFields" }]) {
      id: ID! @id
      body: String
      runId: String
    }
  `;

  it('default: an index without fields is not created, a search on it throws, one warning', async () => {
    const warn = jest.fn();
    const ogm = new OGM({
      typeDefs: incompleteDefs,
      driver,
      logger: { debug: () => {}, warn },
    });
    expect(
      warn.mock.calls.filter((c) =>
        String(c[0]).includes('index "ItSsdlNoFields" has no fields'),
      ),
    ).toHaveLength(1);
    await ogm.assertIndexesAndConstraints({ options: { create: true } });
    const indexes = await run(
      'SHOW FULLTEXT INDEXES YIELD name WHERE name = $name RETURN name',
      { name: 'ItSsdlNoFields' },
    );
    expect(indexes).toEqual([]);
    await expect(
      ogm.model('ItSsdlNote').find({
        fulltext: { ItSsdlNoFields: { phrase: 'x' } } as never,
        selectionSet: '{ id }',
      }),
    ).rejects.toThrow('Unknown fulltext index "ItSsdlNoFields"');
  });

  it('strict: an index without fields throws when the OGM is built', () => {
    expect(
      () => new OGM({ typeDefs: incompleteDefs, driver, strict: true }),
    ).toThrow('@fulltext on ItSsdlNote: index "ItSsdlNoFields" has no fields.');
  });
});
