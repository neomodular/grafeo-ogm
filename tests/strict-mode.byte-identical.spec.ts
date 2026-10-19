/**
 * v2.6.0 — strict mode must not change default-mode output. For every
 * write-path shape strict mode corrects (and the legitimate shapes next to
 * them), the Cypher and params compiled with `strict` unset and with
 * `strict: false` are identical, and the Cypher is byte-identical to v2.5.3
 * (hard-coded below, captured from v2.5.3 main).
 */
import { OGM } from '../src/ogm';
import {
  badWriteShapes,
  legitWriteShapes,
  Recorded,
  recordingDriver,
  Run,
  writeTypeDefs,
} from './strict-mode.writes.cases';

/** v2.5.3 Cypher for each shape (statements joined by `\n;;\n`). */
const V253: Record<string, string> = {
  'connect: unknown item key (array, UNWIND path)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nUNWIND $connect_pets AS connItem\nMATCH (target:`Pet`)\nMERGE (n)-[:`HAS`]->(target)\nRETURN count(*) AS _conn_pets\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'connect: unknown item key (single object)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (target:`Pet`)\nMERGE (n)-[:`HAS`]->(target)\nRETURN count(*) AS _conn_pets\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'connect: unknown item key (nested in update)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n_conn0:`Pet`)\nMERGE (n)-[:`HAS`]->(n_conn0)\nRETURN count(*) AS _cn_pets_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'connect: unknown item key (nested in create)':
    "CREATE (n:`User` { `id`: randomUUID(), `email`: $create0_email })\nWITH n\nCALL {\nWITH n\nMATCH (n_cn0:`Pet`)\nMERGE (n)-[:`HAS`]->(n_cn0)\nRETURN count(*) AS _ccn_create0_pets_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'disconnect: unknown item key':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_pets_0:`HAS`]->(target_pets_0:`Pet`)\nDELETE r_pets_0\nRETURN count(*) AS _r_pets_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'disconnect: unknown item key (nested in update)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_disc_pets_0_0:`HAS`]->()\nDELETE r_disc_pets_0_0\nRETURN count(*) AS _r_disc_pets_0_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'edge: unknown key on connect (UNWIND path)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nUNWIND $connect_posts AS connItem\nMATCH (target:`Post`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[r:`WROTE`]->(target)\nSET r.`rolee` = connItem.edge.rolee\nRETURN count(*) AS _conn_posts\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'edge: unknown key on connect (single object)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (target:`Post`)\nWHERE target.`id` = $param1\nMERGE (n)-[r:`WROTE`]->(target)\nSET r.`rolee` = $connect_posts_edge_rolee\nRETURN count(*) AS _conn_posts\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'edge: unknown key on nested create (in create)':
    "CREATE (n:`User` { `id`: randomUUID(), `email`: $create0_email })\nWITH n\nCREATE (n_c0:`Post` { `id`: randomUUID(), `title`: $create0_posts_create0_title })\nCREATE (n)-[:`WROTE`]->(n_c0)\nWITH n, n_c0\nMATCH (n)-[r_edge_0:`WROTE`]->(n_c0:`Post`)\nSET r_edge_0.`rolee` = $create0_posts_create0_edge_rolee\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'edge: unknown key on nested create (in update)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCREATE (n_cr0:`Post` { `id`: randomUUID(), `title`: $update_posts_0_create0_title })\nCREATE (n)-[n_cr0_e:`WROTE`]->(n_cr0)\nSET n_cr0_e.`rolee` = $update_posts_0_create0_edge_rolee\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'edge: unknown key on nested update':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nWHERE n_u0.`id` = $param1\nSET r_posts_0.`rolee` = $update_posts_0_edge_rolee\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'upsert: two unique keys in where':
    "MERGE (n:`User` { `id`: $merge_id, `email`: $merge_email })\nON CREATE SET n.`name` = $onCreate_name\nON MATCH SET n.`name` = $onMatch_name\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'labels: upsert':
    "MERGE (n:`User` { `email`: $merge_email })\nON CREATE SET n.`name` = $onCreate_name, n.`id` = randomUUID()\nON MATCH SET n.`name` = $onMatch_name\nSET n:`Vip`\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'labels: createMany skipDuplicates':
    'UNWIND $items AS item\nMERGE (n:`User` { `email`: item.`email` })\nON CREATE SET n.`id` = randomUUID()\nSET n:`Vip`\nRETURN count(n) AS count',
  'blanket disconnect on a shared relationship type':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_pets_0:`HAS`]->()\nDELETE r_pets_0\nRETURN count(*) AS _r_pets_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'blanket disconnect on a shared relationship type (nested in update)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_disc_pets_0_0:`HAS`]->()\nDELETE r_disc_pets_0_0\nRETURN count(*) AS _r_disc_pets_0_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'connect-all [{}]':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nUNWIND $connect_pets AS connItem\nMATCH (target:`Pet`)\nMERGE (n)-[:`HAS`]->(target)\nRETURN count(*) AS _conn_pets\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'connect with where + edge + overwrite':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nUNWIND $connect_posts AS connItem\nMATCH (target:`Post`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[r:`WROTE`]->(target)\nSET r.`role` = connItem.edge.role\nRETURN count(*) AS _conn_posts\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'disconnect null':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->()\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'disconnect {} (unshared type)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->()\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'disconnect with where':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_pets_0:`HAS`]->(target_pets_0:`Pet`)\nWHERE target_pets_0.`id` = $param1\nDELETE r_pets_0\nRETURN count(*) AS _r_pets_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'upsert: one unique key':
    "MERGE (n:`User` { `email`: $merge_email })\nON CREATE SET n.`name` = $onCreate_name, n.`id` = randomUUID()\nON MATCH SET n.`name` = $onMatch_name\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'createMany with labels, no skipDuplicates':
    'UNWIND $items AS item\nCREATE (n:`User` { `id`: randomUUID(), `email`: item.`email` })\nSET n:`Vip`\nRETURN count(n) AS count',
  'create with labels':
    "CREATE (n:`User` { `id`: randomUUID(), `email`: $create0_email })\nSET n:`Vip`\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
};

async function compile(
  run: Run,
  strict: boolean | undefined,
): Promise<Recorded[]> {
  const records: Recorded[] = [];
  const ogm = new OGM({
    typeDefs: writeTypeDefs,
    driver: recordingDriver(records),
    ...(strict === undefined ? {} : { strict }),
  });
  await run(ogm);
  return records;
}

describe('strict mode off: write Cypher is byte-identical to v2.5.3 (v2.6.0)', () => {
  const cases = Object.entries({ ...badWriteShapes, ...legitWriteShapes });

  it('covers every shape', () => {
    expect(Object.keys(V253).sort()).toEqual(cases.map(([n]) => n).sort());
  });

  it.each(cases)('%s', async (name, run) => {
    const unset = await compile(run, undefined);
    const off = await compile(run, false);
    expect(off).toEqual(unset);
    expect(unset.map((r) => r.cypher).join('\n;;\n')).toBe(V253[name]);
  });
});
