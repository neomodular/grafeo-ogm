/**
 * vNEXT — strict item 43: `connectOrCreate` in a create field input
 * (`create()`, and the relationship fields of every nested create).
 *
 * - Default mode: ignored, as before (strict item 22 warns once); the
 *   Cypher is byte-identical to v2.22.0 (hard-coded below, captured from
 *   main @ ad90081).
 * - Strict mode: applied after the field input's `create` and `connect`,
 *   with the update item's compiler (MERGE on the unique key, CALL-wrapped
 *   so every created node keeps its row), without warnings.
 */
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';
import { createCocShapes } from './strict-mode.create-connect-or-create.cases';
import { rootOpsTypeDefs } from './strict-mode.update-root-ops.cases';
import { Recorded, recordingDriver, Run } from './strict-mode.writes.cases';

const V2220: Record<string, string> = {
  'create: connectOrCreate':
    "CREATE (n:`User` { `id`: randomUUID(), `email`: $create0_email })\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'create: connectOrCreate after create and connect, two inputs':
    "CREATE (n:`User` { `id`: randomUUID(), `email`: $create0_email })\nWITH n\nCREATE (n_c0:`Post` { `id`: randomUUID(), `title`: $create0_posts_create0_title, `views`: $create0_posts_create0_views })\nCREATE (n)-[:`WROTE`]->(n_c0)\nWITH n\nCALL {\nWITH n\nMATCH (n_cn1:`Post`)\nWHERE n_cn1.`slug` = $param0\nMERGE (n)-[:`WROTE`]->(n_cn1)\nRETURN count(*) AS _ccn_create0_posts_0\n}\nCREATE (n_1:`User` { `id`: randomUUID(), `email`: $create1_email })\nWITH [n, n_1] AS __created\nUNWIND __created AS n\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'create: connectOrCreate in a nested create, per union member':
    "CREATE (n:`User` { `id`: randomUUID(), `email`: $create0_email })\nWITH n\nCREATE (n_c0:`Post` { `id`: randomUUID(), `title`: $create0_posts_create0_title, `views`: $create0_posts_create0_views })\nCREATE (n)-[:`WROTE`]->(n_c0)\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'update: connectOrCreate in a nested create of an update item':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCREATE (n_cr0:`Post` { `id`: randomUUID(), `title`: $update_posts_0_create0_title, `views`: $update_posts_0_create0_views })\nCREATE (n)-[:`WROTE`]->(n_cr0)\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
};

