/**
 * Live strict-mode suite, read-side items (v2.6.0).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed in `afterAll`; the fulltext indexes it creates
 * are `It`-prefixed and dropped there too.
 *
 * For each item: the default OGM returns the v2.5.3 result and logs exactly
 * one warning (even when the shape is used twice); the `strict: true` OGM
 * returns the corrected result, or throws.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGMError } from '../../src/errors';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(120_000);

const typeDefs = /* GraphQL */ `
  type ItSmReviewed @relationshipProperties {
    note: String
  }
  type ItSmReview @node {
    id: ID! @unique
    runId: String
    body: String
    stars: Int
  }
  interface ItSmScored {
    runId: String
    scores: [Int!]
  }
  type ItSmDoc implements ItSmScored
    @node
    @fulltext(
      indexes: [
        { name: "ItSmTitleSearch", fields: ["title"] }
        { name: "ItSmBodySearch", fields: ["body"] }
      ]
    ) {
    id: ID! @unique
    runId: String
    title: String
    body: String
    pages: Int
    tags: [String!]
    scores: [Int!]
    ratings: [Float!]
    reviews: [ItSmReview!]!
      @relationship(
        type: "IT_SM_HAS_REVIEW"
        direction: OUT
        properties: "ItSmReviewed"
      )
  }
`;

const INDEXES = [
  'CREATE FULLTEXT INDEX ItSmTitleSearch IF NOT EXISTS FOR (n:ItSmDoc) ON EACH [n.title]',
  'CREATE FULLTEXT INDEX ItSmBodySearch IF NOT EXISTS FOR (n:ItSmDoc) ON EACH [n.body]',
];

type Row = Record<string, unknown>;

