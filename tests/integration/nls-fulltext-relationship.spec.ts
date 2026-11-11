/**
 * Live: a relationship fulltext search checks the relationship's FAR
 * endpoint — its label and its type's `read` policy (v2.28.1 — security).
 *
 * Pre-2.28.1 `queryRelationships` was reduced to the root endpoint
 * straight away, so only the root was label- and policy-checked: edge text
 * on a relationship to a hidden node was searchable (a tag whose only
 * matching edge pointed to a secret chart came back, while
 * `chartsConnection` hid that edge), and a relationship of the same type
 * to a node of another label matched too.
 *
 * Opt-in on NEO4J_URI. Every node carries this run's `runId` and is
 * removed in `afterAll`, with the suite's fulltext index.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(120_000);

type Row = Record<string, unknown>;

const typeDefs = /* GraphQL */ `
  type ItFrTagged
    @relationshipProperties
    @fulltext(indexes: [{ indexName: "ItFrTaggedFt", fields: ["note"] }]) {
    note: String
  }
  type ItFrTag @node {
    id: ID! @unique
    runId: String
    hidden: Boolean
    charts: [ItFrChart!]!
      @relationship(
        type: "IT_FR_TAGS"
        direction: OUT
        properties: "ItFrTagged"
      )
    items: [ItFrContent!]!
      @relationship(type: "IT_FR_HAS", direction: OUT, properties: "ItFrTagged")
  }
  interface ItFrContent {
    id: ID!
  }
  type ItFrChart implements ItFrContent @node {
    id: ID! @unique
    runId: String
    secret: Boolean
    taggedBy: [ItFrTag!]!
      @relationship(type: "IT_FR_TAGS", direction: IN, properties: "ItFrTagged")
  }
  type ItFrNote implements ItFrContent @node {
    id: ID! @unique
    runId: String
  }
`;

const policies = {
  ItFrChart: [
    permissive({ operations: ['read'], when: () => ({ secret: false }) }),
  ],
  ItFrTag: [
    permissive({ operations: ['read'], when: () => ({ hidden: false }) }),
  ],
};