const STRICT: Record<string, string> = {
  'create: connectOrCreate':
    "CREATE (n:`User` { `id`: randomUUID(), `email`: $create0_email })\nWITH n\nCALL {\nWITH n\nMERGE (n_coc0:`Post` { `slug`: $create0_posts_coc0_where_slug })\nON CREATE SET n_coc0 += { `id`: randomUUID(), `title`: $create0_posts_coc0_create_title, `views`: $create0_posts_coc0_create_views }\nMERGE (n)-[n_coc0_e:`WROTE`]->(n_coc0)\nON CREATE SET n_coc0_e.`role` = $create0_posts_coc0_edge_role, n_coc0_e.`since` = $create0_posts_coc0_edge_since\nRETURN count(*) AS _ccoc_create0_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'create: connectOrCreate after create and connect, two inputs':
    "CREATE (n:`User` { `id`: randomUUID(), `email`: $create0_email })\nWITH n\nCREATE (n_c0:`Post` { `id`: randomUUID(), `title`: $create0_posts_create0_title, `views`: $create0_posts_create0_views })\nCREATE (n)-[:`WROTE`]->(n_c0)\nWITH n, n_c0\nMATCH (n)-[r_edge_0:`WROTE`]->(n_c0:`Post`)\nSET r_edge_0.`since` = $create0_posts_create0_edge_since\nWITH n\nCALL {\nWITH n\nMATCH (n_cn1:`Post`)\nWHERE n_cn1.`slug` = $param0\nMERGE (n)-[r_conn_1:`WROTE`]->(n_cn1)\nON CREATE SET r_conn_1.`since` = $create0_posts_conn0_edge_since\nRETURN count(*) AS _ccn_create0_posts_0\n}\nWITH n\nCALL {\nWITH n\nMERGE (n_coc2:`Post` { `slug`: $create0_posts_coc0_where_slug })\nON CREATE SET n_coc2 += { `id`: randomUUID(), `views`: $create0_posts_coc0_create_views }\nMERGE (n)-[n_coc2_e:`WROTE`]->(n_coc2)\nON CREATE SET n_coc2_e.`since` = $create0_posts_coc0_edge_since\nRETURN count(*) AS _ccoc_create0_posts_0\n}\nCREATE (n_1:`User` { `id`: randomUUID(), `email`: $create1_email })\nWITH n, n_1\nCALL {\nWITH n, n_1\nMERGE (n_1_coc0:`Post` { `slug`: $create1_best_coc0_where_slug })\nON CREATE SET n_1_coc0 += { `id`: randomUUID(), `title`: $create1_best_coc0_create_title, `views`: $create1_best_coc0_create_views }\nMERGE (n_1)-[:`BEST`]->(n_1_coc0)\nRETURN count(*) AS _ccoc_create1_best_0\n}\nWITH [n, n_1] AS __created\nUNWIND __created AS n\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'create: connectOrCreate in a nested create, per union member':
    "CREATE (n:`User` { `id`: randomUUID(), `email`: $create0_email })\nWITH n\nCALL {\nWITH n\nCREATE (n_c0:`Post` { `id`: randomUUID(), `title`: $create0_posts_create0_title, `views`: $create0_posts_create0_views })\nCREATE (n)-[:`WROTE`]->(n_c0)\nWITH n, n_c0\nMATCH (n)-[r_edge_0:`WROTE`]->(n_c0:`Post`)\nSET r_edge_0.`since` = $create0_posts_create0_edge_since\nWITH n, n_c0\nCALL {\nWITH n, n_c0\nMERGE (n_c0_coc0:`Tag` { `name`: $create0_posts_create0_tags_coc0_where_name })\nON CREATE SET n_c0_coc0 += { `label`: $create0_posts_create0_tags_coc0_create_label }\nMERGE (n_c0)-[:`TAGGED`]->(n_c0_coc0)\nRETURN count(*) AS _ccoc_create0_posts_create0_tags_0\n}\nRETURN count(*) AS _cc_create0_posts_0\n}\nWITH n\nCALL {\nWITH n\nMERGE (n_coc1:`Tag` { `name`: $create0_media_Tag_coc0_where_name })\nMERGE (n)-[:`HAS_MEDIA`]->(n_coc1)\nRETURN count(*) AS _ccoc_create0_media_Tag_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'update: connectOrCreate in a nested create of an update item':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nCREATE (n_cr0:`Post` { `id`: randomUUID(), `title`: $update_posts_0_create0_title, `views`: $update_posts_0_create0_views })\nCREATE (n)-[n_cr0_e:`WROTE`]->(n_cr0)\nSET n_cr0_e.`since` = $update_posts_0_create0_edge_since\nWITH n, n_cr0\nCALL {\nWITH n, n_cr0\nMERGE (n_cr0_coc0:`Tag` { `name`: $update_posts_0_create0_tags_coc0_where_name })\nMERGE (n_cr0)-[:`TAGGED`]->(n_cr0_coc0)\nRETURN count(*) AS _ccoc_update_posts_0_create0_tags_0\n}\nRETURN count(*) AS _cc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
};

function setup(strict?: boolean) {
  const records: Recorded[] = [];
  const warnings: string[] = [];
  const ogm = new OGM({
    typeDefs: rootOpsTypeDefs,
    driver: recordingDriver(records),
    logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
    ...(strict === undefined ? {} : { strict }),
  });
  return { ogm, records, warnings };
}