describeLive('strict mode (reads) — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const word = (w: string) => `${w}${runId.replace(/-/g, '')}`;
  const id = (suffix: string) => `${runId}-${suffix}`;
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

  /** A fresh OGM + test logger, so each test sees its own warnings. */
  function make(strict?: boolean) {
    const logger = { debug: jest.fn(), warn: jest.fn() };
    const ogm = new OGM({
      typeDefs,
      driver,
      logger,
      ...(strict === undefined ? {} : { strict }),
    });
    return { ogm, logger, doc: ogm.model('ItSmDoc') };
  }

  const ids = (rows: unknown) =>
    (rows as Row[]).map((r) => r.id as string).sort();

  /** Exactly one warning, and it names strict mode + 3.0. */
  function expectOneWarning(logger: { warn: jest.Mock }, text: string) {
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = String(logger.warn.mock.calls[0][0]);
    expect(message).toContain(text);
    expect(message).toContain('Enable `strict: true` (default in 3.0)');
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
    for (const stmt of INDEXES) await run(stmt);

    // both:  title=alpha body=beta    (2 reviews)
    // title: title=alpha body=gamma
    // body:  title=delta body=beta
    await run(
      `CREATE (b:ItSmDoc {id: $both, runId: $runId, title: $alpha, body: $beta,
                          pages: 10, tags: ['Red', 'Blue'],
                          scores: [1, 2], ratings: [0.5, 1.5]})
       CREATE (:ItSmDoc {id: $title, runId: $runId, title: $alpha, body: $gamma,
                         pages: 20, scores: [5], ratings: [2.5]})
       CREATE (:ItSmDoc {id: $body, runId: $runId, title: $delta, body: $beta})
       CREATE (b)-[:IT_SM_HAS_REVIEW {note: 'n5'}]->
              (:ItSmReview {id: $r5, runId: $runId, body: 'great', stars: 5})
       CREATE (b)-[:IT_SM_HAS_REVIEW {note: 'n1'}]->
              (:ItSmReview {id: $r1, runId: $runId, body: 'bad', stars: 1})`,
      {
        both: id('both'),
        title: id('title'),
        body: id('body'),
        r5: id('r5'),
        r1: id('r1'),
        alpha: word('alpha'),
        beta: word('beta'),
        gamma: word('gamma'),
        delta: word('delta'),
      },
    );
    await run('CALL db.awaitIndexes(60)');
    for (let i = 0; i < 50; i++) {
      const rows = await run(
        `CALL db.index.fulltext.queryNodes('ItSmTitleSearch', $q) YIELD node RETURN count(node) AS c`,
        { q: word('alpha') },
      );
      if (Number(rows[0].c) >= 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      for (const name of ['ItSmTitleSearch', 'ItSmBodySearch'])
        await run(`DROP INDEX ${name} IF EXISTS`);
      await driver.close();
    }
  });

  describe('item 6 — fulltext score inside OR / AND', () => {
    // No fulltext score reaches 1000, so a threshold of 1000 drops every
    // row of the branch it applies to.
    const orInput = () => ({
      OR: [
        { ItSmTitleSearch: { phrase: word('alpha'), score: 1000 } },
        { ItSmBodySearch: { phrase: word('beta') } },
      ],
    });
    const andInput = () => ({
      AND: [
        { ItSmTitleSearch: { phrase: word('alpha') } },
        { ItSmBodySearch: { phrase: word('beta'), score: 1000 } },
      ],
    });

    it('default: the branch score is ignored, one warning', async () => {
      const { doc, logger } = make();
      const find = (fulltext: unknown) =>
        doc.find({ fulltext: fulltext as never, selectionSet: '{ id }' });
      expect(ids(await find(orInput()))).toEqual(
        [id('both'), id('title'), id('body')].sort(),
      );
      expect(ids(await find(andInput()))).toEqual([id('both')]);
      expectOneWarning(logger, 'fulltext `score` inside OR / AND / NOT');
    });

    it('strict: each branch applies its own threshold', async () => {
      const { doc, logger } = make(true);
      const find = (fulltext: unknown) =>
        doc.find({ fulltext: fulltext as never, selectionSet: '{ id }' });
      expect(ids(await find(orInput()))).toEqual(
        [id('both'), id('body')].sort(),
      );
      expect(ids(await find(andInput()))).toEqual([]);
      // A lower threshold keeps the branch.
      expect(
        ids(
          await find({
            AND: [
              { ItSmTitleSearch: { phrase: word('alpha') } },
              { ItSmBodySearch: { phrase: word('beta'), score: 0.0001 } },
            ],
          }),
        ),
      ).toEqual([id('both')]);
      // A single-branch OR with a score works too (pre-2.6.0 it referenced
      // a missing $ft_score parameter).
      expect(
        ids(
          await find({
            OR: [{ ItSmBodySearch: { phrase: word('beta'), score: 1000 } }],
          }),
        ),
      ).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("item 8 — mode: 'insensitive' with _IN / _NOT_IN", () => {
    const where = (extra: Record<string, unknown>) =>
      ({ runId, mode: 'insensitive', ...extra }) as never;

    it('default: compares case-sensitively, one warning', async () => {
      const { doc, logger } = make();
      const find = (extra: Record<string, unknown>) =>
        doc.find({ where: where(extra), selectionSet: '{ id }' });
      expect(ids(await find({ title_IN: [word('ALPHA')] }))).toEqual([]);
      expect(ids(await find({ title_IN: [word('ALPHA')] }))).toEqual([]);
      expectOneWarning(
        logger,
        "`mode: 'insensitive'` does not apply to `title_IN`",
      );
    });

    it('strict: _IN, _NOT_IN and a String list _IN ignore case', async () => {
      const { doc, logger } = make(true);
      const find = (extra: Record<string, unknown>) =>
        doc.find({ where: where(extra), selectionSet: '{ id }' });
      expect(ids(await find({ title_IN: [word('ALPHA')] }))).toEqual(
        [id('both'), id('title')].sort(),
      );
      expect(ids(await find({ title_NOT_IN: [word('ALPHA')] }))).toEqual([
        id('body'),
      ]);
      expect(ids(await find({ tags_IN: [['RED', 'blue']] }))).toEqual([
        id('both'),
      ]);
      // Non-string fields are unaffected (no toLower on an Int).
      expect(ids(await find({ pages_IN: [10] }))).toEqual([id('both')]);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('item 11 — aggregate avg / sum on a list field (both modes)', () => {
    it.each([undefined, true])(
      'strict=%s: list keys come back null, the rest still aggregates',
      async (strict) => {
        const { doc, ogm, logger } = make(strict);
        const agg = await doc.aggregate({
          where: { runId } as never,
          aggregate: { count: true, scores: true, ratings: true, pages: true },
        });
        expect(agg).toEqual({
          count: 3,
          scores: { min: [1, 2], max: [5], average: null, sum: null },
          ratings: { min: [0.5, 1.5], max: [2.5], average: null, sum: null },
          pages: { min: 10, max: 20, average: 15, sum: 30 },
        });
        const iface = await ogm.interfaceModel('ItSmScored').aggregate({
          where: { runId } as never,
          aggregate: { count: true, scores: true },
        });
        expect(iface).toEqual({
          count: 3,
          scores: { min: [1, 2], max: [5], average: null, sum: null },
        });
        expect(logger.warn).not.toHaveBeenCalled();
      },
    );
  });
});

export { OGMError };
