/**
 * v2.12.0 — a union MEMBER key in a where on a union target
 * (`items: { where: { LbDoc: { rank: 2 } } }`, `itemsConnection`
 * `{ node: { LbDoc: … } }` in a selection or a root filter, the upstream
 * member-keyed `{ LbDoc: { node: … } }` connection shape, and
 * `itemsAggregate(where)`) compiles against that member —
 * `(v:LbDoc AND v.rank = $p)`, OR-combined across members — with each
 * member's read policy composed outside any negation, in default and
 * strict mode alike.
 *
 * Pre-2.12.0 the member key compiled as a node property
 * (`n0.LbDoc = $param`), so the filter never matched (and `_NONE` /
 * `_NOT` matched everything), or, for the upstream shape in a root
 * filter, was ignored. Where inputs that already worked compile
 * byte-identically to v2.10.0 (74dea63).
 */
import { Model } from '../src/model';
import { harness, serialize } from './read-ignored-inputs.byte-identical.cases';
import {
  UNCHANGED_WHERE_CASES,
  UNION_MEMBER_WHERE_CASES,
} from './union-member-where.cases';

type Expected = { cypher: string; params: unknown };

beforeEach(() => Model.clearSelectionCache());

/** Default-mode output, without policies. */
const DEFAULT: Record<string, Expected> = {
  'typed select items where': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE (n0:`LbDoc` AND n0.`rank` = $param0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2 },
  },
  'selectionSet items(where)': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE (n0:`LbDoc` AND n0.`rank` = $param0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2 },
  },
  'typed select items where, two members': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0) OR (n0:`LbPost` AND n0.`title` = $param1)) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: 'a' },
  },
  'typed select itemsConnection where node': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { edges: [(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0:`LbDoc` AND n0.`rank` = $param0) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id`, .`runId`, .`rank`, .`title`, .`secret` } }], totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0:`LbDoc` AND n0.`rank` = $param0) | 1]) } }",
    params: { param0: 2 },
  },
  'selectionSet itemsConnection(where: { node })': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { edges: [(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0:`LbDoc` AND n0.`rank` = $param0) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` } }], totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0:`LbDoc` AND n0.`rank` = $param0) | 1]) } }",
    params: { param0: 2 },
  },
  'selectionSet itemsConnection(where: { node_NOT })': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE NOT ((n0:`LbDoc` AND n0.`rank` = $param0)) | 1]) } }',
    params: { param0: 2 },
  },
  'selectionSet itemsConnection upstream member shape': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0:`LbDoc` AND n0.`rank` = $param0) | 1]) } }',
    params: { param0: 2 },
  },
  'root itemsConnection_SOME { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (r0:`LbDoc` AND r0.`rank` = $param1) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (r0:`LbDoc` AND r0.`rank` = $param1) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_NONE { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (r0:`LbDoc` AND r0.`rank` = $param1) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_NOT { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (r0:`LbDoc` AND r0.`rank` = $param1) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_SINGLE { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE size([(n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (r0:`LbDoc` AND r0.`rank` = $param1) | 1]) = 1\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_ALL { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE NOT ((r0:`LbDoc` AND r0.`rank` = $param1)) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_SOME { node_NOT }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE NOT ((r0:`LbDoc` AND r0.`rank` = $param1)) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_SOME upstream member shape': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (r0:`LbDoc` AND r0.`rank` = $param1) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_NONE upstream member shape, two members': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1) OR (r0:`LbPost` AND r0.`title` = $param2)) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: 'a' },
  },
  'selectionSet itemsAggregate(where)': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsAggregate: { `count`: COUNT { (n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0:`LbDoc` AND n0.`rank` = $param0) } } }',
    params: { param0: 2 },
  },
};
/** Default-mode output, with policies (the LbPost read policy applies per member, outside any negation). */
const DEFAULT_POLICIES: Record<string, Expected> = {
  'typed select items where': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: false },
  },
  'selectionSet items(where)': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: false },
  },
  'typed select items where, two members': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE (((n0:`LbDoc` AND n0.`rank` = $param0) OR (n0:`LbPost` AND n0.`title` = $param1))) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param2)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: 'a', param2: false },
  },
  'typed select itemsConnection where node': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { edges: [(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id`, .`runId`, .`rank`, .`title`, .`secret` } }], totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | 1]) } }",
    params: { param0: 2, param1: false },
  },
  'selectionSet itemsConnection(where: { node })': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { edges: [(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` } }], totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | 1]) } }",
    params: { param0: 2, param1: false },
  },
  'selectionSet itemsConnection(where: { node_NOT })': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param0)))) AND NOT ((n0:`LbDoc` AND n0.`rank` = $param1)) | 1]) } }',
    params: { param0: false, param1: 2 },
  },
  'selectionSet itemsConnection upstream member shape': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0:`LbDoc` AND n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | 1]) } }',
    params: { param0: 2, param1: false },
  },
  'root itemsConnection_SOME { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_NONE { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_NOT { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_SINGLE { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE size([(n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) | 1]) = 1\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_ALL { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) AND NOT ((r0:`LbDoc` AND r0.`rank` = $param1)) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_SOME { node_NOT }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (NOT ((r0:`LbDoc` AND r0.`rank` = $param1))) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_SOME upstream member shape': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_NONE upstream member shape, two members': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (((r0:`LbDoc` AND r0.`rank` = $param1) OR (r0:`LbPost` AND r0.`title` = $param2))) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param3)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: 'a', param3: false },
  },
  'selectionSet itemsAggregate(where)': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsAggregate: { `count`: COUNT { (n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) } } }',
    params: { param0: 2, param1: false },
  },
};
/** Strict output, without and with policies: the default filter AND the strict member restriction of the union target. */
const STRICT: Record<string, Expected> = {
  'typed select items where': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND (n0:`LbPost` OR n0:`LbDoc`) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2 },
  },
  'selectionSet items(where)': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND (n0:`LbPost` OR n0:`LbDoc`) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2 },
  },
  'typed select items where, two members': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE (((n0:`LbDoc` AND n0.`rank` = $param0) OR (n0:`LbPost` AND n0.`title` = $param1))) AND (n0:`LbPost` OR n0:`LbDoc`) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: 'a' },
  },
  'typed select itemsConnection where node': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { edges: [(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND (n0:`LbPost` OR n0:`LbDoc`) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id`, .`runId`, .`rank`, .`title`, .`secret` } }], totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND (n0:`LbPost` OR n0:`LbDoc`) | 1]) } }",
    params: { param0: 2 },
  },
  'selectionSet itemsConnection(where: { node })': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { edges: [(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND (n0:`LbPost` OR n0:`LbDoc`) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` } }], totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND (n0:`LbPost` OR n0:`LbDoc`) | 1]) } }",
    params: { param0: 2 },
  },
  'selectionSet itemsConnection(where: { node_NOT })': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0:`LbPost` OR n0:`LbDoc`) AND NOT ((n0:`LbDoc` AND n0.`rank` = $param0)) | 1]) } }',
    params: { param0: 2 },
  },
  'selectionSet itemsConnection upstream member shape': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0:`LbDoc` AND n0.`rank` = $param0) AND (n0:`LbPost` OR n0:`LbDoc`) | 1]) } }',
    params: { param0: 2 },
  },
  'root itemsConnection_SOME { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND (r0:`LbPost` OR r0:`LbDoc`) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND (r0:`LbPost` OR r0:`LbDoc`) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_NONE { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND (r0:`LbPost` OR r0:`LbDoc`) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_NOT { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND (r0:`LbPost` OR r0:`LbDoc`) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_SINGLE { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE size([(n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND (r0:`LbPost` OR r0:`LbDoc`) | 1]) = 1\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_ALL { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (r0:`LbPost` OR r0:`LbDoc`) AND NOT ((r0:`LbDoc` AND r0.`rank` = $param1)) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_SOME { node_NOT }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (NOT ((r0:`LbDoc` AND r0.`rank` = $param1))) AND (r0:`LbPost` OR r0:`LbDoc`) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_SOME upstream member shape': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND (r0:`LbPost` OR r0:`LbDoc`) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_NONE upstream member shape, two members': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (((r0:`LbDoc` AND r0.`rank` = $param1) OR (r0:`LbPost` AND r0.`title` = $param2))) AND (r0:`LbPost` OR r0:`LbDoc`) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: 'a' },
  },
  'selectionSet itemsAggregate(where)': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsAggregate: { `count`: COUNT { (n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND (n0:`LbPost` OR n0:`LbDoc`) } } }',
    params: { param0: 2 },
  },
};
const STRICT_POLICIES: Record<string, Expected> = {
  'typed select items where': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: false },
  },
  'selectionSet items(where)': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: false },
  },
  'typed select items where, two members': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE (((n0:`LbDoc` AND n0.`rank` = $param0) OR (n0:`LbPost` AND n0.`title` = $param1))) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param2)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: 'a', param2: false },
  },
  'typed select itemsConnection where node': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { edges: [(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id`, .`runId`, .`rank`, .`title`, .`secret` } }], totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | 1]) } }",
    params: { param0: 2, param1: false },
  },
  'selectionSet itemsConnection(where: { node })': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { edges: [(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` } }], totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | 1]) } }",
    params: { param0: 2, param1: false },
  },
  'selectionSet itemsConnection(where: { node_NOT })': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param0)))) AND NOT ((n0:`LbDoc` AND n0.`rank` = $param1)) | 1]) } }',
    params: { param0: false, param1: 2 },
  },
  'selectionSet itemsConnection upstream member shape': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0:`LbDoc` AND n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | 1]) } }',
    params: { param0: 2, param1: false },
  },
  'root itemsConnection_SOME { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_NONE { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_NOT { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_SINGLE { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE size([(n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) | 1]) = 1\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_ALL { node }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) AND NOT ((r0:`LbDoc` AND r0.`rank` = $param1)) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_SOME { node_NOT }': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (NOT ((r0:`LbDoc` AND r0.`rank` = $param1))) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_SOME upstream member shape': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE ((r0:`LbDoc` AND r0.`rank` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_NONE upstream member shape, two members': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (((r0:`LbDoc` AND r0.`rank` = $param1) OR (r0:`LbPost` AND r0.`title` = $param2))) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param3)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: 'a', param3: false },
  },
  'selectionSet itemsAggregate(where)': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsAggregate: { `count`: COUNT { (n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE ((n0:`LbDoc` AND n0.`rank` = $param0)) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) } } }',
    params: { param0: 2, param1: false },
  },
};