const shapes = Object.entries(createCocShapes);
const users = (ogm: OGM) => ogm.model('User');
type CreateParams = Parameters<ReturnType<typeof users>['create']>[0];
const loose = (o: object): CreateParams => o as CreateParams;

describe('strict mode off: Cypher is byte-identical to v2.22.0', () => {
  it('covers every shape', () => {
    expect(Object.keys(V2220).sort()).toEqual(shapes.map(([n]) => n).sort());
  });

  it.each(shapes)('%s', async (name, run) => {
    const unset = setup();
    await run(unset.ogm);
    const off = setup(false);
    await run(off.ogm);
    expect(off.records).toEqual(unset.records);
    expect(unset.records.map((r) => r.cypher).join('\n;;\n')).toBe(V2220[name]);
  });

  it.each(shapes)('%s warns that it is ignored', async (_name, run) => {
    const { ogm, warnings } = setup();
    await run(ogm);
    await run(ogm);
    const coc = warnings.filter((w) => w.includes('"connectOrCreate"'));
    expect(coc.length).toBeGreaterThan(0);
    for (const w of coc) {
      expect(w).toContain('in the nested create input on');
      expect(w).toContain(
        '"connectOrCreate" is applied only with `strict: true`.',
      );
    }
  });
});

describe('item 43 — strict mode applies connectOrCreate in a create field input', () => {
  it.each(shapes)('%s', async (name, run) => {
    const { ogm, records, warnings } = setup(true);
    await run(ogm);
    expect(records.map((r) => r.cypher).join('\n;;\n')).toBe(STRICT[name]);
    expect(warnings).toEqual([]);
  });

  it('binds the key, onCreate fields and edge values as params', async () => {
    const { ogm, records } = setup(true);
    await createCocShapes['create: connectOrCreate'](ogm);
    expect(records[0].params).toMatchObject({
      create0_posts_coc0_where_slug: 's1',
      create0_posts_coc0_create_title: 't1',
      create0_posts_coc0_edge_role: 'r',
    });
  });

  const invalid: [string, Run, string | RegExp][] = [
    [
      'a key that is not @unique / @id',
      (ogm) =>
        users(ogm).create(
          loose({
            input: [
              {
                email: 'a@x',
                posts: {
                  connectOrCreate: [
                    { where: { node: { title: 't' } }, onCreate: { node: {} } },
                  ],
                },
              },
            ],
          }),
        ),
      '"title" in the connectOrCreate "where" on "posts" is not a @unique or @id field of Post',
    ],
    [
      'a flat interface target',
      (ogm) =>
        users(ogm).create(
          loose({
            input: [
              {
                email: 'a@x',
                animals: {
                  connectOrCreate: [
                    {
                      where: { node: { name: 'rex' } },
                      onCreate: { node: {} },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      /connectOrCreate on "animals" \(interface "Animal"\) must be keyed by the member type/,
    ],
    [
      'an item that is not an object',
      (ogm) =>
        users(ogm).create(
          loose({
            input: [{ email: 'a@x', posts: { connectOrCreate: ['s1'] } }],
          }),
        ),
      'A connectOrCreate item on "posts" must be an object',
    ],
    [
      'an unknown key in the item',
      (ogm) =>
        users(ogm).create(
          loose({
            input: [
              {
                email: 'a@x',
                posts: {
                  connectOrCreate: [
                    {
                      where: { node: { slug: 's' } },
                      onCreate: { node: {} },
                      onMatch: {},
                    },
                  ],
                },
              },
            ],
          }),
        ),
      'Unknown key(s) "onMatch" in a connectOrCreate item on "posts".',
    ],
  ];

  it.each(invalid)(
    'throws OGMError before running: %s',
    async (_n, run, msg) => {
      const { ogm, records } = setup(true);
      await expect(run(ogm)).rejects.toThrow(OGMError);
      await expect(run(ogm)).rejects.toThrow(msg);
      expect(records).toEqual([]);
    },
  );
});
