/**
 * v2.10.0 — strict item 22: unknown keys in nested write objects.
 *
 * The nested update item, the `update` body that uses the `node` / `edge`
 * wrapper, the nested create item that uses `node`, and a relationship
 * field's input in `create()` (or in a nested create's `node`) are compiled
 * from a fixed set of keys. Pre-2.10.0 any other key was ignored, so a
 * typo'd `wher` left the item's `update` unfiltered (every related node
 * rewritten) and `updat` / `creat` / `egde` / a node field beside `edge`
 * were dropped.
 *
 * - Default mode: byte-identical to v2.9.0 (hard-coded below, captured from
 *   v2.9.0 main @ 76e32ce); warns once per OGM and shape
 *   (`nested-write-unknown-key`).
 * - Strict mode: `OGMError` before anything runs; never warns.
 */
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';
import {
  badNestedShapes,
  legitNestedShapes,
  nestedKeyTypeDefs,
} from './strict-mode.nested-write-keys.cases';
import { Recorded, recordingDriver, Run } from './strict-mode.writes.cases';

const V290: Record<string, string> = {
  'update item: "wher" next to update (renames every post)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nSET n_u0.`title` = $update_posts_0_set_title\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'update item: "updat" (update dropped)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'update item: single object, two unknown keys':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nSET n_u0.`title` = $update_posts_0_set_title\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'update item: per union member':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_media_0:`OWNS`]->(n_u0:`Post`)\nSET n_u0.`title` = $update_media_Post_media_0_set_title\nRETURN count(*) AS _uc_media_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'update item: flat interface input':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_animals_0:`KEEPS`]->(n_u0)\nWHERE (n_u0:`Dog` OR n_u0:`Cat`)\nSET n_u0.`name` = $update_animals_0_set_name\nRETURN count(*) AS _uc_animals_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'update item: two levels down':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nWHERE n_u0.`id` = $param1\nWITH n, n_u0\nCALL {\nWITH n, n_u0\nMATCH (n_u0)-[r_tags_0:`TAGGED`]->(n_u0_u0:`Tag`)\nSET n_u0_u0.`name` = $update_posts_0_tags_0_set_name\nRETURN count(*) AS _uc_tags_0\n}\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'update body: node field beside edge (dropped)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nWHERE n_u0.`id` = $param1\nSET r_posts_0.`role` = $update_posts_0_edge_role\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'update body: "egde" beside node':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nWHERE n_u0.`id` = $param1\nSET n_u0.`title` = $update_posts_0_set_title\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'create item (in update): "egde" beside node':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCREATE (n_cr0:`Post` { `id`: randomUUID(), `title`: $update_posts_0_create0_title })\nCREATE (n)-[:`WROTE`]->(n_cr0)\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'create item (in create): "egde" beside node':
    "CREATE (n:`User` { `id`: randomUUID(), `name`: $create0_name })\nWITH n\nCREATE (n_c0:`Post` { `id`: randomUUID(), `title`: $create0_posts_create0_title })\nCREATE (n)-[:`WROTE`]->(n_c0)\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'create item: per union member':
    "CREATE (n:`User` { `id`: randomUUID(), `name`: $create0_name })\nWITH n\nCREATE (n_c0:`Tag` { `id`: randomUUID(), `name`: $create0_media_Tag_create0_name })\nCREATE (n)-[:`OWNS`]->(n_c0)\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'create field input: "creat" in create()':
    "CREATE (n:`User` { `id`: randomUUID(), `name`: $create0_name })\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'create field input: inside a nested create node':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCREATE (n_cr0:`Post` { `id`: randomUUID(), `title`: $update_posts_0_create0_title })\nCREATE (n)-[:`WROTE`]->(n_cr0)\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'create field input: per union member':
    "CREATE (n:`User` { `id`: randomUUID(), `name`: $create0_name })\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'update items using every item key':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[:`WROTE`]->(n_del0:`Post`)\nWHERE n_del0.`id` = $param1\nDETACH DELETE n_del0\nRETURN count(*) AS _del_posts_0_0\n}\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_disc_posts_0_0:`WROTE`]->(n_disc1:`Post`)\nWHERE n_disc1.`id` = $param2\nDELETE r_disc_posts_0_0\nRETURN count(*) AS _r_disc_posts_0_0\n}\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u2:`Post`)\nWHERE n_u2.`id` = $param3\nSET n_u2.`title` = $update_posts_0_set_title\nSET r_posts_0.`role` = $update_posts_0_edge_role\nRETURN count(*) AS _uc_posts_0\n}\nWITH n\nCALL {\nWITH n\nMATCH (n_conn3:`Post`)\nWHERE n_conn3.`id` = $param4\nMERGE (n)-[r_conn_posts_0:`WROTE`]->(n_conn3)\nSET r_conn_posts_0.`role` = $update_posts_1_conn0_edge_role\nRETURN count(*) AS _cn_posts_0\n}\nWITH n\nCREATE (n_cr4:`Post` { `id`: randomUUID(), `title`: $update_posts_1_create0_title })\nCREATE (n)-[n_cr4_e:`WROTE`]->(n_cr4)\nSET n_cr4_e.`role` = $update_posts_1_create0_edge_role\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'flat update body and flat create item (no wrapper)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nWHERE n_u0.`id` = $param1\nSET n_u0.`title` = $update_posts_0_set_title\nRETURN count(*) AS _uc_posts_0\n}\nWITH n\nCREATE (n_cr1:`Post` { `id`: randomUUID(), `title`: $update_posts_1_create0_title })\nCREATE (n)-[:`WROTE`]->(n_cr1)\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'update body with edge only, node null':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nWHERE n_u0.`id` = $param1\nSET r_posts_0.`role` = $update_posts_0_edge_role\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'an unknown key set to undefined':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nWHERE n_u0.`id` = $param1\nSET n_u0.`title` = $update_posts_0_set_title\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'create() with create + connect':
    "CREATE (n:`User` { `id`: randomUUID(), `name`: $create0_name })\nWITH n\nCALL {\nWITH n\nCREATE (n_c0:`Post` { `id`: randomUUID(), `title`: $create0_posts_create0_title })\nCREATE (n)-[:`WROTE`]->(n_c0)\nWITH n, n_c0\nMATCH (n)-[r_edge_0:`WROTE`]->(n_c0:`Post`)\nSET r_edge_0.`role` = $create0_posts_create0_edge_role\nWITH n, n_c0\nCREATE (n_c0_c0:`Tag` { `id`: randomUUID(), `name`: $create0_posts_create0_tags_create0_name })\nCREATE (n_c0)-[:`TAGGED`]->(n_c0_c0)\nRETURN count(*) AS _cc_create0_posts_0\n}\nWITH n\nCALL {\nWITH n\nMATCH (n_cn1:`Post`)\nWHERE n_cn1.`id` = $param0\nMERGE (n)-[:`WROTE`]->(n_cn1)\nRETURN count(*) AS _ccn_create0_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'union per member, create and update':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_media_0:`OWNS`]->(n_u0:`Post`)\nWHERE n_u0.`id` = $param1\nSET n_u0.`title` = $update_media_Post_media_0_set_title\nRETURN count(*) AS _uc_media_0\n}\nWITH n\nCREATE (n_cr0:`Tag` { `id`: randomUUID(), `name`: $update_media_Tag_media_0_create0_name })\nCREATE (n)-[:`OWNS`]->(n_cr0)\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'flat interface update and create':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_animals_0:`KEEPS`]->(n_u0)\nWHERE (n_u0:`Dog` OR n_u0:`Cat`) AND n_u0.`name` = $param1\nSET n_u0.`name` = $update_animals_0_set_name\nRETURN count(*) AS _uc_animals_0\n}\nWITH n\nCREATE (n_cr1:`Dog` { `name`: $update_animals_1_create0_name })\nCREATE (n)-[:`KEEPS`]->(n_cr1)\nRETURN n { __typename: 'User', .`id`, .`name` }",
};