describeLive('live: relationship fulltext checks the far endpoint', () => {
  let driver: Driver;
  const runId = randomUUID();
  const word = `kw${runId.replace(/-/g, '')}`;
  const charts = { charts: { ItFrTaggedFt: { phrase: word } } };
  const items = { items: { ItFrTaggedFt: { phrase: word } } };
  const taggedBy = { taggedBy: { ItFrTaggedFt: { phrase: word } } };

  const ids = (rows: Row[]) => rows.map((r) => r.id as string).sort();
  const run = async (cypher: string, params: Record<string, unknown> = {}) => {
    const session = driver.session();
    try {
      return (await session.run(cypher, params)).records;
    } finally {
      await session.close();
    }
  };

  beforeAll(async () => {
    driver = neo4j.driver(
      URI as string,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
    );
    await run(
      'CREATE FULLTEXT INDEX ItFrTaggedFt IF NOT EXISTS FOR ()-[r:IT_FR_TAGS|IT_FR_HAS]-() ON EACH [r.note]',
    );
    // t-secret: its only matching edges reach a secret chart.
    // t-other: its matching IT_FR_TAGS edge reaches a node of another label.
    // t-hidden: hidden itself; its edge reaches c-public2.
    await run(
      `CREATE (cs:ItFrChart {id: 'c-secret', runId: $runId, secret: true})
       CREATE (cp:ItFrChart {id: 'c-public', runId: $runId, secret: false})
       CREATE (cp2:ItFrChart {id: 'c-public2', runId: $runId, secret: false})
       CREATE (note:ItFrNote {id: 'n-1', runId: $runId})
       CREATE (ts:ItFrTag {id: 't-secret', runId: $runId, hidden: false})
       CREATE (tp:ItFrTag {id: 't-public', runId: $runId, hidden: false})
       CREATE (to:ItFrTag {id: 't-other', runId: $runId, hidden: false})
       CREATE (tn:ItFrTag {id: 't-note', runId: $runId, hidden: false})
       CREATE (th:ItFrTag {id: 't-hidden', runId: $runId, hidden: true})
       CREATE (ts)-[:IT_FR_TAGS {note: $word}]->(cs)
       CREATE (ts)-[:IT_FR_HAS {note: $word}]->(cs)
       CREATE (tp)-[:IT_FR_TAGS {note: $word}]->(cp)
       CREATE (to)-[:IT_FR_TAGS {note: $word}]->(:ItFrOther {runId: $runId})
       CREATE (tn)-[:IT_FR_HAS {note: $word}]->(note)
       CREATE (th)-[:IT_FR_TAGS {note: $word}]->(cp2)`,
      { runId, word },
    );
    await run('CALL db.awaitIndexes(60)');
    for (let i = 0; i < 50; i++) {
      const [r] = await run(
        `CALL db.index.fulltext.queryRelationships('ItFrTaggedFt', $word) YIELD relationship RETURN count(relationship) AS c`,
        { word },
      );
      if (Number(r.get('c')) >= 6) break;
      await new Promise((res) => setTimeout(res, 200));
    }
  });

  afterAll(async () => {
    await run('MATCH (n {runId: $runId}) DETACH DELETE n', { runId });
    await run('DROP INDEX ItFrTaggedFt IF EXISTS');
    await driver.close();
  });

  it.each([false, true])(
    'a hidden far endpoint does not match (strict: %s)',
    async (strict) => {
      const ogm = new OGM({ typeDefs, driver, policies, strict });
      const Tag = ogm.withContext({}).model('ItFrTag');
      expect(ids(await Tag.find({ fulltext: charts }))).toEqual(['t-public']);
      expect(await Tag.count({ fulltext: charts })).toBe(1);
      // The same answer as the connection, which hid the edge already.
      const viaConnection = (await Tag.find({
        where: { runId },
        selectionSet: '{ id chartsConnection { totalCount } }',
      })) as Row[];
      expect(
        viaConnection
          .filter(
            (r) =>
              (r.chartsConnection as { totalCount: number }).totalCount > 0,
          )
          .map((r) => r.id),
      ).toEqual(['t-public']);
    },
  );

  it('an IN-direction relationship checks the far (start) endpoint', async () => {
    const ogm = new OGM({ typeDefs, driver, policies });
    const Chart = ogm.withContext({}).model('ItFrChart');
    expect(ids(await Chart.find({ fulltext: taggedBy }))).toEqual(['c-public']);
  });

  it.each([false, true])(
    'an interface target applies each member policy (strict: %s)',
    async (strict) => {
      const ogm = new OGM({ typeDefs, driver, policies, strict });
      const Tag = ogm.withContext({}).model('ItFrTag');
      expect(ids(await Tag.find({ fulltext: items }))).toEqual(['t-note']);
    },
  );

  it('OR / AND / NOT branches check the far endpoint', async () => {
    const ogm = new OGM({ typeDefs, driver, policies });
    const Tag = ogm.withContext({}).model('ItFrTag');
    expect(ids(await Tag.find({ fulltext: { OR: [charts, items] } }))).toEqual([
      't-note',
      't-public',
    ]);
    expect(
      ids(await Tag.find({ fulltext: { AND: [charts, charts] } })),
    ).toEqual(['t-public']);
    // A hidden chart's edge neither satisfies nor falsifies NOT.
    expect(
      ids(await Tag.find({ where: { runId }, fulltext: { NOT: charts } })),
    ).toEqual(['t-note', 't-other', 't-secret']);
  });

  it('without policies, the far endpoint must carry the target label', async () => {
    const ogm = new OGM({ typeDefs, driver });
    const Tag = ogm.model('ItFrTag');
    expect(ids(await Tag.find({ fulltext: charts }))).toEqual([
      't-hidden',
      't-public',
      't-secret',
    ]);
    expect(await Tag.count({ fulltext: charts })).toBe(3);
  });
});
