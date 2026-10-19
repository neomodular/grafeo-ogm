/**
 * v2.7.0 — connection `sort` in a selectionSet (#25) must not change any
 * selection that compiled before it. Representative connection selections
 * (with `where`, `totalCount`, aliases, a read policy, an interface target,
 * depth 2, strict mode and a mutation response) and the typed `orderBy`
 * compile to the Cypher and params below, captured from v2.6.3 (f6325c0).
 */
import { isInt, type Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { policies, typeDefs } from './fixtures/read-paths.fixture';

type Opts = { policies?: boolean; strict?: boolean };
type ModelOf = (name: string) => ReturnType<OGM['model']>;

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
    last: () => {
      const calls = session.run.mock.calls;
      const call = calls[calls.length - 1];
      return {
        cypher: call[0] as string,
        params: call[1] as Record<string, unknown>,
      };
    },
  };
}

/** Params as JSON, neo4j Integers as `{ $int: "<value>" }`. */
const serialize = (params: Record<string, unknown>): unknown =>
  JSON.parse(
    JSON.stringify(params, (_k, v: unknown) =>
      isInt(v) ? { $int: v.toString() } : v,
    ),
  );

const find =
  (selectionSet: string) =>
  (m: ModelOf): Promise<unknown> =>
    m('LbUser').find({ selectionSet });

const CASES: Array<[string, Opts, (m: ModelOf) => Promise<unknown>]> = [
  [
    'connection edges + totalCount',
    {},
    find(
      '{ id postsConnection { totalCount edges { node { id title } properties { stars } } } }',
    ),
  ],
  [
    'connection where node + edge',
    {},
    find(
      '{ postsConnection(where: { node: { title: "a" }, edge: { stars_GTE: 2 } }) { totalCount edges { properties { note } node { id } } } }',
    ),
  ],
  [
    'connection aliases',
    {},
    find(
      '{ pc: postsConnection(where: { edge: { stars: 5 } }) { n: totalCount es: edges { nd: node { i: id } pr: properties { s: stars } } } }',
    ),
  ],
  [
    'connection totalCount only',
    {},
    find('{ postsConnection(where: { node: { rank_GT: 1 } }) { totalCount } }'),
  ],
  [
    'connection with read policy',
    { policies: true },
    find(
      '{ postsConnection(where: { edge: { stars_GTE: 2 } }) { totalCount edges { node { id } } } }',
    ),
  ],
  [
    'interface-target connection',
    {},
    find('{ thingsConnection { totalCount edges { node { id rank } } } }'),
  ],
  [
    'nested connection depth 2',
    {},
    find(
      '{ friendsConnection { edges { node { id postsConnection(where: { node: { title: "x" } }) { totalCount edges { node { id } } } } } } }',
    ),
  ],
  [
    'relationship options.sort',
    {},
    find(
      '{ posts(options: { sort: [{ rank: DESC }, { title: ASC }], limit: 2 }) { id } }',
    ),
  ],
  [
    'strict connection aliases',
    { strict: true },
    find(
      '{ pc: postsConnection(where: { edge: { stars: 5 } }) { n: totalCount es: edges { nd: node { i: id } pr: properties { s: stars } } } }',
    ),
  ],
  [
    'strict extra edges',
    { strict: true },
    find(
      '{ postsConnection { totalCount a: edges { node { id } } b: edges { properties { stars } } } }',
    ),
  ],
  [
    'mutation response selectionSet',
    {},
    (m) =>
      m('LbUser').create({
        input: [{ id: 'u1', name: 'U' }],
        selectionSet:
          '{ lbUsers { id postsConnection(where: { edge: { stars_GT: 1 } }) { totalCount edges { node { id } properties { stars } } } } }',
      }),
  ],
  [
    'typed select orderBy',
    {},
    (m) =>
      m('LbUser').find({
        select: {
          id: true,
          postsConnection: {
            where: { edge: { stars_GTE: 1 } },
            orderBy: [{ edge: { stars: 'DESC' } }, { node: { title: 'ASC' } }],
            select: {
              totalCount: true,
              edges: {
                node: { select: { id: true } },
                properties: { select: { stars: true } },
              },
            },
          },
        },
      }),
  ],
];

