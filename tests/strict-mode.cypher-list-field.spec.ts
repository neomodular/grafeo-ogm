/**
 * v2.14.0 — strict item 24: a list-typed `@cypher` field.
 *
 * Default mode reduces the statement's column with `head(collect(...))`,
 * so a statement returning one row per element yields one element. Strict
 * mode `UNWIND`s the column and `collect`s every element, as
 * `@neo4j/graphql` 5.x does. Default-mode Cypher is byte-identical to
 * v2.12.3 (golden captured from 3a8d21f with the shapes of
 * `cypher-list-field.cases.ts`), and warns once per OGM, type and field.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildCypherFieldCall,
  buildInlineCypherFieldExpr,
} from '../src/utils/cypher-field-projection';
import {
  buildListOgm,
  compileListShape,
  listFieldShapes,
  UNIT_IDS,
} from './cypher-list-field.cases';
import { recordingDriver } from './strict-mode.writes.cases';

const golden = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'cypher-list-field.default.golden.json'),
    'utf-8',
  ),
) as Record<string, string[]>;

describe('list @cypher fields — default mode is byte-identical to v2.12.3', () => {
  it('covers every golden shape', () => {
    expect(Object.keys(golden).sort()).toEqual(
      Object.keys(listFieldShapes).sort(),
    );
  });

  for (const [name, run] of Object.entries(listFieldShapes)) {
    it(`${name} (strict unset)`, async () => {
      expect(await compileListShape(run, undefined)).toEqual(golden[name]);
    });
    it(`${name} (strict: false)`, async () => {
      expect(await compileListShape(run, false)).toEqual(golden[name]);
    });
  }
});

describe('list @cypher fields — strict mode collects every element', () => {
  const strictOf = async (name: string) =>
    (await compileListShape(listFieldShapes[name], true)).join('\n;;\n');

  it('root prelude: UNWIND + collect inside the CALL, one row per node', async () => {
    const cypher = await strictOf('root typed select');
    expect(cypher).toContain(
      [
        'CALL {',
        '  WITH n',
        '  CALL {',
        '    WITH n',
        '    WITH n AS this',
        '    MATCH (this)-[:ITLF_TAG]->(t:ItLfTag) RETURN t.name AS tags ORDER BY t.pos',
        '  }',
        '  UNWIND `tags` AS `__sel_n_tags__cf_el`',
        '  RETURN collect(`__sel_n_tags__cf_el`) AS __sel_n_tags',
        '}',
        'WITH n, __sel_n_tags',
      ].join('\n'),
    );
    // A single-row list column is flattened the same way.
    expect(cypher).toContain(
      '  UNWIND `list` AS `__sel_n_tagList__cf_el`\n  RETURN collect(`__sel_n_tagList__cf_el`) AS __sel_n_tagList',
    );
    // The scalar @cypher field is unchanged.
    expect(cypher).toContain(
      '  RETURN head(collect(`firstTag`)) AS __sel_n_firstTag',
    );
    expect(cypher).not.toContain('head(collect(`tags`))');
    expect(cypher).not.toContain('head(collect(`list`))');
  });

  it.each([
    'nested relationship typed select',
    'nested relationship selectionSet',
    'connection edges node',
    'typed select connection',
    'nested interface fragments',
    'nested union fragments',
  ])('inline (%s): COLLECT over an inner CALL, no head()', async (name) => {
    const cypher = await strictOf(name);
    expect(cypher).toContain(
      "COLLECT { WITH n0 AS this\n  CALL {\n    WITH this\n    UNWIND split(this.title, ' ') AS w RETURN w AS words\n  }\n" +
        '  UNWIND `words` AS `words__cf_el`\n  WITH `words__cf_el` WHERE `words__cf_el` IS NOT NULL\n  RETURN `words__cf_el`\n}',
    );
    expect(cypher).not.toContain('head(COLLECT');
  });

  it('InterfaceModel fragments: per-member guarded preludes collect', async () => {
    const cypher = await strictOf('InterfaceModel fragments');
    expect(cypher).toContain(
      '  WITH n WHERE n:`ItLfPost`\n  CALL {\n    WITH n\n    WITH n AS this\n' +
        "    UNWIND split(this.title, ' ') AS w RETURN w AS words\n  }\n" +
        '  UNWIND `words` AS `__sel_n_ItLfPost_words__cf_el`\n' +
        '  RETURN collect(`__sel_n_ItLfPost_words__cf_el`) AS __sel_n_ItLfPost_words',
    );
    expect(cypher).toContain(
      'RETURN collect(`__sel_n_ItLfNote_words__cf_el`) AS __sel_n_ItLfNote_words',
    );
  });

  it.each([
    ['where list equality', '__where_n_tags'],
    ['where list _IN', '__where_n_tags'],
    ['count with list where', '__where_n_tags'],
    ['where through a relationship', '__where_r1_words'],
  ])('where (%s) filters the whole list', async (name, alias) => {
    const cypher = await strictOf(name);
    expect(cypher).toContain(`RETURN collect(\`${alias}__cf_el\`) AS ${alias}`);
    expect(cypher).not.toMatch(/head\(collect\(`(tags|words)`\)\)/);
  });

  it('sort by a scalar @cypher field keeps head(collect()); the list is collected', async () => {
    const cypher = await strictOf(
      'sort by a scalar @cypher field, list selected',
    );
    expect(cypher).toContain('head(collect(`firstTag`)) AS __sort_firstTag');
    expect(cypher).toContain(
      'RETURN collect(`__sel_n_tags__cf_el`) AS __sel_n_tags',
    );
  });

  it('update response projects the list', async () => {
    const cypher = await strictOf('update response');
    expect(cypher).toContain('SET n.`name` = $update_name\nWITH n\nCALL {');
    expect(cypher).toContain(
      'RETURN collect(`__sel_n_tags__cf_el`) AS __sel_n_tags',
    );
  });
});

describe('list @cypher fields — warning (default mode only)', () => {
  const run = async (strict: boolean | undefined) => {
    const warn = jest.fn();
    const logger = { warn, debug: jest.fn() };
    const ogm = buildListOgm(recordingDriver([]), strict, logger);
    for (const name of [
      'root typed select',
      'root selectionSet (aliased)',
      'where list equality',
      'nested relationship selectionSet',
      'InterfaceModel fragments',
      'root typed select',
    ])
      await listFieldShapes[name](ogm, UNIT_IDS);
    return warn.mock.calls.map(([m]) => m as string);
  };

  it('warns once per OGM, type and field', async () => {
    const messages = (await run(undefined)).filter((m) =>
      m.includes('@cypher list field'),
    );
    expect(messages).toHaveLength(4);
    for (const field of [
      'ItLfUser.tags',
      'ItLfUser.tagList',
      'ItLfPost.words',
      'ItLfNote.words',
    ])
      expect(messages.filter((m) => m.includes(`"${field}"`))).toHaveLength(1);
    expect(messages[0]).toBe(
      `[OGM] @cypher list field "ItLfUser.tags" resolves to its statement's first row only: ` +
        `a statement that returns one row per element yields a single element (from an unspecified row), not the list. ` +
        'Enable `strict: true` (default in 3.0) to collect every row into the list, as @neo4j/graphql does.',
    );
  });

  it('does not warn for scalar @cypher fields', async () => {
    const messages = await run(undefined);
    expect(messages.some((m) => m.includes('firstTag'))).toBe(false);
  });

  it('strict mode never warns', async () => {
    expect(
      (await run(true)).filter((m) => m.includes('@cypher list field')),
    ).toEqual([]);
  });
});

describe('list @cypher builders', () => {
  it('buildCypherFieldCall asList', () => {
    expect(
      buildCypherFieldCall(
        'RETURN [1, 2] AS xs',
        'n',
        'xs',
        undefined,
        '__sel_n_xs',
        true,
      ),
    ).toBe(
      [
        'CALL {',
        '  WITH n',
        '  CALL {',
        '    WITH n',
        '    WITH n AS this',
        '    RETURN [1, 2] AS xs',
        '  }',
        '  UNWIND `xs` AS `__sel_n_xs__cf_el`',
        '  RETURN collect(`__sel_n_xs__cf_el`) AS __sel_n_xs',
        '}',
      ].join('\n'),
    );
  });

  it('buildCypherFieldCall without asList is unchanged', () => {
    expect(
      buildCypherFieldCall('RETURN 1 AS x', 'n', 'x', undefined, '__a'),
    ).toBe(
      'CALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    RETURN 1 AS x\n  }\n  RETURN head(collect(`x`)) AS __a\n}',
    );
  });

  it('buildInlineCypherFieldExpr with a list column', () => {
    expect(
      buildInlineCypherFieldExpr('RETURN this.xs AS xs', 'n0', 'T.xs', 'xs'),
    ).toBe(
      'COLLECT { WITH n0 AS this\n  CALL {\n    WITH this\n    RETURN this.xs AS xs\n  }\n' +
        '  UNWIND `xs` AS `xs__cf_el`\n  WITH `xs__cf_el` WHERE `xs__cf_el` IS NOT NULL\n  RETURN `xs__cf_el`\n}',
    );
  });

  it('an aggregating list statement is still refused inline', () => {
    expect(() =>
      buildInlineCypherFieldExpr(
        'MATCH (this)--(x) RETURN collect(x.n) AS xs',
        'n0',
        'T.xs',
        'xs',
      ),
    ).toThrow(/aggregates in its statement/);
  });
});
