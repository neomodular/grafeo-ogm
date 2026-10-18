/**
 * Live searchByPhrase suite (issue #13, v2.3.6).
 *
 * Opt-in: runs only when NEO4J_GENAI_URI is set — a server WITH the GenAI
 * plugin (e.g. `neo4j:5.26` with `NEO4J_PLUGINS=["genai"]`). Credentials
 * come from NEO4J_USER / NEO4J_USERNAME and NEO4J_PASSWORD. Nodes carry
 * this run's `runId` and are removed in `afterAll`; the `It`-prefixed
 * vector index is dropped there too.
 *
 * No embedding provider is contacted: the provider config deliberately
 * omits the token, so the plugin rejects the call locally. WHICH error
 * comes back is the assertion — pre-2.3.6 the query called
 * `genai.vector.encode` as a procedure and Neo4j answered "There is no
 * procedure with the name `genai.vector.encode`"; now the function is
 * resolved and the plugin's own config check is what fails.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_GENAI_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItVecDoc
    @node
    @vector(
      indexes: [
        {
          indexName: "it_vec_doc_idx"
          queryName: "similarItVecDocs"
          embeddingProperty: "embedding"
          provider: "OpenAI"
        }
      ]
    ) {
    id: ID! @unique
    runId: String
    embedding: [Float!]
  }
`;

describeLive('searchByPhrase — live Neo4j with GenAI plugin', () => {
  const runId = `it-${randomUUID()}`;
  let driver: Driver;
  let ogm: OGM;

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
      `CREATE VECTOR INDEX it_vec_doc_idx IF NOT EXISTS
       FOR (n:ItVecDoc) ON n.embedding
       OPTIONS { indexConfig: { \`vector.dimensions\`: 3, \`vector.similarity_function\`: 'cosine' } }`,
    );
    await run(
      `CREATE (:ItVecDoc {id: $runId + '-a', runId: $runId, embedding: [1.0, 0.0, 0.0]})`,
    );
    await run('CALL db.awaitIndexes(60)');
    ogm = new OGM({ typeDefs, driver });
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await run('DROP INDEX it_vec_doc_idx IF EXISTS');
      await driver.close();
    }
  });

  it('resolves genai.vector.encode as a function', async () => {
    const attempt = ogm.model('ItVecDoc').searchByPhrase({
      indexName: 'it_vec_doc_idx',
      phrase: 'hello',
      k: 1,
      providerConfig: {}, // no token → the plugin fails locally, no network
      selectionSet: '{ id }',
    });
    await expect(attempt).rejects.toThrow(
      /'token' is expected to have been set/,
    );
    await expect(attempt).rejects.not.toThrow(/no procedure/i);
  });

  it('searchByVector on the same index still works (regression guard)', async () => {
    const hits = await ogm.model('ItVecDoc').searchByVector({
      indexName: 'it_vec_doc_idx',
      vector: [1, 0, 0],
      k: 1,
      where: { runId } as never,
      selectionSet: '{ id }',
    });
    expect(hits.map((h) => (h.node as { id: string }).id)).toEqual([
      `${runId}-a`,
    ]);
  });
});