/** v2.6.3 output for each case. */
const V263: Record<string, { cypher: string; params: unknown }> = {
  'connection edges + totalCount': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { .`id`, postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id`, .`title` }, properties: e0 { .`stars` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | 1]) } }',
    params: {},
  },
  'connection where node + edge': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`title` = $param0 AND e0.`stars` >= $param1 | { node: n0 { .`id` }, properties: e0 { .`note` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`title` = $param0 AND e0.`stars` >= $param1 | 1]) } }',
    params: { param0: 'a', param1: 2 },
  },
  'connection aliases': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { pc: { `es`: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE e0.`stars` = $param0 | { `nd`: n0 { `i`: n0.`id` }, `pr`: e0 { `s`: e0.`stars` } }], `n`: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE e0.`stars` = $param0 | 1]) } }',
    params: { param0: 5 },
  },
  'connection totalCount only': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`rank` > $param0 | 1]) } }',
    params: { param0: 1 },
  },
  'connection with read policy': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE (true AND (n0.`secret` = $param0)) AND e0.`stars` >= $param1 | { node: n0 { .`id` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE (true AND (n0.`secret` = $param0)) AND e0.`stars` >= $param1 | 1]) } }',
    params: { param0: false, param1: 2 },
  },
  'interface-target connection': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { thingsConnection: { edges: [(n)-[e0:`LB_HAS_THING`]->(n0) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id`, .`rank` } }], totalCount: size([(n)-[e0:`LB_HAS_THING`]->(n0) | 1]) } }",
    params: {},
  },
  'nested connection depth 2': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { friendsConnection: { edges: [(n)-[e0:`LB_FRIEND`]->(n0:`LbUser`) | { node: n0 { .`id`, postsConnection: { edges: [(n0)-[e1:`LB_WROTE`]->(n1:`LbPost`) WHERE n1.`title` = $param0 | { node: n1 { .`id` } }], totalCount: size([(n0)-[e1:`LB_WROTE`]->(n1:`LbPost`) WHERE n1.`title` = $param0 | 1]) } } }] } }',
    params: { param0: 'x' },
  },
  'relationship options.sort': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { posts: [__sk IN apoc.coll.sortMulti([(n)-[:`LB_WROTE`]->(n0:`LbPost`) | { __node: n0 { .`id` }, __sk0: n0.`rank`, __sk1: n0.`title` }], ['__sk0', '^__sk1']) | __sk.__node][..$sel_param0] }",
    params: { sel_param0: { $int: '2' } },
  },
  'strict connection aliases': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { pc: { `es`: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE e0.`stars` = $param0 | { `nd`: n0 { `i`: n0.`id` }, `pr`: e0 { `s`: e0.`stars` } }], `n`: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE e0.`stars` = $param0 | 1]) } }',
    params: { param0: 5 },
  },
  'strict extra edges': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { `a`: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id` } }], `b`: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { properties: e0 { .`stars` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | 1]) } }',
    params: {},
  },
  'mutation response selectionSet': {
    cypher:
      'CREATE (n:`LbUser` { `id`: $create0_id, `name`: $create0_name })\nRETURN n { .`id`, postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE e0.`stars` > $param0 | { node: n0 { .`id` }, properties: e0 { .`stars` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE e0.`stars` > $param0 | 1]) } }',
    params: { create0_id: 'u1', create0_name: 'U', param0: 1 },
  },
  'typed select orderBy': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { .`id`, postsConnection: { edges: [x IN apoc.coll.sortMulti([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE e0.`stars` >= $param0 | { node: n0 { .`id` }, properties: e0 { .`stars` }, __sk0: e0.`stars`, __sk1: n0.`title` }], ['__sk0', '^__sk1']) | { node: x.node, properties: x.properties }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE e0.`stars` >= $param0 | 1]) } }",
    params: { param0: 1 },
  },
};

describe('connection selections are byte-identical to v2.6.3 (v2.7.0)', () => {
  it.each(CASES)('%s', async (name, opts, run) => {
    const h = harness(opts);
    await run(h.model);
    const { cypher, params } = h.last();
    expect(cypher).toBe(V263[name].cypher);
    expect(serialize(params)).toEqual(V263[name].params);
  });
});
