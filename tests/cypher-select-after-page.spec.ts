/**
 * vNEXT — strict item 49: with `strict: true`, a sorted AND paged `find`
 * projects the selected `@cypher` fields AFTER ORDER BY / SKIP / LIMIT, so
 * they run once per returned row. Default mode (strict unset / false) is
 * byte-identical to v2.23.0. Results:
 * `tests/integration/cypher-select-after-page.spec.ts`.
 */
import { OGM } from '../src/ogm';
import { recordingDriver } from './strict-mode.writes.cases';

const typeDefs = /* GraphQL */ `
  interface Thing {
    id: ID!
    rank: Int
    score: Int
      @cypher(
        statement: "MATCH (this)-[:R]->(p) RETURN count(p) AS c"
        columnName: "c"
      )
  }
  type User implements Thing @node {
    id: ID! @unique
    rank: Int
    score: Int
      @cypher(
        statement: "MATCH (this)-[:R]->(p) RETURN count(p) AS c"
        columnName: "c"
      )
    other: Int @cypher(statement: "RETURN this.rank * 2 AS c", columnName: "c")
  }
`;

type Run = (ogm: OGM) => Promise<unknown>;

async function cypherOf(run: Run, strict?: boolean): Promise<string> {
  const records: { cypher: string }[] = [];
  const ogm = new OGM({
    typeDefs,
    driver: recordingDriver(records as never),
    ...(strict === undefined ? {} : { strict }),
  });
  await run(ogm);
  return records[0].cypher;
}

const lines = (c: string) => c.split('\n');
const idx = (c: string, s: string) => lines(c).findIndex((l) => l.includes(s));

const SCORE_CALL = (alias: string) =>
  `CALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    MATCH (this)-[:R]->(p) RETURN count(p) AS c\n  }\n  RETURN head(collect(\`c\`)) AS ${alias}\n}`;
const OTHER_CALL = `CALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    RETURN this.rank * 2 AS c\n  }\n  RETURN head(collect(\`c\`)) AS __sel_n_other\n}`;

const shapes: Record<string, Run> = {
  'sorted + paged': (o) =>
    o.model('User').find({
      options: { sort: [{ rank: 'ASC' }], offset: 2, limit: 5 },
      selectionSet: '{ id score }',
    }),
  'sort on one @cypher field, another selected': (o) =>
    o.model('User').find({
      options: { sort: [{ score: 'DESC' }], limit: 5 },
      selectionSet: '{ id other }',
    }),
  'InterfaceModel sorted + paged': (o) =>
    o.interfaceModel('Thing').find({
      options: { sort: [{ rank: 'ASC' }], limit: 3 },
      selectionSet: '{ id score }',
    } as never),
};

/** v2.23.0 (041511b) default-mode Cypher, hard-coded. */
const V2230: Record<string, string> = {
  'sorted + paged': [
    'MATCH (n:`User`)',
    SCORE_CALL('__sel_n_score'),
    'WITH n, __sel_n_score',
    'WITH *',
    'ORDER BY n.`rank` ASC',
    'SKIP $options_offset',
    'LIMIT $options_limit',
    'RETURN n { .`id`, `score`: __sel_n_score }',
  ].join('\n'),
  'sort on one @cypher field, another selected': [
    'MATCH (n:`User`)',
    OTHER_CALL,
    'WITH n, __sel_n_other',
    SCORE_CALL('__sort_score'),
    'WITH n, __sel_n_other, __sort_score',
    'WITH *',
    'ORDER BY __sort_score DESC',
    'LIMIT $options_limit',
    'RETURN n { .`id`, `other`: __sel_n_other }',
  ].join('\n'),
};

describe('strict item 49 — default mode is byte-identical to v2.23.0', () => {
  for (const [name, expected] of Object.entries(V2230))
    it.each([undefined, false])(`${name} (strict: %s)`, async (strict) => {
      expect(await cypherOf(shapes[name], strict)).toBe(expected);
    });

  it('InterfaceModel sorted + paged: default keeps the SELECT prelude before the paging', async () => {
    for (const strict of [undefined, false]) {
      const c = await cypherOf(shapes['InterfaceModel sorted + paged'], strict);
      expect(idx(c, 'AS __sel_n_score')).toBeLessThan(
        lines(c).indexOf('WITH *'),
      );
    }
  });
});

describe('strict item 49 — strict mode projects SELECT @cypher after paging', () => {
  it('sorted + paged: the SELECT prelude follows LIMIT', async () => {
    const c = await cypherOf(shapes['sorted + paged'], true);
    expect(idx(c, 'LIMIT $options_limit')).toBeLessThan(
      idx(c, 'AS __sel_n_score'),
    );
    expect(
      c.endsWith(
        'WITH n, __sel_n_score\nRETURN n { .`id`, `score`: __sel_n_score }',
      ),
    ).toBe(true);
  });

  it('sort on one @cypher field, another selected: only the sort prelude precedes ORDER BY', async () => {
    const c = await cypherOf(
      shapes['sort on one @cypher field, another selected'],
      true,
    );
    const orderAt = idx(c, 'ORDER BY __sort_score DESC');
    expect(idx(c, 'AS __sort_score')).toBeLessThan(orderAt);
    expect(idx(c, 'AS __sel_n_other')).toBeGreaterThan(orderAt);
    expect(c).toContain('WITH n, __sort_score\n');
  });

  it.each([
    ['unpaged sort', { sort: [{ rank: 'ASC' }] }],
    ['unsorted limit', { limit: 5 }],
    ['no options', undefined],
  ])('%s: strict output equals default output', async (_n, options) => {
    const run: Run = (o) =>
      o.model('User').find({
        options: options as never,
        selectionSet: '{ id score }',
      });
    expect(await cypherOf(run, true)).toBe(await cypherOf(run, undefined));
  });

  it('InterfaceModel: moves the SELECT prelude, keeps __typename', async () => {
    const c = await cypherOf(shapes['InterfaceModel sorted + paged'], true);
    expect(idx(c, 'LIMIT $options_limit')).toBeLessThan(
      idx(c, 'AS __sel_n_score'),
    );
    expect(c).toContain('WITH n, __typename, __sel_n_score');
  });
});
