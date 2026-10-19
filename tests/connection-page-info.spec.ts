/**
 * v2.8.0 — connection `pageInfo` and edge `cursor` (selectionSet and typed
 * select). Pre-2.8.0 both were silently dropped although the generated
 * connection types declare them. Semantics follow upstream `@neo4j/graphql`
 * 5.x for a connection read without `first` / `after`: `cursor` =
 * base64(`arrayconnection:<offset>`), `hasNextPage` / `hasPreviousPage`
 * false, `startCursor` / `endCursor` the first / last edge's cursor. The
 * Cypher runs live in `tests/integration/read-connection-page-info.spec.ts`.
 */
import { OGMError } from '../src/errors';
import { harness } from './read-ignored-inputs.byte-identical.cases';
import { typecheckGenerated } from './helpers/generated-typecheck';
import { typeDefs } from './fixtures/read-paths.fixture';

jest.setTimeout(60_000);

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** The cursor expression the compiler emits for `index` at `d`. */
const cursorCypher = (index: string, d: number) =>
  `'YXJyYXljb25uZWN0aW9u' + head([__cl${d} IN [[__cc${d} IN split(':' + toString(${index}), '') | ` +
  `CASE __cc${d} WHEN ':' THEN 58 ELSE 48 + toInteger(__cc${d}) END]] | ` +
  `reduce(__ca${d} = '', __cn${d} IN [__cg${d} IN range(0, size(__cl${d}) - 1, 3) | ` +
  `[__cl${d}[__cg${d}] * 65536 + coalesce(__cl${d}[__cg${d} + 1], 0) * 256 + coalesce(__cl${d}[__cg${d} + 2], 0), size(__cl${d}) - __cg${d}]] | ` +
  `__ca${d} + substring('${B64}', __cn${d}[0] / 262144, 1) + substring('${B64}', __cn${d}[0] / 4096 % 64, 1) + ` +
  `CASE WHEN __cn${d}[1] > 1 THEN substring('${B64}', __cn${d}[0] / 64 % 64, 1) ELSE '=' END + ` +
  `CASE WHEN __cn${d}[1] > 2 THEN substring('${B64}', __cn${d}[0] % 64, 1) ELSE '=' END)])`;

const PATTERN = '(n)-[e0:`LB_WROTE`]->(n0:`LbPost`)';

async function cypherOf(
  args: Record<string, unknown>,
  opts: { strict?: boolean; policies?: boolean } = {},
) {
  const h = harness(opts);
  await h.model('LbUser').find(args as never);
  return { cypher: h.last().cypher, logger: h.logger };
}

