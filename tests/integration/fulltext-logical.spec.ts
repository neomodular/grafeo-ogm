/**
 * Live fulltext logical-operator suite (issue #11, v2.3.4).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Every node it
 * creates carries this run's `runId` and is removed in `afterAll`; the
 * fulltext indexes it creates are `It`-prefixed and dropped there too.
 *
 * Fulltext `AND` compiled each later branch into the outer scope, so every
 * branch shape collided with or dropped the outer `n` / `score` — a leaf
 * failed with "Variable `score` already declared in outer scope", an OR /
 * NOT / relationship-index branch lost `n`. These tests execute each shape.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(120_000);

const typeDefs = /* GraphQL */ `
  type ItFtTagged
    @relationshipProperties
    @fulltext(indexes: [{ name: "ItFtNoteSearch", fields: ["note"] }]) {
    note: String
  }
  type ItFtTag @node {
    id: ID! @unique
    runId: String
  }
  type ItFtDoc
    @node
    @fulltext(
      indexes: [
        { name: "ItFtTitleSearch", fields: ["title"] }
        { name: "ItFtBodySearch", fields: ["body"] }
      ]
    ) {
    id: ID! @unique
    runId: String
    title: String
    body: String
    tags: [ItFtTag!]!
      @relationship(
        type: "IT_FT_TAGGED"
        direction: OUT
        properties: "ItFtTagged"
      )
  }
`;

const INDEXES = [
  'CREATE FULLTEXT INDEX ItFtTitleSearch IF NOT EXISTS FOR (n:ItFtDoc) ON EACH [n.title]',
  'CREATE FULLTEXT INDEX ItFtBodySearch IF NOT EXISTS FOR (n:ItFtDoc) ON EACH [n.body]',
  'CREATE FULLTEXT INDEX ItFtNoteSearch IF NOT EXISTS FOR ()-[r:IT_FT_TAGGED]-() ON EACH [r.note]',
];

type Row = Record<string, unknown>;

