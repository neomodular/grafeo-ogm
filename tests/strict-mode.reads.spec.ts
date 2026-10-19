/**
 * v2.6.0 — strict mode, read-side items (fulltext branch score, @include /
 * @skip, insensitive _IN, duplicate response keys, aliased connection
 * edges, aggregate over list fields).
 *
 * The byte-identical guard pins the v2.5.3 Cypher of every bad shape: with
 * `strict` unset and `strict: false` the OGM must keep emitting exactly it.
 */
import { Driver } from 'neo4j-driver';
import { OGMError } from '../src/errors';
import { Model } from '../src/model';
import { OGM } from '../src/ogm';
import { permissive } from '../src/policy/types';

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

describe('item 9 — one response key, different arguments (v2.6.0)', () => {
  const c = () => caseNamed('same response key, different arguments');

  it('default: keeps the first selection, warns once (cache hits too)', async () => {
    Model.clearSelectionCache();
    const made = makeOgm(undefined);
    await c().run(made.ogm);
    await c().run(made.ogm);
    expectOneWarning(
      made.logger,
      'The selectionSet selects "reviews" twice with different arguments; 2.x keeps the first selection and drops the second.',
    );
    // A second OGM hits Model's shared selection cache and still warns.
    const other = makeOgm(undefined);
    await c().run(other.ogm);
    expect(other.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('same arguments merge silently', async () => {
    const { logger } = await runCase(undefined, {
      label: 'same',
      expected: '',
      run: (ogm) =>
        ogm.model('Book').find({
          selectionSet:
            '{ reviews(where: { stars: 5 }) { id } reviews(where: { stars: 5 }) { body } }',
        }),
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('strict: throws OGMError, like GraphQL validation', async () => {
    Model.clearSelectionCache();
    const { ogm, records } = makeOgm(true);
    await expect(c().run(ogm)).rejects.toThrow(
      new OGMError(
        'Fields "reviews" conflict because they have differing arguments. Use different aliases on the fields to fetch both.',
      ),
    );
    expect(records).toHaveLength(0);
  });

  it('strict: aliases fetch both', async () => {
    const { cypher } = await runCase(true, {
      label: 'aliased',
      expected: '',
      run: (ogm) =>
        ogm.model('Book').find({
          selectionSet:
            '{ five: reviews(where: { stars: 5 }) { id } one: reviews(where: { stars: 1 }) { body } }',
        }),
    });
    expect(cypher).toContain('five: [');
    expect(cypher).toContain(', one: [');
  });
});

describe('item 7 — @include / @skip in a selectionSet (v2.6.0)', () => {
  const find = (selectionSet: string): Case => ({
    label: selectionSet,
    expected: '',
    run: (ogm) => ogm.model('Book').find({ selectionSet }),
  });

  it('default: ignored, one warning per selection (cache hits too)', async () => {
    const { logger } = await runCase(
      undefined,
      find('{ id title @include(if: false) }'),
      3,
    );
    expectOneWarning(
      logger,
      '@include / @skip on "title" in a selectionSet is ignored in 2.x: the selection is always kept.',
    );
  });

  it('default: a $variable is still ignored, not rejected', async () => {
    const { cypher } = await runCase(
      undefined,
      find('{ id title @include(if: $show) }'),
    );
    expect(cypher).toBe('MATCH (n:`Book`)\nRETURN n { .`id`, .`title` }');
  });

  it('strict: honours literal if on fields, fragments and connection keys', async () => {
    const { cypher, logger } = await runCase(
      true,
      caseNamed('@include / @skip in a selectionSet'),
    );
    expect(cypher).toBe('MATCH (n:`Book`)\nRETURN n { .`id`, .`pages` }');
    const more = await runCase(
      true,
      find(
        '{ id ... on Book @skip(if: true) { title } reviewsConnection { totalCount @skip(if: true) edges { node { id } properties @include(if: false) { at } } } }',
      ),
    );
    expect(more.cypher).toBe(
      'MATCH (n:`Book`)\n' +
        'RETURN n { .`id`, reviewsConnection: { edges: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) | { node: n0 { .`id` } }] } }',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      '{ id title @include(if: $show) }',
      'GraphQL variables are not supported in selectionSet directives (@include on "title": $show). Use a literal true or false.',
    ],
    [
      '{ id title @skip(if: "yes") }',
      '@skip(if:) on "title" must be a literal true or false.',
    ],
    [
      '{ id title @include }',
      '@include on "title" takes exactly one argument: if: true | false.',
    ],
  ])('strict: rejects %s', async (selectionSet, message) => {
    Model.clearSelectionCache();
    const { ogm } = makeOgm(true);
    await expect(find(selectionSet).run(ogm)).rejects.toThrow(
      new OGMError(message),
    );
  });
});

describe('item 10 — two differently aliased edges (v2.6.0)', () => {
  const find = (selectionSet: string): Case => ({
    label: selectionSet,
    expected: '',
    run: (ogm) => ogm.model('Book').find({ selectionSet }),
  });

  it('default: keeps the first alias, warns once', async () => {
    const { logger } = await runCase(
      undefined,
      caseNamed('two differently aliased edges'),
      3,
    );
    expectOneWarning(
      logger,
      '"reviewsConnection" selects `edges` under two response keys ("a", "b"); 2.x returns only "a", with both selections merged into it.',
    );
  });

  it('default: an unaliased + aliased pair warns too; same alias does not', async () => {
    const mixed = await runCase(
      undefined,
      find(
        '{ reviewsConnection { edges { node { id } } b: edges { node { body } } } }',
      ),
    );
    expect(mixed.logger.warn).toHaveBeenCalledTimes(1);
    const same = await runCase(
      undefined,
      find(
        '{ reviewsConnection { a: edges { node { id } } a: edges { node { body } } } }',
      ),
    );
    expect(same.logger.warn).not.toHaveBeenCalled();
  });

  it('strict: each alias gets its own list', async () => {
    const { cypher, logger } = await runCase(
      true,
      caseNamed('two differently aliased edges'),
    );
    expect(cypher).toBe(
      'MATCH (n:`Book`)\n' +
        'RETURN n { .`id`, reviewsConnection: { ' +
        '`a`: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) | { node: n0 { .`id` } }], ' +
        '`b`: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) | { node: n0 { .`body` } }] } }',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('strict: unaliased + aliased, with properties, filter and totalCount', async () => {
    const { cypher } = await runCase(
      true,
      find(
        '{ reviewsConnection(where: { node: { stars: 5 } }) { totalCount edges { node { id } } b: edges { p: properties { at } } } }',
      ),
    );
    expect(cypher).toBe(
      'MATCH (n:`Book`)\n' +
        'RETURN n { reviewsConnection: { ' +
        'edges: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) WHERE n0.`stars` = $param0 | { node: n0 { .`id` } }], ' +
        '`b`: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) WHERE n0.`stars` = $param0 | { `p`: e0 { .`at` } }], ' +
        'totalCount: size([(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) WHERE n0.`stars` = $param0 | 1]) } }',
    );
  });

  it('strict: a connection selected twice keeps its edge sets apart', async () => {
    const { cypher } = await runCase(
      true,
      find(
        '{ reviewsConnection { a: edges { node { id } } } reviewsConnection { b: edges { node { body } } a: edges { node { stars } } } }',
      ),
    );
    expect(cypher).toBe(
      'MATCH (n:`Book`)\n' +
        'RETURN n { reviewsConnection: { ' +
        '`a`: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) | { node: n0 { .`id`, .`stars` } }], ' +
        '`b`: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) | { node: n0 { .`body` } }] } }',
    );
  });
});

describe('item 10 — extra edge sets keep the target read policy (v2.6.0)', () => {
  it('strict: every edges list carries the Review policy', async () => {
    Model.clearSelectionCache();
    const records: Recorded[] = [];
    const ogm = new OGM({
      typeDefs,
      driver: mockDriver(records),
      strict: true,
      policies: {
        Review: [
          permissive({
            operations: ['read'],
            when: () => ({ stars_GT: 0 }),
          }),
        ],
      },
    });
    await ogm.withContext({ user: 'u' }).model('Book').find({
      selectionSet:
        '{ reviewsConnection { a: edges { node { id } } b: edges { node { body } } } }',
    });
    const cypher = records[0].cypher;
    const lists = cypher.match(/\[\(n\)-\[e0[^|]*\|/g) ?? [];
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).toContain('n0.`stars` > $param');
  });
});

describe('item 9 — fragments on disjoint vs overlapping types (v2.6.0)', () => {
  const petDefs = /* GraphQL */ `
    interface Pet {
      name: String
    }
    type Toy @node {
      id: ID! @id
      kind: String
    }
    type Dog implements Pet @node {
      name: String
      pals: [Toy!]! @relationship(type: "PAL", direction: OUT)
    }
    type Cat implements Pet @node {
      name: String
      pals: [Toy!]! @relationship(type: "PAL", direction: OUT)
    }
  `;
  const DISJOINT =
    '{ ... on Dog { pals(where: { kind: "a" }) { id } } ... on Cat { pals(where: { kind: "b" }) { id } } }';
  const OVERLAPPING =
    '{ ... on Dog { pals(where: { kind: "a" }) { id } } ... on Pet { ... on Dog { pals(where: { kind: "b" }) { id } } } }';

  async function run(strict: boolean | undefined, selectionSet: string) {
    Model.clearSelectionCache();
    const records: Recorded[] = [];
    const logger = { debug: jest.fn(), warn: jest.fn() };
    const ogm = new OGM({
      typeDefs: petDefs,
      driver: mockDriver(records),
      logger,
      ...(strict === undefined ? {} : { strict }),
    });
    await ogm.interfaceModel('Pet').find({ selectionSet });
    return { cypher: records[0]?.cypher, params: records[0]?.params, logger };
  }

  /** v2.5.4 Cypher for DISJOINT: the first selection's filter for both types. */
  const DISJOINT_V254 =
    'MATCH (n:(`Dog`|`Cat`))\n' +
    "WITH n, CASE WHEN n:`Dog` THEN 'Dog' WHEN n:`Cat` THEN 'Cat' END AS __typename\n" +
    "RETURN n { __typename: head([__label IN labels(n) WHERE __label IN ['Dog', 'Cat']]), pals: CASE " +
    'WHEN n:`Dog` THEN [(n)-[:`PAL`]->(n0:`Toy`) WHERE n0.`kind` = $param0 | n0 { .`id` }] ' +
    'WHEN n:`Cat` THEN [(n)-[:`PAL`]->(n0:`Toy`) WHERE n0.`kind` = $param1 | n0 { .`id` }] ' +
    'ELSE [] END , __typename: __typename }';

  it('default: disjoint fragments keep the first selection and do NOT warn', async () => {
    const unset = await run(undefined, DISJOINT);
    const off = await run(false, DISJOINT);
    expect(off.cypher).toBe(unset.cypher);
    expect(unset.cypher).toBe(DISJOINT_V254);
    expect(unset.params).toEqual({ param0: 'a', param1: 'a' });
    expect(unset.logger.warn).not.toHaveBeenCalled();
  });

  it('strict: disjoint fragments do not throw; each type gets its own arguments', async () => {
    const { cypher, params, logger } = await run(true, DISJOINT);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(params).toEqual({ param0: 'a', param1: 'b' });
    expect(cypher).toContain(
      'pals: CASE ' +
        'WHEN n:`Dog` THEN [(n)-[:`PAL`]->(n0:`Toy`) WHERE n0.`kind` = $param0 | n0 { .`id` }] ' +
        'WHEN n:`Cat` THEN [(n)-[:`PAL`]->(n0:`Toy`) WHERE n0.`kind` = $param1 | n0 { .`id` }] ' +
        'ELSE [] END',
    );
  });

  it('default: fragments that can hit the same object warn once', async () => {
    const { logger } = await run(undefined, OVERLAPPING);
    expectOneWarning(
      logger,
      'The selectionSet selects "pals" twice with different arguments',
    );
  });

  it('strict: fragments that can hit the same object throw', async () => {
    await expect(run(true, OVERLAPPING)).rejects.toThrow(
      'Fields "pals" conflict because they have differing arguments.',
    );
    // An interface fragment overlaps each of its implementers.
    await expect(
      run(
        true,
        '{ ... on Pet { ... on Cat { pals(where: { kind: "a" }) { id } } } ... on Cat { pals { id } } }',
      ),
    ).rejects.toThrow('Fields "pals" conflict');
  });
});

describe('item 10 — differently aliased node / properties in one edges (v2.6.0)', () => {
  const find = (selectionSet: string): Case => ({
    label: selectionSet,
    expected: '',
    run: (ogm) => ogm.model('Book').find({ selectionSet }),
  });
  const NODES =
    '{ reviewsConnection { edges { a: node { id } b: node { body } } } }';
  const PROPS =
    '{ reviewsConnection { edges { p: properties { at } q: properties { score } } } }';

  /** v2.5.4 Cypher: the second key is merged into the first. */
  const NODES_V254 =
    'MATCH (n:`Book`)\n' +
    'RETURN n { reviewsConnection: { edges: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) | { `a`: n0 { .`id`, .`body` } }] } }';
  const PROPS_V254 =
    'MATCH (n:`Book`)\n' +
    'RETURN n { reviewsConnection: { edges: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) | { `p`: e0 { .`at`, .`score` } }] } }';

  it.each([
    [NODES, NODES_V254, 'node', 'a', 'b'],
    [PROPS, PROPS_V254, 'properties', 'p', 'q'],
  ])(
    'default: %s keeps the first key, byte-identical, warns once',
    async (selectionSet, v254, which, first, second) => {
      const unset = await runCase(undefined, find(selectionSet), 3);
      const off = await runCase(false, find(selectionSet));
      expect(unset.cypher.split('\n;\n')[0]).toBe(v254);
      expect(off.cypher).toBe(v254);
      expectOneWarning(
        unset.logger,
        `"reviewsConnection" selects \`${which}\` under two response keys ("${first}", "${second}") in its edges; ` +
          `2.x returns only "${first}", with both selections merged into it.`,
      );
    },
  );

  it('default: a connection selected twice with different node keys warns once', async () => {
    const { logger } = await runCase(
      undefined,
      find(
        '{ reviewsConnection { edges { a: node { id } } } reviewsConnection { edges { b: node { body } } } }',
      ),
    );
    expectOneWarning(
      logger,
      '"reviewsConnection" selects `node` under two response keys ("a", "b") in its edges',
    );
  });

  it('strict: each node / properties key gets its own selection', async () => {
    const nodes = await runCase(true, find(NODES));
    expect(nodes.cypher).toBe(
      'MATCH (n:`Book`)\n' +
        'RETURN n { reviewsConnection: { edges: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) | ' +
        '{ `a`: n0 { .`id` }, `b`: n0 { .`body` } }] } }',
    );
    expect(nodes.logger.warn).not.toHaveBeenCalled();
    const props = await runCase(true, find(PROPS));
    expect(props.cypher).toBe(
      'MATCH (n:`Book`)\n' +
        'RETURN n { reviewsConnection: { edges: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) | ' +
        '{ `p`: e0 { .`at` }, `q`: e0 { .`score` } }] } }',
    );
  });

  it('strict: keys merge by name across repeated edges and connections', async () => {
    const { cypher } = await runCase(
      true,
      find(
        '{ reviewsConnection { edges { a: node { id } } } ' +
          'reviewsConnection { edges { b: node { body } a: node { stars } } x: edges { node { id } c: node { body } } } }',
      ),
    );
    expect(cypher).toBe(
      'MATCH (n:`Book`)\n' +
        'RETURN n { reviewsConnection: { edges: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) | ' +
        '{ `a`: n0 { .`id`, .`stars` }, `b`: n0 { .`body` } }], ' +
        '`x`: [(n)-[e0:`HAS_REVIEW`]->(n0:`Review`) | { node: n0 { .`id` }, `c`: n0 { .`body` } }] } }',
    );
  });

  it('strict: an extra node key keeps the target read policy', async () => {
    Model.clearSelectionCache();
    const records: Recorded[] = [];
    const ogm = new OGM({
      typeDefs,
      driver: mockDriver(records),
      strict: true,
      policies: {
        Review: [
          permissive({ operations: ['read'], when: () => ({ stars_GT: 0 }) }),
        ],
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
    });
    await ogm.withContext({ user: 'u' }).model('Book').find({
      selectionSet:
        '{ reviewsConnection { edges { a: node { id } b: node { body } } } }',
    });
    expect(records[0].cypher).toContain('n0.`stars` > $param');
    expect(records[0].cypher).toContain('`b`: n0 { .`body` }');
  });
});
