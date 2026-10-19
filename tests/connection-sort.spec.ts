/**
 * v2.7.0 — `sort` on connection fields in a selectionSet (#25).
 *
 * Pre-2.5.0 `xConnection(sort: …)` was silently dropped; 2.5.0–2.6.x threw
 * "Unsupported argument". It now takes the typed connection `orderBy`
 * entries (`{ node: { … } }` / `{ edge: { … } }`) and compiles through the
 * very same `apoc.coll.sortMulti` path: every case below asserts the
 * selectionSet form compiles to byte-identical Cypher AND params as the
 * equivalent typed `select`. The real ordering (APOC) is pinned live in
 * `tests/integration/connection-sort.spec.ts`.
 */
import type { Driver } from 'neo4j-driver';
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';
import { policies, typeDefs } from './fixtures/read-paths.fixture';

type Opts = { policies?: boolean; strict?: boolean };
type ModelOf = (name: string) => ReturnType<OGM['model']>;
type Compiled = { cypher: string; params: Record<string, unknown> };

function harness(opts: Opts = {}) {
  const session = {
    run: jest.fn().mockResolvedValue({
      records: [],
      summary: { counters: { updates: () => ({}) } },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const driver = {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
  const ogm = new OGM({
    typeDefs,
    driver,
    ...(opts.policies ? { policies } : {}),
    ...(opts.strict ? { strict: true } : {}),
  });
  const bound = opts.policies ? ogm.withContext({}) : ogm;
  return {
    model: ((name: string) => bound.model(name)) as ModelOf,
    last: (): Compiled => {
      const calls = session.run.mock.calls;
      const call = calls[calls.length - 1];
      return {
        cypher: call[0] as string,
        params: call[1] as Record<string, unknown>,
      };
    },
  };
}

async function compile(
  run: (m: ModelOf) => Promise<unknown>,
  opts: Opts = {},
): Promise<Compiled> {
  const h = harness(opts);
  await run(h.model);
  return h.last();
}

/** The selectionSet run and the typed run compile to the same statement. */
async function expectSameAsTyped(
  selectionSetRun: (m: ModelOf) => Promise<unknown>,
  typedRun: (m: ModelOf) => Promise<unknown>,
  opts: Opts = {},
): Promise<Compiled> {
  const fromString = await compile(selectionSetRun, opts);
  const typed = await compile(typedRun, opts);
  expect(fromString.cypher).toBe(typed.cypher);
  expect(fromString.params).toEqual(typed.params);
  expect(fromString.cypher).toContain('apoc.coll.sortMulti');
  return fromString;
}

const findSet =
  (selectionSet: string, model = 'LbUser') =>
  (m: ModelOf) =>
    m(model).find({ selectionSet });
const findTyped =
  (select: Record<string, unknown>, model = 'LbUser') =>
  (m: ModelOf) =>
    m(model).find({ select } as never);

describe('selectionSet connection sort compiles exactly as typed orderBy (v2.7.0)', () => {
  it('edge sort ASC', async () => {
    const { cypher } = await expectSameAsTyped(
      findSet(
        '{ postsConnection(sort: [{ edge: { stars: ASC } }]) { edges { properties { stars } node { id } } } }',
      ),
      findTyped({
        postsConnection: {
          orderBy: [{ edge: { stars: 'ASC' } }],
          select: {
            edges: {
              properties: { select: { stars: true } },
              node: { select: { id: true } },
            },
          },
        },
      }),
    );
    expect(cypher).toBe(
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [x IN apoc.coll.sortMulti(' +
        '[(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id` }, properties: e0 { .`stars` }, __sk0: e0.`stars` }], ' +
        "['^__sk0']) | { node: x.node, properties: x.properties }] } }",
    );
  });

  it('node sort DESC', async () => {
    await expectSameAsTyped(
      findSet(
        '{ postsConnection(sort: [{ node: { title: DESC } }]) { edges { node { id title } } } }',
      ),
      findTyped({
        postsConnection: {
          orderBy: [{ node: { title: 'DESC' } }],
          select: { edges: { node: { select: { id: true, title: true } } } },
        },
      }),
    );
  });

  it('several mixed entries, and several fields in one entry, keep their order', async () => {
    const { cypher } = await expectSameAsTyped(
      findSet(
        '{ postsConnection(sort: [{ edge: { stars: DESC } }, { node: { title: ASC, rank: DESC } }, { edge: { note: ASC } }]) { edges { node { id } } } }',
      ),
      findTyped({
        postsConnection: {
          orderBy: [
            { edge: { stars: 'DESC' } },
            { node: { title: 'ASC', rank: 'DESC' } },
            { edge: { note: 'ASC' } },
          ],
          select: { edges: { node: { select: { id: true } } } },
        },
      }),
    );
    expect(cypher).toContain(
      "__sk0: e0.`stars`, __sk1: n0.`title`, __sk2: n0.`rank`, __sk3: e0.`note` }], ['__sk0', '^__sk1', '__sk2', '^__sk3'])",
    );
  });

  it('a single entry without a list (GraphQL list coercion), as typed orderBy accepts', async () => {
    await expectSameAsTyped(
      findSet(
        '{ postsConnection(sort: { node: { rank: ASC } }) { edges { node { id } } } }',
      ),
      findTyped({
        postsConnection: {
          orderBy: { node: { rank: 'ASC' } },
          select: { edges: { node: { select: { id: true } } } },
        },
      }),
    );
  });

  it('string directions ("ASC") are accepted like enum values', async () => {
    await expectSameAsTyped(
      findSet(
        '{ postsConnection(sort: [{ node: { rank: "DESC" } }]) { edges { node { id } } } }',
      ),
      findTyped({
        postsConnection: {
          orderBy: [{ node: { rank: 'DESC' } }],
          select: { edges: { node: { select: { id: true } } } },
        },
      }),
    );
  });

  it('with where and totalCount: one filter, the count unsorted', async () => {
    const { cypher, params } = await expectSameAsTyped(
      findSet(
        '{ postsConnection(where: { node: { title: "a" }, edge: { stars_GTE: 2 } }, sort: [{ edge: { stars: DESC } }]) { totalCount edges { node { id } properties { note } } } }',
      ),
      findTyped({
        postsConnection: {
          where: { node: { title: 'a' }, edge: { stars_GTE: 2 } },
          orderBy: [{ edge: { stars: 'DESC' } }],
          select: {
            totalCount: true,
            edges: {
              node: { select: { id: true } },
              properties: { select: { note: true } },
            },
          },
        },
      }),
    );
    const filtered =
      '(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`title` = $param0 AND e0.`stars` >= $param1';
    expect(cypher).toContain(
      `edges: [x IN apoc.coll.sortMulti([${filtered} | { node: n0 { .\`id\` }, properties: e0 { .\`note\` }, __sk0: e0.\`stars\` }], ['__sk0'])`,
    );
    expect(cypher).toContain(`totalCount: size([${filtered} | 1])`);
    expect(params).toEqual({ param0: 'a', param1: 2 });
  });

  it('the argument order (sort before where) does not matter', async () => {
    const a = await compile(
      findSet(
        '{ postsConnection(where: { node: { rank_GT: 1 } }, sort: [{ node: { rank: ASC } }]) { edges { node { id } } } }',
      ),
    );
    const b = await compile(
      findSet(
        '{ postsConnection(sort: [{ node: { rank: ASC } }], where: { node: { rank_GT: 1 } }) { edges { node { id } } } }',
      ),
    );
    expect(b).toEqual(a);
  });

  it('with the target read policy', async () => {
    const { cypher } = await expectSameAsTyped(
      findSet(
        '{ postsConnection(sort: [{ node: { rank: ASC } }]) { totalCount edges { node { id } } } }',
      ),
      findTyped({
        postsConnection: {
          orderBy: [{ node: { rank: 'ASC' } }],
          select: {
            totalCount: true,
            edges: { node: { select: { id: true } } },
          },
        },
      }),
      { policies: true },
    );
    expect(cypher).toContain(
      'apoc.coll.sortMulti([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE (true AND (n0.`secret` = $param0)) |',
    );
  });

  it('nested at depth 2 (a connection inside a connection)', async () => {
    const { cypher } = await expectSameAsTyped(
      findSet(
        '{ friendsConnection(sort: [{ node: { name: ASC } }]) { edges { node { id postsConnection(where: { node: { title: "x" } }, sort: [{ edge: { stars: DESC } }]) { totalCount edges { node { id } } } } } } }',
      ),
      findTyped({
        friendsConnection: {
          orderBy: [{ node: { name: 'ASC' } }],
          select: {
            edges: {
              node: {
                select: {
                  id: true,
                  postsConnection: {
                    where: { node: { title: 'x' } },
                    orderBy: [{ edge: { stars: 'DESC' } }],
                    select: {
                      totalCount: true,
                      edges: { node: { select: { id: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(cypher).toContain(
      "apoc.coll.sortMulti([(n0)-[e1:`LB_WROTE`]->(n1:`LbPost`) WHERE n1.`title` = $param0 | { node: n1 { .`id` }, __sk0: e1.`stars` }], ['__sk0'])",
    );
  });

  it('nested under a relationship field', async () => {
    await expectSameAsTyped(
      findSet(
        '{ friends { id postsConnection(sort: [{ node: { rank: DESC } }]) { edges { node { id } } } } }',
      ),
      findTyped({
        friends: {
          select: {
            id: true,
            postsConnection: {
              orderBy: [{ node: { rank: 'DESC' } }],
              select: { edges: { node: { select: { id: true } } } },
            },
          },
        },
      }),
    );
  });

  it('an interface target (node fields of the interface)', async () => {
    const { cypher } = await expectSameAsTyped(
      findSet(
        '{ thingsConnection(sort: [{ node: { rank: DESC } }]) { edges { node { id rank } } } }',
      ),
      findTyped({
        thingsConnection: {
          orderBy: [{ node: { rank: 'DESC' } }],
          select: { edges: { node: { select: { id: true, rank: true } } } },
        },
      }),
    );
    expect(cypher).toContain(", __sk0: n0.`rank` }], ['__sk0'])");
  });

  it('a union target (a field its members share)', async () => {
    const { cypher } = await expectSameAsTyped(
      findSet(
        '{ itemsConnection(sort: [{ node: { rank: ASC } }]) { edges { node { id } } } }',
      ),
      findTyped({
        itemsConnection: {
          orderBy: [{ node: { rank: 'ASC' } }],
          select: { edges: { node: { select: { id: true } } } },
        },
      }),
    );
    expect(cypher).toContain(
      "apoc.coll.sortMulti([(n)-[e0:`LB_HAS_ITEM`]->(n0) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }, __sk0: n0.`rank` }], ['^__sk0'])",
    );
  });

  it('in a mutation response selectionSet (create)', async () => {
    const input = [{ id: 'u1', name: 'U' }];
    await expectSameAsTyped(
      (m) =>
        m('LbUser').create({
          input,
          selectionSet:
            '{ lbUsers { id postsConnection(where: { edge: { stars_GT: 1 } }, sort: [{ edge: { stars: DESC } }, { node: { title: ASC } }]) { totalCount edges { node { id } properties { stars } } } } }',
        } as never),
      (m) =>
        m('LbUser').create({
          input,
          select: {
            lbUsers: {
              id: true,
              postsConnection: {
                where: { edge: { stars_GT: 1 } },
                orderBy: [
                  { edge: { stars: 'DESC' } },
                  { node: { title: 'ASC' } },
                ],
                select: {
                  totalCount: true,
                  edges: {
                    node: { select: { id: true } },
                    properties: { select: { stars: true } },
                  },
                },
              },
            },
          },
        } as never),
    );
  });

  it('in a mutation response selectionSet (update)', async () => {
    await expectSameAsTyped(
      (m) =>
        m('LbUser').update({
          where: { id: 'u1' },
          update: { name: 'V' },
          selectionSet:
            '{ info { nodesCreated } lbUsers { postsConnection(sort: [{ node: { rank: ASC } }]) { edges { node { id } } } } }',
        } as never),
      (m) =>
        m('LbUser').update({
          where: { id: 'u1' },
          update: { name: 'V' },
          select: {
            lbUsers: {
              postsConnection: {
                orderBy: [{ node: { rank: 'ASC' } }],
                select: { edges: { node: { select: { id: true } } } },
              },
            },
          },
        } as never),
    );
  });

  it('strict mode accepts it and compiles the same', async () => {
    await expectSameAsTyped(
      findSet(
        '{ postsConnection(sort: [{ edge: { stars: ASC } }, { node: { rank: DESC } }]) { totalCount edges { node { id } } } }',
      ),
      findTyped({
        postsConnection: {
          orderBy: [{ edge: { stars: 'ASC' } }, { node: { rank: 'DESC' } }],
          select: {
            totalCount: true,
            edges: { node: { select: { id: true } } },
          },
        },
      }),
      { strict: true },
    );
  });

  it('an empty sort list leaves the connection unsorted, as typed orderBy: []', async () => {
    const fromString = await compile(
      findSet('{ postsConnection(sort: []) { edges { node { id } } } }'),
    );
    const typed = await compile(
      findTyped({
        postsConnection: {
          orderBy: [],
          select: { edges: { node: { select: { id: true } } } },
        },
      }),
    );
    expect(fromString).toEqual(typed);
    expect(fromString.cypher).not.toContain('sortMulti');
  });
});

describe('selectionSet connection sort with aliases (v2.7.0)', () => {
  it('sorts under the aliased connection, edges, node and properties keys', async () => {
    const { cypher } = await compile(
      findSet(
        '{ pc: postsConnection(sort: [{ edge: { stars: DESC } }]) { n: totalCount es: edges { nd: node { i: id } pr: properties { s: stars } } } }',
      ),
    );
    expect(cypher).toBe(
      'MATCH (n:`LbUser`)\nRETURN n { pc: { `es`: [x IN apoc.coll.sortMulti(' +
        '[(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { `nd`: n0 { `i`: n0.`id` }, `pr`: e0 { `s`: e0.`stars` }, __sk0: e0.`stars` }], ' +
        "['__sk0']) | { `nd`: x.`nd`, `pr`: x.`pr` }], `n`: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | 1]) } }",
    );
  });

  it('two aliases of one connection sort independently', async () => {
    const { cypher } = await compile(
      findSet(
        '{ up: postsConnection(sort: [{ node: { rank: ASC } }]) { edges { node { id } } } down: postsConnection(sort: [{ node: { rank: DESC } }]) { edges { node { id } } } }',
      ),
    );
    expect(cypher).toContain('up: { edges: [x IN apoc.coll.sortMulti(');
    expect(cypher).toContain("['^__sk0']) | { node: x.node }] }");
    expect(cypher).toContain('down: { edges: [x IN apoc.coll.sortMulti(');
    expect(cypher).toContain("['__sk0']) | { node: x.node }] }");
  });

  it('the same key selected twice with the same sort merges', async () => {
    const { cypher } = await compile(
      findSet(
        '{ postsConnection(sort: [{ node: { rank: ASC } }]) { edges { node { id } } } postsConnection(sort: [{ node: { rank: ASC } }]) { totalCount } }',
      ),
    );
    expect(cypher).toContain(
      "postsConnection: { edges: [x IN apoc.coll.sortMulti([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id` }, __sk0: n0.`rank` }], ['^__sk0']) | { node: x.node }], totalCount: size(",
    );
  });
});

describe('selectionSet connection sort through an inline fragment (v2.7.0)', () => {
  it('sorts the implementer connection and checks its fields', async () => {
    const { cypher } = await compile(
      findSet(
        '{ things { ... on LbPost { authorConnection(sort: [{ node: { name: DESC } }]) { edges { node { id } } } } } }',
      ),
    );
    expect(cypher).toContain(
      "WHEN n0:`LbPost` THEN { edges: [x IN apoc.coll.sortMulti([(n0)<-[e1:`LB_WROTE`]-(n1:`LbUser`) | { node: n1 { .`id` }, __sk0: n1.`name` }], ['__sk0']) | { node: x.node }] }",
    );
    await expect(
      compile(
        findSet(
          '{ things { ... on LbPost { authorConnection(sort: [{ node: { title: DESC } }]) { edges { node { id } } } } } }',
        ),
      ),
    ).rejects.toThrow(
      /Invalid sort node field "title" on connection "authorConnection"\. Field must be a scalar property of LbUser\./,
    );
  });
});

describe('selectionSet connection sort validation (v2.7.0)', () => {
  const find = (selectionSet: string, opts: Opts = {}) =>
    compile(findSet(selectionSet), opts);

  it('rejects an unknown node sort field', async () => {
    await expect(
      find(
        '{ postsConnection(sort: [{ node: { nope: ASC } }]) { edges { node { id } } } }',
      ),
    ).rejects.toThrow(
      new OGMError(
        'Invalid sort node field "nope" on connection "postsConnection". Field must be a scalar property of LbPost.',
      ),
    );
  });

  it('rejects an unknown edge sort field', async () => {
    await expect(
      find(
        '{ postsConnection(sort: [{ edge: { nope: DESC } }]) { edges { node { id } } } }',
      ),
    ).rejects.toThrow(
      new OGMError(
        'Invalid sort edge field "nope" on connection "postsConnection". Field must be a scalar property of relationship type "LbWrote".',
      ),
    );
  });

  it('rejects an edge sort on a relationship without properties', async () => {
    await expect(
      find(
        '{ friendsConnection(sort: [{ edge: { since: ASC } }]) { edges { node { id } } } }',
      ),
    ).rejects.toThrow(
      new OGMError(
        'Invalid sort on connection "friendsConnection": relationship has no @relationshipProperties, ' +
          'so "edge" sort keys are not available. Use { node: { ... } } instead.',
      ),
    );
  });

  it('rejects an invalid direction', async () => {
    await expect(
      find(
        '{ postsConnection(sort: [{ node: { rank: UP } }]) { edges { node { id } } } }',
      ),
    ).rejects.toThrow(
      new OGMError('Invalid sort direction "UP". Must be "ASC" or "DESC".'),
    );
    await expect(
      find(
        '{ postsConnection(sort: [{ node: { rank: null } }]) { edges { node { id } } } }',
      ),
    ).rejects.toThrow(/Invalid sort direction "null"/);
  });

  it('rejects an unknown scope and an entry with both scopes', async () => {
    await expect(
      find(
        '{ postsConnection(sort: [{ nodes: { rank: ASC } }]) { edges { node { id } } } }',
      ),
    ).rejects.toThrow(
      /Invalid sort scope "nodes" on connection "postsConnection"/,
    );
    await expect(
      find(
        '{ postsConnection(sort: [{ node: { rank: ASC }, edge: { stars: ASC } }]) { edges { node { id } } } }',
      ),
    ).rejects.toThrow(
      /Invalid sort entry on connection "postsConnection"\. Each entry must have exactly one of "node" or "edge"/,
    );
  });

  it('rejects a non-object entry or scope value', async () => {
    await expect(
      find('{ postsConnection(sort: ASC) { edges { node { id } } } }'),
    ).rejects.toThrow(
      new OGMError(
        'Invalid sort entry on connection "postsConnection". ' +
          'Each entry must be an object like { node: { field: ASC } } or { edge: { field: DESC } }.',
      ),
    );
    await expect(
      find('{ postsConnection(sort: null) { edges { node { id } } } }'),
    ).rejects.toThrow(/Invalid sort entry on connection "postsConnection"/);
    await expect(
      find(
        '{ postsConnection(sort: [{ node: DESC }]) { edges { node { id } } } }',
      ),
    ).rejects.toThrow(
      /Invalid sort "node" value on connection "postsConnection"\. Expected an object like \{ field: ASC \}/,
    );
  });

  it('rejects $variables', async () => {
    await expect(
      find('{ postsConnection(sort: $s) { edges { node { id } } } }'),
    ).rejects.toThrow(
      /GraphQL variables are not supported in selectionSet arguments \(postsConnection\(sort\): \$s\)/,
    );
    await expect(
      find(
        '{ postsConnection(sort: [{ node: { rank: $d } }]) { edges { node { id } } } }',
      ),
    ).rejects.toThrow(OGMError);
  });

  it('rejects an unsafe field name', async () => {
    await expect(
      find(
        '{ postsConnection(sort: [{ node: { __proto__: ASC } }]) { edges { node { id } } } }',
      ),
    ).rejects.toThrow(OGMError);
  });

  it('checks the schema in strict mode too', async () => {
    await expect(
      find(
        '{ postsConnection(sort: [{ node: { nope: ASC } }]) { edges { node { id } } } }',
        { strict: true },
      ),
    ).rejects.toThrow(/Invalid sort node field "nope"/);
  });

  it('strict: refuses sort with `edges` under several response keys', async () => {
    await expect(
      find(
        '{ postsConnection(sort: [{ node: { rank: ASC } }]) { a: edges { node { id } } b: edges { properties { stars } } } }',
        { strict: true },
      ),
    ).rejects.toThrow(
      /sort on "postsConnection" is not supported with `edges` selected under several response keys/,
    );
  });

  it('shape errors throw when the selectionSet setter parses; schema errors when compiled', () => {
    const h = harness();
    const model = h.model('LbUser');
    expect(() => {
      model.selectionSet =
        '{ postsConnection(sort: [{ node: { rank: SIDEWAYS } }]) { edges { node { id } } } }';
    }).toThrow(/Invalid sort direction "SIDEWAYS"/);
    expect(() => {
      model.selectionSet =
        '{ id postsConnection(sort: [{ edge: { stars: DESC } }]) { edges { node { id } } } }';
    }).not.toThrow();
  });

  it('sort stays unsupported on relationship fields (options.sort is the way)', async () => {
    await expect(
      find('{ posts(sort: [{ rank: ASC }]) { id } }'),
    ).rejects.toThrow(
      new OGMError(
        'Unsupported argument "sort" on selectionSet field "posts". ' +
          'Supported: where and options (sort, limit, offset) on relationship fields, ' +
          'where and directed on relationship aggregates (<field>Aggregate), where and sort on connection fields.',
      ),
    );
  });
});

describe('unsupported connection arguments name the alternatives (v2.7.0)', () => {
  it('first / after / options on a connection', async () => {
    const expected = (arg: string) =>
      new OGMError(
        `Unsupported argument "${arg}" on selectionSet field "postsConnection". ` +
          'Supported: where and options (sort, limit, offset) on relationship fields, ' +
          'where and directed on relationship aggregates (<field>Aggregate), where and sort on connection fields. ' +
          'The typed select API takes the same connection arguments: ' +
          'select: { postsConnection: { where: {...}, orderBy: [...], select: {...} } }. ' +
          'To page, select the relationship field instead: posts(options: { offset, limit }). ' +
          'Before 2.5.0 the argument was ignored; remove it to keep that result.',
      );
    for (const arg of ['first', 'after', 'options'])
      await expect(
        compile(
          findSet(`{ postsConnection(${arg}: 1) { edges { node { id } } } }`),
        ),
      ).rejects.toThrow(expected(arg));
  });

  it('the message agrees with <rel>Aggregate arguments (where, directed)', async () => {
    await expect(
      compile(
        findSet(
          '{ postsAggregate(sort: [{ node: { rank: ASC } }]) { count } }',
        ),
      ),
    ).rejects.toThrow(
      /Unsupported argument "sort" on selectionSet field "postsAggregate"\. .*where and directed on relationship aggregates/,
    );
    const ok = await compile(
      findSet(
        '{ postsAggregate(where: { title: "a" }, directed: false) { count } postsConnection(sort: [{ node: { rank: ASC } }]) { totalCount } }',
      ),
    );
    expect(ok.cypher).toContain('postsAggregate');
  });

  it('arguments on connection sub-fields still throw', async () => {
    await expect(
      compile(
        findSet('{ postsConnection { edges(first: 1) { node { id } } } }'),
      ),
    ).rejects.toThrow(
      new OGMError(
        'Unsupported argument "first" on "postsConnection.edges". ' +
          'selectionSet arguments are supported only on relationship fields (where, options), ' +
          'relationship aggregates (where, directed) and connection fields (where, sort).',
      ),
    );
  });
});
