/**
 * v2.6.0 — strict mode, read-side items (fulltext branch score, @include /
 * @skip, insensitive _IN, duplicate response keys, aliased connection
 * edges, aggregate over list fields).
 *
 * The byte-identical guard pins the v2.5.3 Cypher of every bad shape: with
 * `strict` unset and `strict: false` the OGM must keep emitting exactly it.
 */
import { Driver } from 'neo4j-driver';
import { Model } from '../src/model';
import { OGM } from '../src/ogm';

const typeDefs = /* GraphQL */ `
  type Reviewed @relationshipProperties {
    at: String
    score: Int
  }
  type Review @node {
    id: ID! @id
    body: String
    stars: Int
  }
  type Book
    @node
    @fulltext(
      indexes: [
        { name: "BookTitle", fields: ["title"] }
        { name: "BookBlurb", fields: ["blurb"] }
      ]
    ) {
    id: ID! @id @unique
    title: String!
    blurb: String
    pages: Int
    tags: [String!]
    scores: [Int!]
    ratings: [Float!]
    reviews: [Review!]!
      @relationship(type: "HAS_REVIEW", direction: OUT, properties: "Reviewed")
  }
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function mockDriver(records: Recorded[]): Driver {
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      records.push({ cypher, params });
      return Promise.resolve({ records: [], summary: {} });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { session: jest.fn().mockReturnValue(session) } as unknown as Driver;
}

function makeOgm(strict: boolean | undefined) {
  const records: Recorded[] = [];
  const logger = { debug: jest.fn(), warn: jest.fn() };
  const ogm = new OGM({
    typeDefs,
    driver: mockDriver(records),
    logger,
    ...(strict === undefined ? {} : { strict }),
  });
  return { ogm, records, logger };
}

type Case = {
  label: string;
  run: (ogm: OGM) => Promise<unknown>;
  /** v2.5.3 Cypher, hard-coded from main. */
  expected: string;
};

const CASES: Case[] = [
  {
    label: 'fulltext score inside OR',
    run: (ogm) =>
      ogm.model('Book').find({
        selectionSet: '{ id }',
        fulltext: {
          OR: [
            { BookTitle: { phrase: 'a', score: 2 } },
            { BookBlurb: { phrase: 'b' } },
          ],
        },
      }),
    expected:
      'CALL {\n' +
      "  CALL db.index.fulltext.queryNodes('BookTitle', $ft_phrase_0)\n" +
      '  YIELD node AS n, score\n' +
      '  RETURN n, score\n' +
      '  UNION\n' +
      "  CALL db.index.fulltext.queryNodes('BookBlurb', $ft_phrase_1)\n" +
      '  YIELD node AS n, score\n' +
      '  RETURN n, score\n' +
      '}\n' +
      'WITH n, max(score) AS score\n' +
      'WHERE n:`Book`\n' +
      'RETURN n { .`id` }',
  },
  {
    label: 'fulltext score inside AND',
    run: (ogm) =>
      ogm.model('Book').find({
        selectionSet: '{ id }',
        fulltext: {
          AND: [
            { BookTitle: { phrase: 'a' } },
            { BookBlurb: { phrase: 'b', score: 1.5 } },
          ],
        },
      }),
    expected:
      "CALL db.index.fulltext.queryNodes('BookTitle', $ft_phrase_0)\n" +
      'YIELD node AS n, score\n' +
      'CALL {\n' +
      '  WITH n\n' +
      '  CALL {\n' +
      "    CALL db.index.fulltext.queryNodes('BookBlurb', $ft_phrase_1)\n" +
      '    YIELD node AS __ft_and_1_1_v, score\n' +
      '    RETURN __ft_and_1_1_v AS __ft_and_1_1_m, score AS __ft_and_1_1_s\n' +
      '  }\n' +
      '  WITH n, __ft_and_1_1_m, __ft_and_1_1_s\n' +
      '  WHERE __ft_and_1_1_m = n\n' +
      '  WITH max(__ft_and_1_1_s) AS __ft_and_1_1_best\n' +
      '  WHERE __ft_and_1_1_best IS NOT NULL\n' +
      '  RETURN __ft_and_1_1_best\n' +
      '}\n' +
      'WITH n, score\n' +
      'WHERE n:`Book`\n' +
      'RETURN n { .`id` }',
  },
  {
    label: '@include / @skip in a selectionSet',
    run: (ogm) =>
      ogm.model('Book').find({
        selectionSet:
          '{ id title @include(if: false) blurb @skip(if: true) pages @include(if: true) }',
      }),
    expected:
      'MATCH (n:`Book`)\n' + 'RETURN n { .`id`, .`title`, .`blurb`, .`pages` }',
  },
  {
    label: "mode: 'insensitive' with _IN / _NOT_IN",
    run: (ogm) =>
      ogm.model('Book').find({
        selectionSet: '{ id }',
        where: {
          mode: 'insensitive',
          title_IN: ['Dune'],
          blurb_NOT_IN: ['X'],
        },
      }),
    expected:
      'MATCH (n:`Book`)\n' +
      'WHERE n.`title` IN $param0 AND NOT n.`blurb` IN $param1\n' +
      'RETURN n { .`id` }',
  },
  {
    label: 'same response key, different arguments',
    run: (ogm) =>
      ogm.model('Book').find({
        selectionSet:
          '{ id reviews(where: { stars: 5 }) { id } reviews(where: { stars: 1 }) { body } }',
      }),
    expected:
      'MATCH (n:`Book`)\n' +
      'RETURN n { .`id`, reviews: [(n)-[:`HAS_REVIEW`]->(n0:`Review`) WHERE n0.`stars` = $param0 | n0 { .`id` }] }',
  },
  {
    label: 'two differently aliased edges',
    run: (ogm) =>
      ogm.model('Book').find({
        selectionSet:
          '{ id reviewsConnection { a: edges { node { id } } b: edges { node { body } } } }',
      }),
    expected:
      'MATCH (n:`Book`)\n' +
      'RETURN n { .`id`, reviewsConnection: { `a`: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) | { node: n0 { .`id`, .`body` } }] } }',
  },
];

async function cypherOf(strict: boolean | undefined, c: Case) {
  Model.clearSelectionCache();
  const { ogm, records } = makeOgm(strict);
  await c.run(ogm);
  return records.map((r) => r.cypher).join('\n;\n');
}

describe('strict mode (reads) — default mode is byte-identical to v2.5.3', () => {
  it.each(CASES)('$label', async (c) => {
    const unset = await cypherOf(undefined, c);
    const off = await cypherOf(false, c);
    expect(off).toBe(unset);
    expect(unset).toBe(c.expected);
  });
});

function caseNamed(label: string): Case {
  return CASES.find((c) => c.label === label)!;
}

/** Run a case on a fresh OGM; returns its Cypher and its logger. */
async function runCase(strict: boolean | undefined, c: Case, times = 1) {
  Model.clearSelectionCache();
  const made = makeOgm(strict);
  for (let i = 0; i < times; i++) await c.run(made.ogm);
  return {
    cypher: made.records.map((r) => r.cypher).join('\n;\n'),
    logger: made.logger,
  };
}

function expectOneWarning(logger: { warn: jest.Mock }, text: string) {
  expect(logger.warn).toHaveBeenCalledTimes(1);
  const message = String(logger.warn.mock.calls[0][0]);
  expect(message).toContain(text);
  expect(message).toContain('Enable `strict: true` (default in 3.0)');
}

describe('item 6 — fulltext score inside OR / AND / NOT (v2.6.0)', () => {
  it('default: warns once per OGM, even across calls', async () => {
    const { logger } = await runCase(
      undefined,
      caseNamed('fulltext score inside OR'),
      3,
    );
    expectOneWarning(
      logger,
      'A fulltext `score` inside OR / AND / NOT (on Book) is ignored in 2.x',
    );
  });

  it('a top-level score does not warn', async () => {
    const { logger } = await runCase(undefined, {
      label: 'top-level',
      expected: '',
      run: (ogm) =>
        ogm.model('Book').find({
          selectionSet: '{ id }',
          fulltext: { BookTitle: { phrase: 'a', score: 2 } },
        }),
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('strict: the OR branch filters its own rows', async () => {
    const { cypher, logger } = await runCase(
      true,
      caseNamed('fulltext score inside OR'),
    );
    expect(cypher).toContain(
      "CALL db.index.fulltext.queryNodes('BookTitle', $ft_phrase_0)\n" +
        '  YIELD node AS n, score\n' +
        '  WHERE score >= $ft_score_0\n' +
        '  WITH n, score\n' +
        '  RETURN n, score\n' +
        '  UNION',
    );
    expect(cypher).not.toContain('$ft_score_1');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('strict: the AND branch filters inside its isolated CALL', async () => {
    const { cypher } = await runCase(
      true,
      caseNamed('fulltext score inside AND'),
    );
    expect(cypher).toContain(
      '    YIELD node AS __ft_and_1_1_v, score\n' +
        '    WHERE score >= $ft_score_1\n' +
        '    WITH __ft_and_1_1_v, score\n' +
        '    RETURN __ft_and_1_1_v AS __ft_and_1_1_m',
    );
  });

  it('strict: a NOT branch and a single-branch OR keep valid Cypher', async () => {
    const { cypher } = await runCase(true, {
      label: 'not',
      expected: '',
      run: async (ogm) => {
        await ogm.model('Book').find({
          selectionSet: '{ id }',
          fulltext: { NOT: { BookTitle: { phrase: 'a', score: 2 } } },
        });
        await ogm.model('Book').find({
          selectionSet: '{ id }',
          fulltext: { OR: [{ BookTitle: { phrase: 'a', score: 2 } }] },
        });
      },
    });
    expect(cypher).toContain(
      '    YIELD node AS __ft_not_1_v, score\n' +
        '    WHERE score >= $ft_score_0\n' +
        '    WITH __ft_not_1_v, score',
    );
    // Single-branch OR: the threshold is consumed by the branch, so no
    // `score >= $ft_score` (whose param would not exist) is appended.
    expect(cypher).toContain(
      'WHERE score >= $ft_score_0\nWITH n, score\nWHERE n:`Book`\n',
    );
    expect(cypher).not.toContain('$ft_score\n');
  });
});

describe("item 8 — mode: 'insensitive' with _IN / _NOT_IN (v2.6.0)", () => {
  const where = (w: Record<string, unknown>): Case => ({
    label: 'w',
    expected: '',
    run: (ogm) =>
      ogm.model('Book').find({ selectionSet: '{ id }', where: w as never }),
  });

  it('default: warns once per field + operator', async () => {
    const { logger } = await runCase(
      undefined,
      where({ mode: 'insensitive', title_IN: ['Dune'] }),
      3,
    );
    expectOneWarning(
      logger,
      "`mode: 'insensitive'` does not apply to `title_IN`: _IN / _NOT_IN compare case-sensitively in 2.x.",
    );
  });

  it('no warning without insensitive mode, or on a non-string field', async () => {
    const { logger } = await runCase(
      undefined,
      where({
        title_IN: ['Dune'],
        AND: [{ mode: 'insensitive', pages_IN: [1] }],
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('strict: lowers the field and each element', async () => {
    const { cypher, logger } = await runCase(
      true,
      caseNamed("mode: 'insensitive' with _IN / _NOT_IN"),
    );
    expect(cypher).toBe(
      'MATCH (n:`Book`)\n' +
        'WHERE toLower(n.`title`) IN [wc_s IN $param0 | toLower(wc_s)] AND ' +
        'NOT toLower(n.`blurb`) IN [wc_s IN $param1 | toLower(wc_s)]\n' +
        'RETURN n { .`id` }',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('strict: a String list _IN lowers element-wise; Int fields stay raw', async () => {
    const { cypher } = await runCase(
      true,
      where({ mode: 'insensitive', tags_IN: [['A']], pages_IN: [1] }),
    );
    expect(cypher).toContain(
      '[wc_s IN n.`tags` | toLower(wc_s)] IN [wc_l IN $param0 | [wc_s IN wc_l | toLower(wc_s)]]',
    );
    expect(cypher).toContain('n.`pages` IN $param1');
  });
});

describe('item 11 — aggregate avg / sum on a list field (v2.6.0, both modes)', () => {
  it.each([undefined, false, true])(
    'strict=%s: no avg / sum for [Int] / [Float]; scalars keep them',
    async (strict) => {
      const { cypher, logger } = await runCase(strict, {
        label: 'agg',
        expected: '',
        run: (ogm) =>
          ogm.model('Book').aggregate({
            aggregate: {
              count: true,
              scores: true,
              ratings: true,
              pages: true,
            },
          }),
      });
      expect(cypher).toBe(
        'MATCH (n:`Book`)\n' +
          'RETURN count(n) AS count, min(n.`scores`) AS scores_min, max(n.`scores`) AS scores_max, ' +
          'min(n.`ratings`) AS ratings_min, max(n.`ratings`) AS ratings_max, ' +
          'min(n.`pages`) AS pages_min, max(n.`pages`) AS pages_max, ' +
          'avg(n.`pages`) AS pages_avg, sum(n.`pages`) AS pages_sum',
      );
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );
});
