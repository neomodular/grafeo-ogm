/**
 * v2.8.0 — read selections whose Cypher must stay byte-identical to v2.7.0:
 * connections that select neither `pageInfo` nor `cursor` (Bug 1), and in
 * default mode the known-field shape mismatches (Bug 3) and the typed
 * `where` under a union parent (Bug 2), which 2.x keeps and now warns
 * about. Expected Cypher and params captured from v2.7.0 (4f6a04a).
 */
import {
  CONNECTION_CASES,
  SHAPE_CASES,
  UNION_WHERE_CASES,
  harness,
  serialize,
} from './read-ignored-inputs.byte-identical.cases';

/** v2.7.0 output for each case. */
const V270: Record<string, { cypher: string; params: unknown }> = {
  'selectionSet sort, node + properties': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [x IN apoc.coll.sortMulti([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id` }, properties: e0 { .`stars` }, __sk0: e0.`stars` }], ['__sk0']) | { node: x.node, properties: x.properties }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | 1]) } }",
    params: {},
  },
  'selectionSet sort, aliased keys': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { p: { `es`: [x IN apoc.coll.sortMulti([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { `nd`: n0 { .`id` }, __sk0: n0.`title` }], ['^__sk0']) | { `nd`: x.`nd` }] } }",
    params: {},
  },
  'edges with properties only': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { properties: e0 { .`stars`, .`note` } }] } }',
    params: {},
  },
  'connection selected twice (merged)': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | 1]) } }',
    params: {},
  },
  'strict: connection selected twice': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | 1]) } }',
    params: {},
  },
  'strict: aliased extra edges with node aliases': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { `a`: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { `x`: n0 { .`id` }, `y`: n0 { .`title` } }], `b`: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id` }, properties: e0 { .`stars` } }] } }',
    params: {},
  },
  'default: aliased extra edges merged': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { `a`: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id`, .`title` } }] } }',
    params: {},
  },
  'connection through a union member fragment': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), authorConnection: { edges: [(n0)<-[e1:`LB_WROTE`]-(n1:`LbUser`) | { node: n1 { .`id` } }], totalCount: size([(n0)<-[e1:`LB_WROTE`]-(n1:`LbUser`) | 1]) } }] }",
    params: {},
  },
  'connection through a union member fragment, read policy': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param0)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`title` }], postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE (true AND (n0.`secret` = $param1)) | { node: n0 { .`id` } }] } }",
    params: { param0: false, param1: false },
  },
  'typed connection true': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id`, .`runId`, .`rank`, .`title`, .`secret` }, properties: e0 { .`note`, .`stars` } }] } }',
    params: {},
  },
  'typed edges true + totalCount': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id`, .`runId`, .`rank`, .`title`, .`secret` }, properties: e0 { .`note`, .`stars` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | 1]) } }',
    params: {},
  },
  'typed totalCount only': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`title` = $param0 | 1]) } }',
    params: { param0: 'a' },
  },
  'typed edges node true + properties select': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id`, .`runId`, .`rank`, .`title`, .`secret` }, properties: e0 { .`stars` } }] } }',
    params: {},
  },
  'typed connection object without select': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`title` = $param0 | {  }] } }',
    params: { param0: 'a' },
  },
  'mutation response connection': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nRETURN n { .`id`, postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | 1]) } }',
    params: { param0: 'u1', update_name: 'U' },
  },
  'scalar with a sub-selection': {
    cypher: 'MATCH (n:`LbUser`)\nRETURN n { .`id` }',
    params: {},
  },
  'relationship without a sub-selection': {
    cypher: 'MATCH (n:`LbUser`)\nRETURN n { .`id`, .`posts` }',
    params: {},
  },
  'singular relationship without a sub-selection': {
    cypher: 'MATCH (n:`LbPost`)\nRETURN n { .`id`, .`author` }',
    params: {},
  },
  'connection without a sub-selection': {
    cypher: 'MATCH (n:`LbUser`)\nRETURN n { .`id`, .`postsConnection` }',
    params: {},
  },
  'nested: scalar with a sub-selection': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { posts: [(n)-[:`LB_WROTE`]->(n0:`LbPost`) | n0 { .`id` }] }',
    params: {},
  },
  'connection node: scalar with a sub-selection': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id` } }] } }',
    params: {},
  },
  'edge property with a sub-selection': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { properties: e0 { .`note` } }] } }',
    params: {},
  },
  'union member: scalar with a sub-selection': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: {},
  },
  'union: relationship without a sub-selection': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id`, .`author` }] }",
    params: {},
  },
  'interface: scalar with a sub-selection': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { things: [(n)-[:`LB_HAS_THING`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: {},
  },
  'typed: scalar given an object': {
    cypher: 'MATCH (n:`LbUser`)\nRETURN n { .`id` }',
    params: {},
  },
  'typed: relationship given a number': {
    cypher: 'MATCH (n:`LbUser`)\nRETURN n { .`id` }',
    params: {},
  },
  'typed: relationship object with an unknown key': {
    cypher: 'MATCH (n:`LbUser`)\nRETURN n { .`id` }',
    params: {},
  },
  'typed: edge property given an object': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { properties: e0 { .`note` } }] } }',
    params: {},
  },
  'union parent: relationship where': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id`, author: CASE WHEN n0:`LbPost` THEN head([(n0)<-[:`LB_WROTE`]-(n1:`LbUser`) | n1 { .`id` }]) ELSE null END }] }",
    params: {},
  },
  'union parent: relationship where, read policy': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param0)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id`, author: CASE WHEN n0:`LbPost` THEN head([(n0)<-[:`LB_WROTE`]-(n1:`LbUser`) | n1 { .`id`, .`runId`, .`name`, .`internetConnection`, .`big`, .`at`, .`loc` }]) ELSE null END }] }",
    params: { param0: false },
  },
};

describe.each([
  ['connections without pageInfo / cursor', CONNECTION_CASES],
  ['default mode: shape mismatches', SHAPE_CASES],
  ['default mode: typed where under a union parent', UNION_WHERE_CASES],
] as const)('byte-identical to v2.7.0 — %s', (_label, cases) => {
  it.each(cases)('%s', async (name, opts, run) => {
    const h = harness(opts);
    await run(h.model);
    const { cypher, params } = h.last();
    expect(cypher).toBe(V270[name].cypher);
    expect(serialize(params)).toEqual(V270[name].params);
  });
});
