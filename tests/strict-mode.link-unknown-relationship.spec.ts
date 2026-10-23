/**
 * vNEXT — strict item 28: a connect / disconnect map keyed by a name that
 * is not a relationship of the type (root, or the nested `connect` /
 * `disconnect` of an item at any depth). Pre-vNEXT the key was skipped,
 * so the write ran without it and reported success, while a cascade
 * `delete` threw for the same mistake.
 *
 * - Default mode: byte-identical to v2.15.0 (hard-coded below, captured
 *   from main @ 6572bdc); warns once per OGM, type, kind and key
 *   (`connect-unknown-relationship` / `disconnect-unknown-relationship`).
 * - Strict mode: `OGMError` before anything runs; never warns.
 */
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';
import {
  badLinkShapes,
  legitLinkShapes,
  linkTypeDefs,
} from './strict-mode.link-unknown-relationship.cases';
import { Recorded, recordingDriver, Run } from './strict-mode.writes.cases';

const V2150: Record<string, string> = {
  'root connect: "post" for "posts"':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'root connect: a scalar field':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'root connect: unknown next to a known one':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nUNWIND $connect_posts AS connItem\nMATCH (target:`Post`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[:`WROTE`]->(target)\nRETURN count(*) AS _conn_posts\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'root disconnect: "post" for "posts"':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'root disconnect: null value':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'connect inside a root connect item':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (target_posts_0:`Post`)\nWHERE target_posts_0.`id` = $param1\nMERGE (n)-[:`WROTE`]->(target_posts_0)\nRETURN count(*) AS _ccn_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'disconnect inside a root disconnect item':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->(target_posts_0:`Post`)\nWHERE target_posts_0.`id` = $param1\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'connect inside a nested update connect item':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n_conn0:`Post`)\nWHERE n_conn0.`id` = $param1\nMERGE (n)-[:`WROTE`]->(n_conn0)\nRETURN count(*) AS _cn_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'disconnect inside a nested update disconnect item':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_disc_posts_0_0:`WROTE`]->(n_disc0:`Post`)\nWHERE n_disc0.`id` = $param1\nDELETE r_disc_posts_0_0\nRETURN count(*) AS _r_disc_posts_0_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'connect inside a create() connect item':
    "CREATE (n:`User` { `id`: randomUUID(), `name`: $create0_name })\nWITH n\nCALL {\nWITH n\nMATCH (n_cn0:`Post`)\nWHERE n_cn0.`id` = $param0\nMERGE (n)-[:`WROTE`]->(n_cn0)\nRETURN count(*) AS _ccn_create0_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'root connect and disconnect on known relationships':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->(target_posts_0:`Post`)\nWHERE target_posts_0.`id` = $param1\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nWITH n\nCALL {\nWITH n\nUNWIND $connect_posts AS connItem\nMATCH (target:`Post`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[:`WROTE`]->(target)\nRETURN count(*) AS _conn_posts\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'an unknown key set to undefined':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nUNWIND $connect_posts AS connItem\nMATCH (target:`Post`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[:`WROTE`]->(target)\nRETURN count(*) AS _conn_posts\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'nested connect on a known relationship':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (target_posts_0:`Post`)\nWHERE target_posts_0.`id` = $param1\nMERGE (n)-[:`WROTE`]->(target_posts_0)\nWITH n, target_posts_0\nCALL {\nWITH n, target_posts_0\nUNWIND $connect_posts_0_connect_tags AS connItem\nMATCH (connect_posts_0_target:`Tag`)\nWHERE connect_posts_0_target.`id` = connItem.where.node.id\nMERGE (target_posts_0)-[:`TAGGED`]->(connect_posts_0_target)\nRETURN count(*) AS _conn_connect_posts_0_tags\n}\nRETURN count(*) AS _ccn_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'nested connect through a union / interface member':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (target_animals_Dog_0:`Dog`)\nWHERE target_animals_Dog_0.`name` = $param1\nMERGE (n)-[:`KEEPS`]->(target_animals_Dog_0)\nWITH n, target_animals_Dog_0\nCALL {\nWITH n, target_animals_Dog_0\nUNWIND $connect_animals_Dog_0_connect_toys AS connItem\nMATCH (connect_animals_Dog_0_target:`Toy`)\nWHERE connect_animals_Dog_0_target.`id` = connItem.where.node.id\nMERGE (target_animals_Dog_0)-[:`PLAYS`]->(connect_animals_Dog_0_target)\nRETURN count(*) AS _conn_connect_animals_Dog_0_toys\n}\nRETURN count(*) AS _ccn_animals_Dog_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'nested connect / disconnect on known relationships in update and create':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_disc_posts_0_0:`WROTE`]->(n_disc0:`Post`)\nWHERE n_disc0.`id` = $param1\nDELETE r_disc_posts_0_0\nWITH n, n_disc0\nCALL {\nWITH n, n_disc0\nOPTIONAL MATCH (n_disc0)-[update_posts_0_disc0_r_tags_0:`TAGGED`]->(update_posts_0_disc0_target_tags_0:`Tag`)\nWHERE update_posts_0_disc0_target_tags_0.`id` = $param2\nDELETE update_posts_0_disc0_r_tags_0\nRETURN count(*) AS _update_posts_0_disc0_r_tags_0\n}\nRETURN count(*) AS _r_disc_posts_0_0\n}\nWITH n\nCALL {\nWITH n\nMATCH (n_conn1:`Post`)\nWHERE n_conn1.`id` = $param3\nMERGE (n)-[:`WROTE`]->(n_conn1)\nWITH n, n_conn1\nCALL {\nWITH n, n_conn1\nUNWIND $update_posts_0_conn0_connect_tags AS connItem\nMATCH (update_posts_0_conn0_target:`Tag`)\nWHERE update_posts_0_conn0_target.`id` = connItem.where.node.id\nMERGE (n_conn1)-[:`TAGGED`]->(update_posts_0_conn0_target)\nRETURN count(*) AS _conn_update_posts_0_conn0_tags\n}\nRETURN count(*) AS _cn_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }\n;;\nCREATE (n:`User` { `id`: randomUUID(), `name`: $create0_name })\nWITH n\nCALL {\nWITH n\nMATCH (n_cn0:`Post`)\nWHERE n_cn0.`id` = $param0\nMERGE (n)-[:`WROTE`]->(n_cn0)\nWITH n, n_cn0\nCALL {\nWITH n, n_cn0\nUNWIND $create0_posts_conn0_connect_tags AS connItem\nMATCH (create0_posts_conn0_target:`Tag`)\nWHERE create0_posts_conn0_target.`id` = connItem.where.node.id\nMERGE (n_cn0)-[:`TAGGED`]->(create0_posts_conn0_target)\nRETURN count(*) AS _conn_create0_posts_conn0_tags\n}\nRETURN count(*) AS _ccn_create0_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name` }",
};