/** v2.10.0 (74dea63) output of already-working where inputs, default mode. */
const V2100: Record<string, Expected> = {
  'root items_SOME member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root items bare member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root items_NONE two member keys': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT (EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 } OR EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r2:`LbPost`) WHERE r2.`title` = $param3 })\nRETURN n { .`id` }',
    params: { param1: 2, param3: 'a' },
  },
  'root items_ALL member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE NOT (r0.`rank` = $param1) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root items_SINGLE member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE size([(n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 | r0]) = 1\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_SOME node shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE r0.`rank` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_NONE node_NOT shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE NOT (r0.`id` = $param1) }\nRETURN n { .`id` }',
    params: { param1: 'x' },
  },
  'typed select items where shared field': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE n0.`rank` = $param0 | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2 },
  },
  'selectionSet items(where) shared field': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE n0.`rank` = $param0 | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2 },
  },
  'selectionSet itemsConnection(where: { node }) shared field': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { edges: [(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE n0.`rank` = $param0 | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` } }], totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE n0.`rank` = $param0 | 1]) } }",
    params: { param0: 2 },
  },
  'selectionSet itemsConnection bare shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE n0.`rank` = $param0 | 1]) } }',
    params: { param0: 2 },
  },
  'selectionSet itemsAggregate(where) shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsAggregate: { `count`: COUNT { (n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE n0.`rank` = $param0 } } }',
    params: { param0: 2 },
  },
  'root posts_SOME': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_WROTE`]->(r0:`LbPost`) WHERE r0.`title` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 'a' },
  },
  'root postsConnection_SOME node + edge': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_WROTE`]->(r0:`LbPost`) WHERE r0.`title` = $param1 AND e0.`stars` = $param2 }\nRETURN n { .`id` }',
    params: { param1: 'a', param2: 3 },
  },
  'root things_SOME (interface)': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_HAS_THING`]->(r0) WHERE r0.`rank` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root thingsConnection_NONE (interface)': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_THING`]->(r0) WHERE r0.`rank` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'typed select posts where': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { posts: [(n)-[:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`title` = $param0 | n0 { .`id` }] }',
    params: { param0: 'a' },
  },
  'typed select things where (interface)': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { things: [(n)-[:`LB_HAS_THING`]->(n0) WHERE n0.`rank` = $param0 | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2 },
  },
  'selectionSet postsConnection(where: node + edge)': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`title` = $param0 AND e0.`stars` = $param1 | { node: n0 { .`id` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`title` = $param0 AND e0.`stars` = $param1 | 1]) } }',
    params: { param0: 'a', param1: 3 },
  },
  'selectionSet thingsConnection(where: { node })': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { thingsConnection: { totalCount: size([(n)-[e0:`LB_HAS_THING`]->(n0) WHERE n0.`rank` = $param0 | 1]) } }',
    params: { param0: 2 },
  },
  'root friends_SOME nested items_SOME member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_FRIEND`]->(r0:`LbUser`) WHERE EXISTS { MATCH (r0)-[:`LB_HAS_ITEM`]->(r1:`LbDoc`) WHERE r1.`rank` = $param2 } }\nRETURN n { .`id` }',
    params: { param2: 2 },
  },
};
/** v2.10.0 (74dea63), default mode with policies. */
const V2100_POLICIES: Record<string, Expected> = {
  'root items_SOME member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root items bare member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root items_NONE two member keys': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT (EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 } OR EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r2:`LbPost`) WHERE (r2.`title` = $param3) AND (true AND (r2.`secret` = $param4)) })\nRETURN n { .`id` }',
    params: { param1: 2, param3: 'a', param4: false },
  },
  'root items_ALL member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE NOT (r0.`rank` = $param1) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root items_SINGLE member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE size([(n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 | r0]) = 1\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_SOME node shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (r0.`rank` = $param1) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_NONE node_NOT shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (NOT (r0.`id` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 'x', param2: false },
  },
  'typed select items where shared field': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: false },
  },
  'selectionSet items(where) shared field': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: false },
  },
  'selectionSet itemsConnection(where: { node }) shared field': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { edges: [(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` } }], totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | 1]) } }",
    params: { param0: 2, param1: false },
  },
  'selectionSet itemsConnection bare shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | 1]) } }',
    params: { param0: 2, param1: false },
  },
  'selectionSet itemsAggregate(where) shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsAggregate: { `count`: COUNT { (n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) } } }',
    params: { param0: 2, param1: false },
  },
  'root posts_SOME': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_WROTE`]->(r0:`LbPost`) WHERE (r0.`title` = $param1) AND (true AND (r0.`secret` = $param2)) }\nRETURN n { .`id` }',
    params: { param1: 'a', param2: false },
  },
  'root postsConnection_SOME node + edge': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_WROTE`]->(r0:`LbPost`) WHERE (r0.`title` = $param1 AND e0.`stars` = $param2) AND (true AND (r0.`secret` = $param3)) }\nRETURN n { .`id` }',
    params: { param1: 'a', param2: 3, param3: false },
  },
  'root things_SOME (interface)': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_HAS_THING`]->(r0) WHERE (r0.`rank` = $param1) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root thingsConnection_NONE (interface)': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_THING`]->(r0) WHERE (r0.`rank` = $param1) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'typed select posts where': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { posts: [(n)-[:`LB_WROTE`]->(n0:`LbPost`) WHERE (n0.`title` = $param0) AND (true AND (n0.`secret` = $param1)) | n0 { .`id` }] }',
    params: { param0: 'a', param1: false },
  },
  'typed select things where (interface)': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { things: [(n)-[:`LB_HAS_THING`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: false },
  },
  'selectionSet postsConnection(where: node + edge)': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE (n0.`title` = $param0) AND (true AND (n0.`secret` = $param1)) AND e0.`stars` = $param2 | { node: n0 { .`id` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE (n0.`title` = $param0) AND (true AND (n0.`secret` = $param1)) AND e0.`stars` = $param2 | 1]) } }',
    params: { param0: 'a', param1: false, param2: 3 },
  },
  'selectionSet thingsConnection(where: { node })': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { thingsConnection: { totalCount: size([(n)-[e0:`LB_HAS_THING`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | 1]) } }',
    params: { param0: 2, param1: false },
  },
  'root friends_SOME nested items_SOME member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_FRIEND`]->(r0:`LbUser`) WHERE EXISTS { MATCH (r0)-[:`LB_HAS_ITEM`]->(r1:`LbDoc`) WHERE r1.`rank` = $param2 } }\nRETURN n { .`id` }',
    params: { param2: 2 },
  },
};
/** v2.10.0 (74dea63), strict mode. */
const V2100_STRICT: Record<string, Expected> = {
  'root items_SOME member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root items bare member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root items_NONE two member keys': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT (EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 } OR EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r2:`LbPost`) WHERE r2.`title` = $param3 })\nRETURN n { .`id` }',
    params: { param1: 2, param3: 'a' },
  },
  'root items_ALL member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE NOT (r0.`rank` = $param1) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root items_SINGLE member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE size([(n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 | r0]) = 1\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_SOME node shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (r0.`rank` = $param1) AND (r0:`LbPost` OR r0:`LbDoc`) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_NONE node_NOT shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (NOT (r0.`id` = $param1)) AND (r0:`LbPost` OR r0:`LbDoc`) }\nRETURN n { .`id` }',
    params: { param1: 'x' },
  },
  'typed select items where shared field': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND (n0:`LbPost` OR n0:`LbDoc`) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2 },
  },
  'selectionSet items(where) shared field': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND (n0:`LbPost` OR n0:`LbDoc`) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2 },
  },
  'selectionSet itemsConnection(where: { node }) shared field': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { edges: [(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND (n0:`LbPost` OR n0:`LbDoc`) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` } }], totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND (n0:`LbPost` OR n0:`LbDoc`) | 1]) } }",
    params: { param0: 2 },
  },
  'selectionSet itemsConnection bare shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND (n0:`LbPost` OR n0:`LbDoc`) | 1]) } }',
    params: { param0: 2 },
  },
  'selectionSet itemsAggregate(where) shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsAggregate: { `count`: COUNT { (n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND (n0:`LbPost` OR n0:`LbDoc`) } } }',
    params: { param0: 2 },
  },
  'root posts_SOME': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_WROTE`]->(r0:`LbPost`) WHERE r0.`title` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 'a' },
  },
  'root postsConnection_SOME node + edge': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_WROTE`]->(r0:`LbPost`) WHERE r0.`title` = $param1 AND e0.`stars` = $param2 }\nRETURN n { .`id` }',
    params: { param1: 'a', param2: 3 },
  },
  'root things_SOME (interface)': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_HAS_THING`]->(r0) WHERE (r0.`rank` = $param1) AND (r0:`LbPost` OR r0:`LbDoc`) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root thingsConnection_NONE (interface)': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_THING`]->(r0) WHERE (r0.`rank` = $param1) AND (r0:`LbPost` OR r0:`LbDoc`) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'typed select posts where': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { posts: [(n)-[:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`title` = $param0 | n0 { .`id` }] }',
    params: { param0: 'a' },
  },
  'typed select things where (interface)': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { things: [(n)-[:`LB_HAS_THING`]->(n0) WHERE (n0.`rank` = $param0) AND (n0:`LbPost` OR n0:`LbDoc`) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2 },
  },
  'selectionSet postsConnection(where: node + edge)': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`title` = $param0 AND e0.`stars` = $param1 | { node: n0 { .`id` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`title` = $param0 AND e0.`stars` = $param1 | 1]) } }',
    params: { param0: 'a', param1: 3 },
  },
  'selectionSet thingsConnection(where: { node })': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { thingsConnection: { totalCount: size([(n)-[e0:`LB_HAS_THING`]->(n0) WHERE (n0.`rank` = $param0) AND (n0:`LbPost` OR n0:`LbDoc`) | 1]) } }',
    params: { param0: 2 },
  },
  'root friends_SOME nested items_SOME member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_FRIEND`]->(r0:`LbUser`) WHERE EXISTS { MATCH (r0)-[:`LB_HAS_ITEM`]->(r1:`LbDoc`) WHERE r1.`rank` = $param2 } }\nRETURN n { .`id` }',
    params: { param2: 2 },
  },
};
/** v2.10.0 (74dea63), strict mode with policies. */
const V2100_STRICT_POLICIES: Record<string, Expected> = {
  'root items_SOME member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root items bare member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root items_NONE two member keys': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT (EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 } OR EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r2:`LbPost`) WHERE (r2.`title` = $param3) AND (true AND (r2.`secret` = $param4)) })\nRETURN n { .`id` }',
    params: { param1: 2, param3: 'a', param4: false },
  },
  'root items_ALL member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE NOT (r0.`rank` = $param1) }\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root items_SINGLE member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE size([(n)-[:`LB_HAS_ITEM`]->(r0:`LbDoc`) WHERE r0.`rank` = $param1 | r0]) = 1\nRETURN n { .`id` }',
    params: { param1: 2 },
  },
  'root itemsConnection_SOME node shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (r0.`rank` = $param1) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root itemsConnection_NONE node_NOT shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_ITEM`]->(r0) WHERE (NOT (r0.`id` = $param1)) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 'x', param2: false },
  },
  'typed select items where shared field': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: false },
  },
  'selectionSet items(where) shared field': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { items: [(n)-[:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: false },
  },
  'selectionSet itemsConnection(where: { node }) shared field': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { edges: [(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` } }], totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | 1]) } }",
    params: { param0: 2, param1: false },
  },
  'selectionSet itemsConnection bare shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsConnection: { totalCount: size([(n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | 1]) } }',
    params: { param0: 2, param1: false },
  },
  'selectionSet itemsAggregate(where) shared field': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { itemsAggregate: { `count`: COUNT { (n)-[e0:`LB_HAS_ITEM`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) } } }',
    params: { param0: 2, param1: false },
  },
  'root posts_SOME': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_WROTE`]->(r0:`LbPost`) WHERE (r0.`title` = $param1) AND (true AND (r0.`secret` = $param2)) }\nRETURN n { .`id` }',
    params: { param1: 'a', param2: false },
  },
  'root postsConnection_SOME node + edge': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[e0:`LB_WROTE`]->(r0:`LbPost`) WHERE (r0.`title` = $param1 AND e0.`stars` = $param2) AND (true AND (r0.`secret` = $param3)) }\nRETURN n { .`id` }',
    params: { param1: 'a', param2: 3, param3: false },
  },
  'root things_SOME (interface)': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_HAS_THING`]->(r0) WHERE (r0.`rank` = $param1) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'root thingsConnection_NONE (interface)': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE NOT EXISTS { MATCH (n)-[e0:`LB_HAS_THING`]->(r0) WHERE (r0.`rank` = $param1) AND ((r0:`LbPost` OR r0:`LbDoc`) AND (NOT r0:`LbPost` OR (true AND (r0.`secret` = $param2)))) }\nRETURN n { .`id` }',
    params: { param1: 2, param2: false },
  },
  'typed select posts where': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { posts: [(n)-[:`LB_WROTE`]->(n0:`LbPost`) WHERE (n0.`title` = $param0) AND (true AND (n0.`secret` = $param1)) | n0 { .`id` }] }',
    params: { param0: 'a', param1: false },
  },
  'typed select things where (interface)': {
    cypher:
      "MATCH (n:`LbUser`)\nRETURN n { things: [(n)-[:`LB_HAS_THING`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['LbPost', 'LbDoc']]), .`id` }] }",
    params: { param0: 2, param1: false },
  },
  'selectionSet postsConnection(where: node + edge)': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE (n0.`title` = $param0) AND (true AND (n0.`secret` = $param1)) AND e0.`stars` = $param2 | { node: n0 { .`id` } }], totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE (n0.`title` = $param0) AND (true AND (n0.`secret` = $param1)) AND e0.`stars` = $param2 | 1]) } }',
    params: { param0: 'a', param1: false, param2: 3 },
  },
  'selectionSet thingsConnection(where: { node })': {
    cypher:
      'MATCH (n:`LbUser`)\nRETURN n { thingsConnection: { totalCount: size([(n)-[e0:`LB_HAS_THING`]->(n0) WHERE (n0.`rank` = $param0) AND ((n0:`LbPost` OR n0:`LbDoc`) AND (NOT n0:`LbPost` OR (true AND (n0.`secret` = $param1)))) | 1]) } }',
    params: { param0: 2, param1: false },
  },
  'root friends_SOME nested items_SOME member key': {
    cypher:
      'MATCH (n:`LbUser`)\nWHERE EXISTS { MATCH (n)-[:`LB_FRIEND`]->(r0:`LbUser`) WHERE EXISTS { MATCH (r0)-[:`LB_HAS_ITEM`]->(r1:`LbDoc`) WHERE r1.`rank` = $param2 } }\nRETURN n { .`id` }',
    params: { param2: 2 },
  },
};

describe.each([
  ['', false],
  [' + policies', true],
])('union member where%s', (_label, policies) => {
  describe.each(UNION_MEMBER_WHERE_CASES)('$label', ({ label, run }) => {
    it('default: filters by the member, no warning', async () => {
      const h = harness({ policies });
      await run(h.model);
      const { cypher, params } = h.last();
      const expected = (policies ? DEFAULT_POLICIES : DEFAULT)[label];
      expect(cypher).toBe(expected.cypher);
      expect(serialize(params)).toEqual(expected.params);
      // Never the member name as a property.
      expect(cypher).not.toMatch(/\.`Lb(Doc|Post)`/);
      expect(h.logger.warn).not.toHaveBeenCalled();
    });

    it('strict: the same member filter (plus the member restriction), no warning', async () => {
      const h = harness({ policies, strict: true });
      await run(h.model);
      const { cypher, params } = h.last();
      const expected = (policies ? STRICT_POLICIES : STRICT)[label];
      expect(cypher).toBe(expected.cypher);
      expect(serialize(params)).toEqual(expected.params);
      expect(cypher).not.toMatch(/\.`Lb(Doc|Post)`/);
      expect(h.logger.warn).not.toHaveBeenCalled();
    });
  });
});

describe.each([
  ['default', {}, V2100],
  ['default + policies', { policies: true }, V2100_POLICIES],
  ['strict', { strict: true }, V2100_STRICT],
  [
    'strict + policies',
    { strict: true, policies: true },
    V2100_STRICT_POLICIES,
  ],
] as const)(
  'already-working where inputs: byte-identical to v2.10.0 (%s)',
  (_mode, opts, golden) => {
    it.each(UNCHANGED_WHERE_CASES)('$label', async ({ label, run }) => {
      const h = harness(opts);
      await run(h.model);
      const { cypher, params } = h.last();
      expect(cypher).toBe(golden[label].cypher);
      expect(serialize(params)).toEqual(golden[label].params);
      expect(h.logger.warn).not.toHaveBeenCalled();
    });
  },
);

describe('union member where — shapes', () => {
  it('a bare member value in the upstream connection shape is the member node filter', async () => {
    const h = harness();
    await h.model('LbUser').find({
      where: { itemsConnection_SOME: { LbDoc: { rank: 2 } } },
      selectionSet: '{ id }',
    } as never);
    const bare = h.last().cypher;
    await h.model('LbUser').find({
      where: { itemsConnection_SOME: { LbDoc: { node: { rank: 2 } } } },
      selectionSet: '{ id }',
    } as never);
    expect(bare).toBe(h.last().cypher);
  });

  it('member filters compose with logical operators inside node', async () => {
    const h = harness();
    await h.model('LbUser').find({
      where: {
        itemsConnection_SOME: {
          node: { OR: [{ LbDoc: { rank: 2 } }, { LbPost: { title: 'a' } }] },
        },
      },
      selectionSet: '{ id }',
    } as never);
    expect(h.last().cypher).toContain(
      'WHERE ((r0:`LbDoc` AND r0.`rank` = $param1) OR (r0:`LbPost` AND r0.`title` = $param2)) }',
    );
  });

  it('an @cypher member field in a selection connection where throws', async () => {
    const h = harness();
    await expect(
      h.model('LbUser').find({
        selectionSet:
          '{ itemsConnection(where: { LbDoc: { node: { dcount: 20 } } }) { totalCount } }',
      }),
    ).rejects.toThrow(/by an @cypher field is not supported/);
  });
});