describeLive('Fulltext logical operators — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  // Phrases are unique to this run so documents from other runs or
  // other suites can't match.
  const word = (w: string) => `${w}${runId.replace(/-/g, '')}`;
  const id = (suffix: string) => `${runId}-${suffix}`;
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

  const ids = (rows: unknown) =>
    (rows as Row[]).map((r) => r.id as string).sort();

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
    for (const stmt of INDEXES) await run(stmt);

    // d-both: title=alpha body=beta     → matches alpha AND beta
    // d-title: title=alpha body=gamma   → alpha only
    // d-body:  title=delta body=beta    → beta only
    // d-tagged: title=alpha, tagged twice with note=epsilon
    await run(
      `CREATE (:ItFtDoc {id: $both, runId: $runId, title: $alpha, body: $beta})
       CREATE (:ItFtDoc {id: $title, runId: $runId, title: $alpha, body: $gamma})
       CREATE (:ItFtDoc {id: $body, runId: $runId, title: $delta, body: $beta})
       CREATE (t:ItFtDoc {id: $tagged, runId: $runId, title: $alpha, body: $delta})
       CREATE (t)-[:IT_FT_TAGGED {note: $epsilon}]->(:ItFtTag {id: $tag1, runId: $runId})
       CREATE (t)-[:IT_FT_TAGGED {note: $epsilon}]->(:ItFtTag {id: $tag2, runId: $runId})`,
      {
        both: id('both'),
        title: id('title'),
        body: id('body'),
        tagged: id('tagged'),
        tag1: id('tag1'),
        tag2: id('tag2'),
        alpha: word('alpha'),
        beta: word('beta'),
        gamma: word('gamma'),
        delta: word('delta'),
        epsilon: word('epsilon'),
      },
    );
    await run('CALL db.awaitIndexes(60)');
    // Fulltext indexes are eventually consistent: wait until the seed is
    // searchable before asserting.
    for (let i = 0; i < 50; i++) {
      const rows = await run(
        `CALL db.index.fulltext.queryNodes('ItFtTitleSearch', $q) YIELD node RETURN count(node) AS c`,
        { q: word('alpha') },
      );
      if (Number(rows[0].c) >= 3) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    ogm = new OGM({ typeDefs, driver });
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      for (const name of [
        'ItFtTitleSearch',
        'ItFtBodySearch',
        'ItFtNoteSearch',
      ])
        await run(`DROP INDEX ${name} IF EXISTS`);
      await driver.close();
    }
  });

  const find = (fulltext: unknown) =>
    ogm
      .model('ItFtDoc')
      .find({ fulltext: fulltext as never, selectionSet: '{ id }' });

  it('AND of two leaves returns only nodes matching both', async () => {
    const rows = await find({
      AND: [
        { ItFtTitleSearch: { phrase: word('alpha') } },
        { ItFtBodySearch: { phrase: word('beta') } },
      ],
    });
    expect(ids(rows)).toEqual([id('both')]);
  });

  it('AND of three leaves (two filtering branches)', async () => {
    const rows = await find({
      AND: [
        { ItFtTitleSearch: { phrase: word('alpha') } },
        { ItFtBodySearch: { phrase: word('beta') } },
        { ItFtTitleSearch: { phrase: word('alpha') } },
      ],
    });
    expect(ids(rows)).toEqual([id('both')]);
  });

  it('AND with an OR branch', async () => {
    const rows = await find({
      AND: [
        { ItFtTitleSearch: { phrase: word('alpha') } },
        {
          OR: [
            { ItFtBodySearch: { phrase: word('beta') } },
            { ItFtBodySearch: { phrase: word('gamma') } },
          ],
        },
      ],
    });
    expect(ids(rows)).toEqual([id('both'), id('title')].sort());
  });

  it('AND with a NOT branch', async () => {
    const rows = await find({
      AND: [
        { ItFtTitleSearch: { phrase: word('alpha') } },
        { NOT: { ItFtBodySearch: { phrase: word('beta') } } },
      ],
    });
    expect(ids(rows)).toEqual([id('tagged'), id('title')].sort());
  });

  it('AND with a relationship-index branch matching twice returns the node once', async () => {
    const rows = await find({
      AND: [
        { ItFtTitleSearch: { phrase: word('alpha') } },
        { tags: { ItFtNoteSearch: { phrase: word('epsilon') } } },
      ],
    });
    expect(ids(rows)).toEqual([id('tagged')]);
  });

  it('nested AND inside AND', async () => {
    const rows = await find({
      AND: [
        { ItFtTitleSearch: { phrase: word('alpha') } },
        {
          AND: [
            { ItFtBodySearch: { phrase: word('beta') } },
            { ItFtTitleSearch: { phrase: word('alpha') } },
          ],
        },
      ],
    });
    expect(ids(rows)).toEqual([id('both')]);
  });

  it('AND whose first branch is an OR', async () => {
    const rows = await find({
      AND: [
        {
          OR: [
            { ItFtTitleSearch: { phrase: word('alpha') } },
            { ItFtTitleSearch: { phrase: word('delta') } },
          ],
        },
        { ItFtBodySearch: { phrase: word('beta') } },
      ],
    });
    expect(ids(rows)).toEqual([id('body'), id('both')].sort());
  });

  it('OR and NOT on their own still work (regression guard)', async () => {
    const or = await find({
      OR: [
        { ItFtBodySearch: { phrase: word('gamma') } },
        { ItFtTitleSearch: { phrase: word('delta') } },
      ],
    });
    expect(ids(or)).toEqual([id('body'), id('title')].sort());
    const not = await ogm.model('ItFtDoc').find({
      where: { runId },
      fulltext: {
        NOT: { ItFtTitleSearch: { phrase: word('alpha') } },
      } as never,
      selectionSet: '{ id }',
    });
    expect(ids(not)).toEqual([id('body')]);
  });
});
