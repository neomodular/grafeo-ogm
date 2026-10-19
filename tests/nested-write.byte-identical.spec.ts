/**
 * v2.8.0 — the nested-write fixes (F1 nested delete through a cycle, F2
 * feedback warning) change no default-mode Cypher. Every shape below is
 * compiled policy-free and policy-bound and compared to the Cypher and
 * params captured from v2.7.0 (4f6a04a, before the fixes), hard-coded here.
 */
import { writeFileSync } from 'node:fs';
import { isInt } from 'neo4j-driver';
import {
  MODES,
  compileShape,
  shapes,
} from './nested-write.byte-identical.shapes';

/** Params as JSON, neo4j Integers as `{ $int: "<value>" }`. */
const serialize = (params: Record<string, unknown>): unknown =>
  JSON.parse(
    JSON.stringify(params, (_k, v: unknown) =>
      isInt(v) ? { $int: v.toString() } : v,
    ),
  );

/** v2.7.0 output per `<mode> :: <shape>`. */
const V270: Record<string, { cypher: string; params: unknown }> = {
  'plain :: update: nested delete through a cycle (chart -> tags -> charts)': {
    cypher:
      'MATCH (n:`ItPChart`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)<-[r_tags_0:`ITP_TAGS`]-(n_u0:`ItPTag`)\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[:`ITP_TAGS`]->(n_u0_del0:`ItPChart`)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_charts_0_0\n}\nRETURN count(*) AS _uc_tags_0\n}\nRETURN n { .`id`, .`name`, tags: [(n)<-[:`ITP_TAGS`]-(n0:`ItPTag`) | n0 { .`id` }] }',
    params: {
      param0: 'c1',
    },
  },
  'policies :: update: nested delete through a cycle (chart -> tags -> charts)':
    {
      cypher:
        'MATCH (n:`ItPChart`)\nWHERE (n.`id` = $param0) AND (n.`ownerId` = $param1)\nWITH n\nCALL {\nWITH n\nMATCH (n)<-[r_tags_0:`ITP_TAGS`]-(n_u0:`ItPTag`)\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[:`ITP_TAGS`]->(n_u0_del0:`ItPChart`)\nWHERE (n_u0_del0.`ownerId` = $param2)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_charts_0_0\n}\nRETURN count(*) AS _uc_tags_0\n}\nWITH n\nWHERE (true AND (n.`secret` = $param3))\nRETURN n { .`id`, .`name`, tags: [(n)<-[:`ITP_TAGS`]-(n0:`ItPTag`) | n0 { .`id` }] }',
      params: {
        param0: 'c1',
        param1: 'u1',
        param2: 'u1',
        param3: false,
      },
    },
  'plain :: updateMany: nested delete through a cycle, count only': {
    cypher:
      'MATCH (n:`ItPChart`)\nWHERE n.`id` IN $param0\nSET n.`name` = $update_name\nWITH n\nCALL {\nWITH n\nMATCH (n)<-[r_tags_0:`ITP_TAGS`]-(n_u0:`ItPTag`)\nWHERE n_u0.`id` = $param1\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[:`ITP_TAGS`]->(n_u0_del0:`ItPChart`)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_charts_0_0\n}\nRETURN count(*) AS _uc_tags_0\n}\nRETURN count(n) AS count',
    params: {
      param0: ['c1', 'c4'],
      update_name: 'z',
      param1: 't2',
    },
  },
  'policies :: updateMany: nested delete through a cycle, count only': {
    cypher:
      'MATCH (n:`ItPChart`)\nWHERE (n.`id` IN $param0) AND (n.`ownerId` = $param1)\nSET n.`name` = $update_name\nWITH n\nCALL {\nWITH n\nMATCH (n)<-[r_tags_0:`ITP_TAGS`]-(n_u0:`ItPTag`)\nWHERE n_u0.`id` = $param3\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[:`ITP_TAGS`]->(n_u0_del0:`ItPChart`)\nWHERE (n_u0_del0.`ownerId` = $param2)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_charts_0_0\n}\nRETURN count(*) AS _uc_tags_0\n}\nRETURN count(n) AS count',
    params: {
      param0: ['c1', 'c4'],
      param1: 'u1',
      update_name: 'z',
      param3: 't2',
      param2: 'u1',
    },
  },
  'plain :: updateMany: cycle delete, then a create from the root': {
    cypher:
      'MATCH (n:`ItPChart`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)<-[r_tags_0:`ITP_TAGS`]-(n_u0:`ItPTag`)\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[:`ITP_TAGS`]->(n_u0_del0:`ItPChart`)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_charts_0_0\n}\nRETURN count(*) AS _uc_tags_0\n}\nWITH n\nCREATE (n_cr1:`ItPCategory` { `id`: $update_categories_0_create0_id, `runId`: $update_categories_0_create0_runId })\nCREATE (n)-[:`ITP_IN_CAT`]->(n_cr1)\nRETURN count(n) AS count',
    params: {
      param0: 'c1',
      update_categories_0_create0_id: 'kx',
      update_categories_0_create0_runId: 'r',
    },
  },
  'policies :: updateMany: cycle delete, then a create from the root': {
    cypher:
      'MATCH (n:`ItPChart`)\nWHERE (n.`id` = $param0) AND (n.`ownerId` = $param1)\nWITH n\nCALL {\nWITH n\nMATCH (n)<-[r_tags_0:`ITP_TAGS`]-(n_u0:`ItPTag`)\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[:`ITP_TAGS`]->(n_u0_del0:`ItPChart`)\nWHERE (n_u0_del0.`ownerId` = $param2)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_charts_0_0\n}\nRETURN count(*) AS _uc_tags_0\n}\nWITH n\nCREATE (n_cr1:`ItPCategory` { `id`: $update_categories_0_create0_id, `runId`: $update_categories_0_create0_runId })\nCREATE (n)-[:`ITP_IN_CAT`]->(n_cr1)\nRETURN count(n) AS count',
    params: {
      param0: 'c1',
      param1: 'u1',
      param2: 'u1',
      update_categories_0_create0_id: 'kx',
      update_categories_0_create0_runId: 'r',
    },
  },
  'plain :: update: two roots, one deletes the other through the cycle': {
    cypher:
      'MATCH (n:`ItPChart`)\nWHERE n.`id` IN $param0\nSET n.`name` = $update_name\nWITH n\nCALL {\nWITH n\nMATCH (n)<-[r_tags_0:`ITP_TAGS`]-(n_u0:`ItPTag`)\nWHERE n_u0.`id` = $param2\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[:`ITP_TAGS`]->(n_u0_del0:`ItPChart`)\nWHERE n_u0_del0.`id` = $param1\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_charts_0_0\n}\nRETURN count(*) AS _uc_tags_0\n}\nRETURN n { .`id`, .`name` }',
    params: {
      param0: ['c1', 'c2'],
      update_name: 'z',
      param2: 't1',
      param1: 'c2',
    },
  },
  'policies :: update: two roots, one deletes the other through the cycle': {
    cypher:
      'MATCH (n:`ItPChart`)\nWHERE (n.`id` IN $param0) AND (n.`ownerId` = $param1)\nSET n.`name` = $update_name\nWITH n\nCALL {\nWITH n\nMATCH (n)<-[r_tags_0:`ITP_TAGS`]-(n_u0:`ItPTag`)\nWHERE n_u0.`id` = $param4\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[:`ITP_TAGS`]->(n_u0_del0:`ItPChart`)\nWHERE n_u0_del0.`id` = $param2 AND (n_u0_del0.`ownerId` = $param3)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_charts_0_0\n}\nRETURN count(*) AS _uc_tags_0\n}\nWITH n\nWHERE (true AND (n.`secret` = $param5))\nRETURN n { .`id`, .`name` }',
    params: {
      param0: ['c1', 'c2'],
      param1: 'u1',
      update_name: 'z',
      param4: 't1',
      param2: 'c2',
      param3: 'u1',
      param5: false,
    },
  },
  'plain :: update: nested delete reaches an intermediate node': {
    cypher:
      'MATCH (n:`ItPTag`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_charts_0:`ITP_TAGS`]->(n_u0:`ItPChart`)\nWHERE n_u0.`id` = $param2\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)<-[r_tags_0:`ITP_TAGS`]-(n_u0_u0:`ItPTag`)\nWITH n, n_u0, n_u0_u0\nCALL {\nWITH n, n_u0, n_u0_u0\nMATCH (n_u0_u0)-[:`ITP_TAGS`]->(n_u0_u0_del0:`ItPChart`)\nWHERE n_u0_u0_del0.`id` = $param1\nDETACH DELETE n_u0_u0_del0\nRETURN count(*) AS _del_charts_0_0\n}\nRETURN count(*) AS _uc_tags_0\n}\nWITH n, n_u0\nCREATE (n_u0_cr1:`ItPCategory` { `id`: $update_charts_0_categories_0_create0_id, `runId`: $update_charts_0_categories_0_create0_runId })\nCREATE (n_u0)-[:`ITP_IN_CAT`]->(n_u0_cr1)\nRETURN count(*) AS _uc_charts_0\n}\nRETURN n { .`id`, .`name`, charts: [(n)-[:`ITP_TAGS`]->(n0:`ItPChart`) | n0 { .`id` }] }',
    params: {
      param0: 't1',
      update_name: 'renamed',
      param2: 'c1',
      param1: 'c1',
      update_charts_0_categories_0_create0_id: 'kx',
      update_charts_0_categories_0_create0_runId: 'r',
    },
  },
  'policies :: update: nested delete reaches an intermediate node': {
    cypher:
      'MATCH (n:`ItPTag`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_charts_0:`ITP_TAGS`]->(n_u0:`ItPChart`)\nWHERE n_u0.`id` = $param3 AND (n_u0.`ownerId` = $param4)\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)<-[r_tags_0:`ITP_TAGS`]-(n_u0_u0:`ItPTag`)\nWITH n, n_u0, n_u0_u0\nCALL {\nWITH n, n_u0, n_u0_u0\nMATCH (n_u0_u0)-[:`ITP_TAGS`]->(n_u0_u0_del0:`ItPChart`)\nWHERE n_u0_u0_del0.`id` = $param1 AND (n_u0_u0_del0.`ownerId` = $param2)\nDETACH DELETE n_u0_u0_del0\nRETURN count(*) AS _del_charts_0_0\n}\nRETURN count(*) AS _uc_tags_0\n}\nWITH n, n_u0\nCREATE (n_u0_cr1:`ItPCategory` { `id`: $update_charts_0_categories_0_create0_id, `runId`: $update_charts_0_categories_0_create0_runId })\nCREATE (n_u0)-[:`ITP_IN_CAT`]->(n_u0_cr1)\nRETURN count(*) AS _uc_charts_0\n}\nRETURN n { .`id`, .`name`, charts: [(n)-[:`ITP_TAGS`]->(n0:`ItPChart`) WHERE (true AND (n0.`secret` = $param5)) | n0 { .`id` }] }',
    params: {
      param0: 't1',
      update_name: 'renamed',
      param3: 'c1',
      param4: 'u1',
      param1: 'c1',
      param2: 'u1',
      update_charts_0_categories_0_create0_id: 'kx',
      update_charts_0_categories_0_create0_runId: 'r',
      param5: false,
    },
  },
  'plain :: update: union member update with a cycle delete': {
    cypher:
      'MATCH (n:`ItPTag`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_items_0:`ITP_ITEM`]->(n_u0:`ItPChart`)\nSET n_u0.`name` = $update_items_ItPChart_items_0_set_name\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)<-[:`ITP_TAGS`]-(n_u0_del0:`ItPTag`)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_tags_0_0\n}\nRETURN count(*) AS _uc_items_0\n}\nRETURN n { .`id` }',
    params: {
      param0: 't1',
      update_items_ItPChart_items_0_set_name: 'q',
    },
  },
  'policies :: update: union member update with a cycle delete': {
    cypher:
      'MATCH (n:`ItPTag`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_items_0:`ITP_ITEM`]->(n_u0:`ItPChart`)\nWHERE (n_u0.`ownerId` = $param1)\nSET n_u0.`name` = $update_items_ItPChart_items_0_set_name\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)<-[:`ITP_TAGS`]-(n_u0_del0:`ItPTag`)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_tags_0_0\n}\nRETURN count(*) AS _uc_items_0\n}\nRETURN n { .`id` }',
    params: {
      param0: 't1',
      param1: 'u1',
      update_items_ItPChart_items_0_set_name: 'q',
    },
  },
  'plain :: update: interface member body with a cycle delete': {
    cypher:
      'MATCH (n:`ItPTag`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_resources_0:`ITP_RES`]->(n_u0:`ItPChart`)\nSET n_u0.`name` = $update_resources_0_upd_resources_ItPChart_resources_0_set_name\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)<-[:`ITP_TAGS`]-(n_u0_del0:`ItPTag`)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_tags_0_0\n}\nRETURN count(*) AS _uc_resources_0\n}\nRETURN n { .`id` }',
    params: {
      param0: 't1',
      update_resources_0_upd_resources_ItPChart_resources_0_set_name: 'q',
    },
  },
  'policies :: update: interface member body with a cycle delete': {
    cypher:
      'MATCH (n:`ItPTag`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_resources_0:`ITP_RES`]->(n_u0:`ItPChart`)\nWHERE (n_u0.`ownerId` = $param1)\nSET n_u0.`name` = $update_resources_0_upd_resources_ItPChart_resources_0_set_name\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)<-[:`ITP_TAGS`]-(n_u0_del0:`ItPTag`)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_tags_0_0\n}\nRETURN count(*) AS _uc_resources_0\n}\nRETURN n { .`id` }',
    params: {
      param0: 't1',
      param1: 'u1',
      update_resources_0_upd_resources_ItPChart_resources_0_set_name: 'q',
    },
  },
  'plain :: update: nested delete of a type that is no ancestor': {
    cypher:
      'MATCH (n:`ItPChart`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)<-[r_tags_0:`ITP_TAGS`]-(n_u0:`ItPTag`)\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[:`ITP_RES`]->(n_u0_del0:`ItPVault`)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_vaults_0_0\n}\nRETURN count(*) AS _uc_tags_0\n}\nRETURN n { .`id` }',
    params: {
      param0: 'c1',
    },
  },
  'policies :: update: nested delete of a type that is no ancestor': {
    cypher:
      'MATCH (n:`ItPChart`)\nWHERE (n.`id` = $param0) AND (n.`ownerId` = $param1)\nWITH n\nCALL {\nWITH n\nMATCH (n)<-[r_tags_0:`ITP_TAGS`]-(n_u0:`ItPTag`)\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[:`ITP_RES`]->(n_u0_del0:`ItPVault`)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_vaults_0_0\n}\nRETURN count(*) AS _uc_tags_0\n}\nWITH n\nWHERE (true AND (n.`secret` = $param2))\nRETURN n { .`id` }',
    params: {
      param0: 'c1',
      param1: 'u1',
      param2: false,
    },
  },
  'plain :: update: self-relationship nested delete': {
    cypher:
      'MATCH (n:`BiPerson`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nWITH n\nCALL {\nWITH n\nMATCH (n)-[:`BI_FRIEND`]->(n_del0:`BiPerson`)\nDETACH DELETE n_del0\nRETURN count(*) AS _del_friends_0_0\n}\nRETURN n { .`id`, .`name`, friends: [(n)-[:`BI_FRIEND`]->(n0:`BiPerson`) | n0 { .`id` }] }',
    params: {
      param0: 'p1',
      update_name: 'z',
    },
  },
  'plain :: updateMany: self-relationship friends of friends delete': {
    cypher:
      'MATCH (n:`BiPerson`)\nWHERE n.`name` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_friends_0:`BI_FRIEND`]->(n_u0:`BiPerson`)\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[:`BI_FRIEND`]->(n_u0_del0:`BiPerson`)\nDETACH DELETE n_u0_del0\nRETURN count(*) AS _del_friends_0_0\n}\nRETURN count(*) AS _uc_friends_0\n}\nRETURN count(n) AS count',
    params: {
      param0: 'a',
    },
  },
  'plain :: updateMany: connect / create on a field an enclosing update iterates (F2)':
    {
      cypher:
        'MATCH (n:`ItPChart`)\nWHERE n.`runId` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_categories_0:`ITP_IN_CAT`]->(n_u0:`ItPCategory`)\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)<-[r_charts_0:`ITP_IN_CAT`]-(n_u0_u0:`ItPChart`)\nWITH n, n_u0, n_u0_u0\nCALL {\nWITH n, n_u0, n_u0_u0\nMATCH (n_u0_u0_conn0:`ItPCategory`)\nWHERE n_u0_u0_conn0.`runId` = $param1\nMERGE (n_u0_u0)-[:`ITP_IN_CAT`]->(n_u0_u0_conn0)\nRETURN count(*) AS _cn_categories_0\n}\nWITH n, n_u0, n_u0_u0\nCREATE (n_u0_u0_cr1:`ItPCategory` { `id`: $update_categories_0_charts_0_categories_0_create0_id, `runId`: $update_categories_0_charts_0_categories_0_create0_runId })\nCREATE (n_u0_u0)-[:`ITP_IN_CAT`]->(n_u0_u0_cr1)\nRETURN count(*) AS _uc_charts_0\n}\nRETURN count(*) AS _uc_categories_0\n}\nRETURN count(n) AS count',
      params: {
        param0: 'r',
        param1: 'r',
        update_categories_0_charts_0_categories_0_create0_id: 'x',
        update_categories_0_charts_0_categories_0_create0_runId: 'r',
      },
    },
  'policies :: updateMany: connect / create on a field an enclosing update iterates (F2)':
    {
      cypher:
        'MATCH (n:`ItPChart`)\nWHERE (n.`runId` = $param0) AND (n.`ownerId` = $param1)\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_categories_0:`ITP_IN_CAT`]->(n_u0:`ItPCategory`)\nWHERE true\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)<-[r_charts_0:`ITP_IN_CAT`]-(n_u0_u0:`ItPChart`)\nWHERE (n_u0_u0.`ownerId` = $param3)\nWITH n, n_u0, n_u0_u0\nCALL {\nWITH n, n_u0, n_u0_u0\nMATCH (n_u0_u0_conn0:`ItPCategory`)\nWHERE n_u0_u0_conn0.`runId` = $param2 AND true\nMERGE (n_u0_u0)-[:`ITP_IN_CAT`]->(n_u0_u0_conn0)\nRETURN count(*) AS _cn_categories_0\n}\nWITH n, n_u0, n_u0_u0\nCREATE (n_u0_u0_cr1:`ItPCategory` { `id`: $update_categories_0_charts_0_categories_0_create0_id, `runId`: $update_categories_0_charts_0_categories_0_create0_runId })\nCREATE (n_u0_u0)-[:`ITP_IN_CAT`]->(n_u0_u0_cr1)\nRETURN count(*) AS _uc_charts_0\n}\nRETURN count(*) AS _uc_categories_0\n}\nRETURN count(n) AS count',
      params: {
        param0: 'r',
        param1: 'u1',
        param3: 'u1',
        param2: 'r',
        update_categories_0_charts_0_categories_0_create0_id: 'x',
        update_categories_0_charts_0_categories_0_create0_runId: 'r',
      },
    },
  'plain :: updateMany: sibling update and create items (F9)': {
    cypher:
      'MATCH (n:`ItPChart`)\nWHERE n.`runId` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)<-[r_tags_0:`ITP_TAGS`]-(n_u0:`ItPTag`)\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[r_resources_0:`ITP_RES`]->(n_u0_u0)\nWHERE (n_u0_u0:`ItPChart` OR n_u0_u0:`ItPDrug`)\nSET n_u0_u0.`name` = $update_tags_0_resources_0_set_name\nRETURN count(*) AS _uc_resources_0\n}\nWITH n, n_u0\nCREATE (n_u0_cr1:`ItPChart` { `id`: $update_tags_0_resources_1_create0_id, `runId`: $update_tags_0_resources_1_create0_runId, `tenantId`: $update_tags_0_resources_1_create0_tenantId })\nCREATE (n_u0)-[:`ITP_RES`]->(n_u0_cr1)\nRETURN count(*) AS _uc_tags_0\n}\nRETURN count(n) AS count',
    params: {
      param0: 'r',
      update_tags_0_resources_0_set_name: 'a',
      update_tags_0_resources_1_create0_id: 'n3',
      update_tags_0_resources_1_create0_runId: 'r',
      update_tags_0_resources_1_create0_tenantId: 't1',
    },
  },
  'policies :: updateMany: sibling update and create items (F9)': {
    cypher:
      'MATCH (n:`ItPChart`)\nWHERE (n.`runId` = $param0) AND (n.`ownerId` = $param1)\nWITH n\nCALL {\nWITH n\nMATCH (n)<-[r_tags_0:`ITP_TAGS`]-(n_u0:`ItPTag`)\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[r_resources_0:`ITP_RES`]->(n_u0_u0)\nWHERE (n_u0_u0:`ItPChart` OR n_u0_u0:`ItPDrug`) AND ((n_u0_u0:`ItPChart` OR n_u0_u0:`ItPDrug`) AND (NOT n_u0_u0:`ItPChart` OR (n_u0_u0.`ownerId` = $param2)) AND (NOT n_u0_u0:`ItPDrug` OR false))\nSET n_u0_u0.`name` = $update_tags_0_resources_0_set_name\nRETURN count(*) AS _uc_resources_0\n}\nWITH n, n_u0\nCREATE (n_u0_cr1:`ItPChart` { `id`: $update_tags_0_resources_1_create0_id, `runId`: $update_tags_0_resources_1_create0_runId, `tenantId`: $update_tags_0_resources_1_create0_tenantId })\nCREATE (n_u0)-[:`ITP_RES`]->(n_u0_cr1)\nRETURN count(*) AS _uc_tags_0\n}\nRETURN count(n) AS count',
    params: {
      param0: 'r',
      param1: 'u1',
      param2: 'u1',
      update_tags_0_resources_0_set_name: 'a',
      update_tags_0_resources_1_create0_id: 'n3',
      update_tags_0_resources_1_create0_runId: 'r',
      update_tags_0_resources_1_create0_tenantId: 't1',
    },
  },
};

describe('nested-write Cypher is byte-identical to v2.7.0 in default mode (v2.8.0)', () => {
  const cases = Object.entries(shapes).flatMap(([name, shape]) =>
    MODES.filter((mode) => mode === 'plain' || !shape.self).map(
      (mode) => [`${mode} :: ${name}`, mode, shape] as const,
    ),
  );

  if (process.env.PRINT_V270) {
    it('prints the captured output', async () => {
      const out: Record<string, unknown> = {};
      for (const [key, mode, shape] of cases) {
        const [rec] = await compileShape(shape.run, mode, shape.self);
        out[key] = { cypher: rec.cypher, params: serialize(rec.params) };
      }
      writeFileSync(process.env.PRINT_V270!, JSON.stringify(out, null, 2));
    });
    return;
  }

  it('covers every shape in every mode', () => {
    expect(Object.keys(V270).sort()).toEqual(cases.map(([k]) => k).sort());
  });

  it.each(cases)('%s', async (key, mode, shape) => {
    const records = await compileShape(shape.run, mode, shape.self);
    expect(records).toHaveLength(1);
    expect(records[0].cypher).toBe(V270[key].cypher);
    expect(serialize(records[0].params)).toEqual(V270[key].params);
  });
});