describe('connection pageInfo / cursor — compiled Cypher', () => {
  it('selectionSet: cursor wraps the edges, pageInfo counts the same list', async () => {
    const { cypher } = await cypherOf({
      selectionSet:
        '{ postsConnection { pageInfo { hasNextPage hasPreviousPage startCursor endCursor } edges { cursor node { id } } } }',
    });
    expect(cypher).toBe(
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: ' +
        `head([__ce0 IN [[${PATTERN} | { node: n0 { .\`id\` } }]] | [__ci0 IN range(0, size(__ce0) - 1) | { node: __ce0[__ci0].node, \`cursor\`: ${cursorCypher('__ci0', 0)} }]])` +
        `, \`pageInfo\`: head([__pc0 IN [size([${PATTERN} | 1])] | { \`hasNextPage\`: false, \`hasPreviousPage\`: false, ` +
        `\`startCursor\`: CASE WHEN __pc0 > 0 THEN 'YXJyYXljb25uZWN0aW9uOjA=' END, ` +
        `\`endCursor\`: CASE WHEN __pc0 > 0 THEN ${cursorCypher('__pc0 - 1', 0)} END }]) } }`,
    );
  });

  it('pageInfo without cursors needs no count; with totalCount only', async () => {
    const { cypher } = await cypherOf({
      selectionSet:
        '{ postsConnection { totalCount p: pageInfo { __typename more: hasNextPage } } }',
    });
    expect(cypher).toBe(
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { ' +
        `totalCount: size([${PATTERN} | 1]), \`p\`: { \`__typename\`: 'PageInfo', \`more\`: false } } }`,
    );
  });

  it('a sorted connection: cursors follow the sorted list', async () => {
    const { cypher } = await cypherOf({
      selectionSet:
        '{ postsConnection(sort: [{ node: { title: DESC } }]) { edges { c: cursor } } }',
    });
    expect(cypher).toBe(
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: ' +
        `head([__ce0 IN [[x IN apoc.coll.sortMulti([${PATTERN} | { __sk0: n0.\`title\` }], ['__sk0']) | {}]] | ` +
        `[__ci0 IN range(0, size(__ce0) - 1) | { \`c\`: ${cursorCypher('__ci0', 0)} }]]) } }`,
    );
  });

  it('the typed select compiles to the selectionSet Cypher', async () => {
    const a = await cypherOf({
      selectionSet:
        '{ postsConnection(where: { node: { title: "a" } }) { totalCount pageInfo { hasNextPage hasPreviousPage startCursor endCursor } edges { cursor node { id } } } }',
    });
    const b = await cypherOf({
      select: {
        postsConnection: {
          where: { node: { title: 'a' } },
          select: {
            totalCount: true,
            pageInfo: true,
            edges: { cursor: true, node: { select: { id: true } } },
          },
        },
      },
    });
    expect(b.cypher).toBe(a.cypher);
    const c = await cypherOf({
      select: {
        postsConnection: {
          select: { pageInfo: { select: { endCursor: true } } },
        },
      },
    });
    expect(c.cypher).toContain(
      `\`pageInfo\`: head([__pc0 IN [size([${PATTERN} | 1])] | { \`endCursor\`: CASE WHEN __pc0 > 0 THEN`,
    );
  });

  it('the read policy filters the list cursors and pageInfo count', async () => {
    const { cypher } = await cypherOf(
      {
        selectionSet:
          '{ postsConnection { pageInfo { endCursor } edges { cursor } } }',
      },
      { policies: true },
    );
    const filtered = `${PATTERN} WHERE (true AND (n0.\`secret\` = $param0))`;
    expect(cypher).toContain(`head([__ce0 IN [[${filtered} | {  }]]`);
    expect(cypher).toContain(`head([__pc0 IN [size([${filtered} | 1])]`);
  });

  it('nested connections use depth-suffixed variables', async () => {
    const { cypher } = await cypherOf({
      selectionSet:
        '{ friendsConnection { edges { cursor node { postsConnection { pageInfo { endCursor } edges { cursor } } } } } }',
    });
    expect(cypher).toContain('__ce0');
    expect(cypher).toContain('__ce1');
    expect(cypher).toContain('__pc1');
    expect(cypher).not.toContain('__pc0');
  });

  it('a cursor alias that clashes with another edge key throws', async () => {
    await expect(
      cypherOf({
        selectionSet:
          '{ postsConnection { edges { node: cursor node { id } } } }',
      }),
    ).rejects.toThrow(OGMError);
  });
});

describe('connection pageInfo / cursor — unprojectable selections', () => {
  const CASES: Array<{
    label: string;
    args: Record<string, unknown>;
    message: string;
  }> = [
    {
      label: 'pageInfo without a sub-selection',
      args: { selectionSet: '{ postsConnection { pageInfo } }' },
      message:
        'Field "pageInfo" in selectionSet on type "LbUserPostsConnection" is an object (PageInfo) and needs a sub-selection, e.g. "pageInfo { hasNextPage endCursor }".',
    },
    {
      label: 'unknown PageInfo field',
      args: { selectionSet: '{ postsConnection { pageInfo { nope } } }' },
      message: 'Unknown field "nope" in selectionSet on type "PageInfo".',
    },
    {
      label: 'PageInfo scalar with a sub-selection',
      args: {
        selectionSet: '{ postsConnection { pageInfo { endCursor { x } } } }',
      },
      message:
        'Field "endCursor" in selectionSet on type "PageInfo" is a scalar field (String) and takes no sub-selection: select it as "endCursor".',
    },
    {
      label: 'cursor with a sub-selection',
      args: { selectionSet: '{ postsConnection { edges { cursor { x } } } }' },
      message:
        'Field "cursor" in selectionSet on type "LbUserPostsRelationship" is a scalar field (String) and takes no sub-selection: select it as "cursor".',
    },
    {
      label: 'typed pageInfo object without select',
      args: {
        select: {
          postsConnection: { select: { pageInfo: { endCursor: true } } },
        },
      },
      message:
        'Field "pageInfo" in select on type "LbUserPostsConnection" is an object (PageInfo): select it with `pageInfo: true` or `pageInfo: { select: { hasNextPage: true, … } }`.',
    },
    {
      label: 'typed unknown PageInfo field',
      args: {
        select: {
          postsConnection: { select: { pageInfo: { select: { nope: true } } } },
        },
      },
      message: 'Unknown field "nope" in select on type "PageInfo".',
    },
    {
      label: 'typed cursor given an object',
      args: {
        select: {
          postsConnection: { select: { edges: { cursor: { select: {} } } } },
        },
      },
      message:
        'Field "cursor" in select on type "LbUserPostsRelationship" is a scalar field (String) and takes no sub-selection: select it with `cursor: true`.',
    },
  ];

  it.each(CASES.map((c) => [c.label, c] as const))(
    '%s: default warns once and leaves it out',
    async (_label, c) => {
      const h = harness();
      await h.model('LbUser').find(c.args as never);
      await h.model('LbUser').find(c.args as never);
      // The selection is left out: no cursor, no PageInfo field (an
      // emptied `pageInfo` projects as an empty map).
      expect(h.last().cypher).not.toMatch(
        /`(cursor|nope|endCursor|hasNextPage)`/,
      );
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      const warning = String(h.logger.warn.mock.calls[0][0]);
      expect(warning).toContain('2.x leaves it out of the result.');
      expect(warning).toContain('Enable `strict: true` (default in 3.0)');
    },
  );

  it.each(CASES.map((c) => [c.label, c] as const))(
    '%s: strict throws',
    async (_label, c) => {
      const h = harness({ strict: true });
      await expect(h.model('LbUser').find(c.args as never)).rejects.toThrow(
        new OGMError(c.message),
      );
    },
  );
});

describe('generated select types offer pageInfo and cursor', () => {
  it('compiles user code selecting them', async () => {
    const { generated, errors } = await typecheckGenerated(
      typeDefs,
      `
import type { OGM } from 'grafeo-ogm';
import type { ModelMap, InterfaceModelMap } from './generated';
declare const ogm: OGM<ModelMap, InterfaceModelMap>;
async function run() {
  await ogm.model('LbUser').find({
    select: {
      postsConnection: {
        select: {
          pageInfo: true,
          edges: { cursor: true, node: { select: { id: true } } },
        },
      },
      friendsConnection: {
        select: { pageInfo: { select: { endCursor: true, hasNextPage: true } } },
      },
    },
  });
  await ogm.model('LbUser').find({
    select: {
      // @ts-expect-error — not a PageInfo field
      postsConnection: { select: { pageInfo: { select: { nope: true } } } },
    },
  });
}
void run;
`,
    );
    expect(errors).toEqual([]);
    expect(generated).toContain('cursor?: boolean;');
    expect(generated).toContain(
      'pageInfo?: boolean | { select: { hasNextPage?: boolean; hasPreviousPage?: boolean; startCursor?: boolean; endCursor?: boolean } };',
    );
  });
});