function setup(strict?: boolean) {
  const records: Recorded[] = [];
  const warnings: string[] = [];
  const ogm = new OGM({
    typeDefs: nestedKeyTypeDefs,
    driver: recordingDriver(records),
    logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
    ...(strict === undefined ? {} : { strict }),
  });
  return { ogm, records, warnings };
}

const STRICT_HINT =
  'Enable `strict: true` (default in 3.0) to throw an OGMError for unknown keys in nested write inputs.';

const bad = Object.entries(badNestedShapes);

describe('strict mode off: Cypher is byte-identical to v2.9.0', () => {
  const cases: [string, Run][] = [
    ...bad.map(([name, s]): [string, Run] => [name, s.run]),
    ...Object.entries(legitNestedShapes),
  ];

  it('covers every shape', () => {
    expect(Object.keys(V290).sort()).toEqual(cases.map(([n]) => n).sort());
  });

  it.each(cases)('%s', async (name, run) => {
    const unset = setup();
    await run(unset.ogm);
    const off = setup(false);
    await run(off.ogm);
    expect(off.records).toEqual(unset.records);
    expect(unset.records.map((r) => r.cypher).join('\n;;\n')).toBe(V290[name]);
  });
});

describe('item 22 — unknown keys in nested write objects', () => {
  it.each(bad)('default warns once: %s', async (_name, s) => {
    const { ogm, warnings } = setup();
    await s.run(ogm);
    await s.run(ogm);
    await s.run(ogm);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      new RegExp(
        `^\\[OGM\\] Unknown key\\(s\\) ${escape(s.keys)} in ${escape(s.what)} on "${s.field}" (is|are) ignored`,
      ),
    );
    expect(warnings[0]).toContain(`Allowed: ${s.allowed}.`);
    expect(warnings[0]).toContain(STRICT_HINT);
  });

  it.each(bad)('strict throws before running: %s', async (_name, s) => {
    const { ogm, records, warnings } = setup(true);
    await expect(s.run(ogm)).rejects.toThrow(
      new OGMError(
        `Unknown key(s) ${s.keys} in ${s.what} on "${s.field}". Allowed: ${s.strictAllowed ?? s.allowed}.`,
      ),
    );
    expect(records).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('names the widening when the item has an update and no "where"', async () => {
    const { ogm, warnings } = setup();
    await badNestedShapes[
      'update item: "wher" next to update (renames every post)'
    ].run(ogm);
    expect(warnings).toEqual([
      '[OGM] Unknown key(s) "wher" in a nested update item on "posts" is ignored; with no "where", ' +
        `the item's "update" applies to EVERY related "Post" node. Allowed: ${ITEM_KEYS}. ${STRICT_HINT}`,
    ]);
  });

  it('reports a key next to a "where" without the widening note', async () => {
    const { ogm, warnings } = setup();
    await badNestedShapes['update item: "updat" (update dropped)'].run(ogm);
    expect(warnings).toEqual([
      `[OGM] Unknown key(s) "updat" in a nested update item on "posts" is ignored. Allowed: ${ITEM_KEYS}. ${STRICT_HINT}`,
    ]);
  });

  it('a different typo on the same field warns again; the same one does not', async () => {
    const { ogm, warnings } = setup();
    const run = (key: string) =>
      ogm.model('User').update({
        where: { id: 'u1' },
        update: { posts: [{ where: { node: { id: 'p1' } }, [key]: 1 }] },
      });
    await run('updat');
    await run('updat');
    await run('udpate');
    expect(warnings).toHaveLength(2);
  });

  it.each(Object.entries(legitNestedShapes))(
    'legitimate shape never warns and compiles the same strict: %s',
    async (_name, run) => {
      const lenient = setup();
      await run(lenient.ogm);
      expect(lenient.warnings).toEqual([]);
      const strict = setup(true);
      await run(strict.ogm);
      expect(strict.records).toEqual(lenient.records);
    },
  );
});

const ITEM_KEYS =
  '"where", "update", "connect", "disconnect", "create", "delete"';

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