function setup(strict?: boolean) {
  const records: Recorded[] = [];
  const warnings: string[] = [];
  const ogm = new OGM({
    typeDefs: linkTypeDefs,
    driver: recordingDriver(records),
    logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
    ...(strict === undefined ? {} : { strict }),
  });
  return { ogm, records, warnings };
}

const bad = Object.entries(badLinkShapes);

describe('strict mode off: Cypher is byte-identical to v2.15.0', () => {
  const cases: [string, Run][] = [
    ...bad.map(([name, s]): [string, Run] => [name, s.run]),
    ...Object.entries(legitLinkShapes),
  ];

  it('covers every shape', () => {
    expect(Object.keys(V2150).sort()).toEqual(cases.map(([n]) => n).sort());
  });

  it.each(cases)('%s', async (name, run) => {
    const unset = setup();
    await run(unset.ogm);
    const off = setup(false);
    await run(off.ogm);
    expect(off.records).toEqual(unset.records);
    expect(unset.records.map((r) => r.cypher).join('\n;;\n')).toBe(V2150[name]);
  });
});

describe('item 28 — unknown relationship in a connect / disconnect map', () => {
  it.each(bad)('default warns once: %s', async (_name, s) => {
    const { ogm, warnings } = setup();
    await s.run(ogm);
    await s.run(ogm);
    expect(warnings).toEqual([
      `[OGM] Unknown relationship "${s.field}" in the ${s.kind} input of ${s.type} is ignored: it is not a ` +
        `relationship field of the type, so nothing is ${s.kind}ed for it. Enable \`strict: true\` ` +
        `(default in 3.0) to throw an OGMError for unknown relationships in ${s.kind} inputs.`,
    ]);
  });

  it.each(bad)('strict throws before running: %s', async (_name, s) => {
    const { ogm, records, warnings } = setup(true);
    await expect(s.run(ogm)).rejects.toThrow(
      new OGMError(
        `Unknown relationship "${s.field}" in the ${s.kind} input of ${s.type}: it is not a relationship ` +
          `field of the type. Declare it in the schema, or fix the key.`,
      ),
    );
    expect(records).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('a different unknown key warns again', async () => {
    const { ogm, warnings } = setup();
    const run = (key: string) =>
      ogm.model('User').update({ where: { id: 'u1' }, connect: { [key]: [] } });
    await run('post');
    await run('post');
    await run('psots');
    expect(warnings).toHaveLength(2);
  });

  it.each(Object.entries(legitLinkShapes))(
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
