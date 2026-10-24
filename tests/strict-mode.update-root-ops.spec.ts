/**
 * vNEXT — strict item 45: the @neo4j/graphql 5.x relationship ops of
 * `update()`: a `connectOrCreate` in a nested update item, and a root
 * `create` / `connectOrCreate` / `delete`.
 *
 * - Default mode: ignored, as before (strict items 22 and 34 warn once);
 *   the Cypher is byte-identical to v2.20.1 (hard-coded below, captured
 *   from main @ a962f44).
 * - Strict mode: applied, in @neo4j/graphql's order (delete, disconnect,
 *   update, connect, connectOrCreate, create), without warnings.
 */
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';
import {
  rootOpShapes,
  rootOpsTypeDefs,
} from './strict-mode.update-root-ops.cases';
import { Recorded, recordingDriver, Run } from './strict-mode.writes.cases';

const V2201: Record<string, string> = {
  'nested connectOrCreate':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'root create':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'root connectOrCreate':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'root delete':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'updateMany: nested connectOrCreate':
    'MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN count(n) AS count',
};

const STRICT: Record<string, string> = {
  'nested connectOrCreate': [
    'MATCH (n:`User`)',
    'WHERE n.`id` = $param0',
    'SET n.`name` = $update_name',
    'WITH n',
    'CALL {',
    'WITH n',
    'MERGE (n_coc0:`Post` { `slug`: $update_posts_0_coc0_where_slug })',
    'ON CREATE SET n_coc0 += { `id`: randomUUID(), `title`: $update_posts_0_coc0_create_title, `views`: $update_posts_0_coc0_create_views }',
    'MERGE (n)-[n_coc0_e:`WROTE`]->(n_coc0)',
    'ON CREATE SET n_coc0_e.`role` = $update_posts_0_coc0_edge_role, n_coc0_e.`since` = $update_posts_0_coc0_edge_since',
    'RETURN count(*) AS _coc_posts_0',
    '}',
    "RETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  ].join('\n'),
  'root create': [
    'MATCH (n:`User`)',
    'WHERE n.`id` = $param0',
    'SET n.`name` = $update_name',
    'WITH n',
    'CREATE (n_cr0:`Post` { `id`: randomUUID(), `title`: $create_posts_0_create0_title, `views`: $create_posts_0_create0_views })',
    'CREATE (n)-[n_cr0_e:`WROTE`]->(n_cr0)',
    'SET n_cr0_e.`role` = $create_posts_0_create0_edge_role, n_cr0_e.`since` = $create_posts_0_create0_edge_since',
    "RETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  ].join('\n'),
  'root connectOrCreate': [
    'MATCH (n:`User`)',
    'WHERE n.`id` = $param0',
    'WITH n',
    'CALL {',
    'WITH n',
    'MERGE (n_coc0:`Post` { `slug`: $connectOrCreate_posts_0_coc0_where_slug })',
    'ON CREATE SET n_coc0 += { `id`: randomUUID(), `title`: $connectOrCreate_posts_0_coc0_create_title, `views`: $connectOrCreate_posts_0_coc0_create_views }',
    'MERGE (n)-[n_coc0_e:`WROTE`]->(n_coc0)',
    'ON CREATE SET n_coc0_e.`since` = $connectOrCreate_posts_0_coc0_edge_since',
    'RETURN count(*) AS _coc_posts_0',
    '}',
    "RETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  ].join('\n'),
  'root delete': [
    'MATCH (n:`User`)',
    'WHERE n.`id` = $param0',
    'WITH n',
    'CALL {',
    'WITH n',
    'MATCH (n)-[:`WROTE`]->(n_del0:`Post`)',
    'WHERE n_del0.`slug` = $param1',
    'DETACH DELETE n_del0',
    'RETURN count(*) AS _del_posts_0_0',
    '}',
    "RETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  ].join('\n'),
  'updateMany: nested connectOrCreate': [
    'MATCH (n:`User`)',
    'WHERE n.`id` = $param0',
    'WITH n',
    'CALL {',
    'WITH n',
    'MERGE (n_coc0:`Post` { `slug`: $update_posts_0_coc0_where_slug })',
    'ON CREATE SET n_coc0 += { `id`: randomUUID(), `views`: $update_posts_0_coc0_create_views }',
    'MERGE (n)-[n_coc0_e:`WROTE`]->(n_coc0)',
    'ON CREATE SET n_coc0_e.`since` = $update_posts_0_coc0_edge_since',
    'RETURN count(*) AS _coc_posts_0',
    '}',
    'RETURN count(n) AS count',
  ].join('\n'),
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

const shapes = Object.entries(rootOpShapes);
const users = (ogm: OGM) => ogm.model('User');
const extra = <T extends object>(o: T): T => o;
/** An input of the wrong shape, for the runtime check. */
type UpdateParams = Parameters<ReturnType<typeof users>['update']>[0];
const loose = (o: object): UpdateParams => o as UpdateParams;

describe('strict mode off: Cypher is byte-identical to v2.20.1', () => {
  it('covers every shape', () => {
    expect(Object.keys(V2201).sort()).toEqual(shapes.map(([n]) => n).sort());
  });

  it.each(shapes)('%s', async (name, run) => {
    const unset = setup();
    await run(unset.ogm);
    const off = setup(false);
    await run(off.ogm);
    expect(off.records).toEqual(unset.records);
    expect(unset.records.map((r) => r.cypher).join('\n;;\n')).toBe(V2201[name]);
  });

  it.each(shapes)('%s warns once that it is ignored', async (_name, run) => {
    const { ogm, warnings } = setup();
    await run(ogm);
    await run(ogm);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/ignored/);
    expect(warnings[0]).toMatch(/only with `strict: true`/);
  });
});

describe('item 45 — strict mode applies the upstream update ops', () => {
  it.each(shapes)('%s', async (name, run) => {
    const { ogm, records, warnings } = setup(true);
    await run(ogm);
    expect(records.map((r) => r.cypher).join('\n;;\n')).toBe(STRICT[name]);
    expect(warnings).toEqual([]);
  });

  it('binds the key, onCreate fields and edge values as params', async () => {
    const { ogm, records } = setup(true);
    await rootOpShapes['nested connectOrCreate'](ogm);
    expect(records[0].params).toMatchObject({
      update_posts_0_coc0_where_slug: 's1',
      update_posts_0_coc0_create_title: 't1',
      update_posts_0_coc0_edge_role: 'r',
    });
  });

  it('runs root ops in @neo4j/graphql order: delete, disconnect, update, connect, connectOrCreate, create', async () => {
    const { ogm, records } = setup(true);
    await users(ogm).update({
      where: { id: 'u1' },
      create: { posts: [{ node: { title: 'c' } }] },
      connectOrCreate: {
        posts: [{ where: { node: { slug: 'k' } }, onCreate: { node: {} } }],
      },
      connect: { posts: [{ where: { node: { slug: 'x' } } }] },
      update: { name: 'n' },
      disconnect: { posts: [{ where: { node: { slug: 'y' } } }] },
      delete: { posts: [{ where: { node: { slug: 'z' } } }] },
    });
    const cypher = records[0].cypher;
    const at = (s: string) => {
      const i = cypher.indexOf(s);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('DETACH DELETE n_del0'),
      at('DELETE r_posts_0'),
      at('SET n.`name`'),
      at('MERGE (n)-[r:`WROTE`]->(target)'),
      at('MERGE (n_coc0:`Post`'),
      at('CREATE (n_cr0:`Post`'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('a nested connectOrCreate runs after connect and before create', async () => {
    const { ogm, records } = setup(true);
    await users(ogm).update({
      where: { id: 'u1' },
      update: {
        posts: [
          {
            create: [{ node: { title: 'c' } }],
            connectOrCreate: [
              { where: { node: { slug: 'k' } }, onCreate: { node: {} } },
            ],
            connect: [{ where: { node: { slug: 'x' } } }],
          },
        ],
      },
    });
    const cypher = records[0].cypher;
    const conn = cypher.indexOf('MATCH (n_conn0:`Post`)');
    const coc = cypher.indexOf('MERGE (n_coc1:`Post`');
    const cr = cypher.indexOf('CREATE (n_cr2:`Post`');
    expect(conn).toBeGreaterThan(-1);
    expect(coc).toBeGreaterThan(conn);
    expect(cr).toBeGreaterThan(coc);
  });

  it('per union member, and in a single (non-list) relationship', async () => {
    const { ogm, records } = setup(true);
    await users(ogm).update({
      where: { id: 'u1' },
      update: {
        media: {
          Tag: [
            {
              connectOrCreate: [
                {
                  where: { node: { name: 'go' } },
                  onCreate: { node: { label: 'Go' } },
                },
              ],
            },
          ],
        },
        best: {
          connectOrCreate: {
            where: { node: { id: 'p9' } },
            onCreate: { node: { title: 'Best' } },
          },
        },
      },
    });
    const cypher = records[0].cypher;
    expect(cypher).toContain(
      'MERGE (n_coc0:`Tag` { `name`: $update_media_Tag_media_0_coc0_where_name })',
    );
    expect(cypher).toContain(
      'ON CREATE SET n_coc0 += { `label`: $update_media_Tag_media_0_coc0_create_label }',
    );
    expect(cypher).toContain('MERGE (n)-[:`HAS_MEDIA`]->(n_coc0)');
    // An @id key is matched as given: no generated id overrides it.
    expect(cypher).toContain(
      'MERGE (n_coc0:`Post` { `id`: $update_best_0_coc0_where_id })',
    );
    expect(cypher).toContain(
      'ON CREATE SET n_coc0 += { `title`: $update_best_0_coc0_create_title, `views`: $update_best_0_coc0_create_views }',
    );
  });

  it('a key repeated in onCreate.node with the same value is accepted and not set twice', async () => {
    const { ogm, records } = setup(true);
    await users(ogm).update({
      where: { id: 'u1' },
      connectOrCreate: {
        posts: [
          {
            where: { node: { slug: 'k' } },
            onCreate: { node: { slug: 'k', title: 't' } },
          },
        ],
      },
    });
    expect(records[0].cypher).toContain(
      'ON CREATE SET n_coc0 += { `id`: randomUUID(), `title`: $connectOrCreate_posts_0_coc0_create_title, `views`: $connectOrCreate_posts_0_coc0_create_views }',
    );
  });

  it('a root delete per union member', async () => {
    const { ogm, records } = setup(true);
    await users(ogm).update({
      where: { id: 'u1' },
      delete: { media: { Tag: [{ where: { node: { name: 'go' } } }] } },
    });
    expect(records[0].cypher).toContain(
      'MATCH (n)-[:`HAS_MEDIA`]->(n_del0:`Tag`)',
    );
  });

  const invalid: [string, Run, string | RegExp][] = [
    [
      'a where key that is not @unique / @id',
      (ogm) =>
        users(ogm).update({
          where: { id: 'u1' },
          update: {
            posts: [
              {
                connectOrCreate: [
                  extra({
                    where: { node: { title: 't' } },
                    onCreate: { node: {} },
                  }),
                ],
              },
            ],
          },
        }),
      '"title" in the connectOrCreate "where" on "posts" is not a @unique or @id field of Post: connectOrCreate matches on a unique key.',
    ],
    [
      'a null key',
      (ogm) =>
        users(ogm).update(
          extra({
            where: { id: 'u1' },
            connectOrCreate: {
              posts: [
                { where: { node: { slug: null } }, onCreate: { node: {} } },
              ],
            },
          }),
        ),
      /is null: the key of a connectOrCreate needs a value/,
    ],
    [
      'an empty where.node',
      (ogm) =>
        users(ogm).update({
          where: { id: 'u1' },
          connectOrCreate: {
            posts: [{ where: { node: {} }, onCreate: { node: {} } }],
          },
        }),
      /"where.node" on "posts" is empty/,
    ],
    [
      'no onCreate',
      (ogm) =>
        users(ogm).update(
          extra({
            where: { id: 'u1' },
            connectOrCreate: { posts: [{ where: { node: { slug: 'k' } } }] },
          }),
        ),
      /needs "onCreate: \{ node: \{ … \} \}"/,
    ],
    [
      'an unknown key in the item',
      (ogm) =>
        users(ogm).update(
          extra({
            where: { id: 'u1' },
            connectOrCreate: {
              posts: [
                {
                  where: { node: { slug: 'k' } },
                  onCreate: { node: {} },
                  edge: { role: 'r' },
                },
              ],
            },
          }),
        ),
      'Unknown key(s) "edge" in a connectOrCreate item on "posts". Allowed: "where", "onCreate".',
    ],
    [
      'a relationship in onCreate.node',
      (ogm) =>
        users(ogm).update(
          extra({
            where: { id: 'u1' },
            connectOrCreate: {
              best: {
                where: { node: { id: 'p' } },
                onCreate: { node: { tags: {} } },
              },
            },
          }),
        ),
      '"tags" in the connectOrCreate "onCreate.node" on "best" is a relationship: onCreate takes the fields of Post only.',
    ],
    [
      'onCreate.node changing the key',
      (ogm) =>
        users(ogm).update({
          where: { id: 'u1' },
          connectOrCreate: {
            posts: [
              {
                where: { node: { slug: 'k' } },
                onCreate: { node: { slug: 'other' } },
              },
            ],
          },
        }),
      /differs from its "where.node" value/,
    ],
    [
      'an interface target in the flat shape',
      (ogm) =>
        users(ogm).update(
          extra({
            where: { id: 'u1' },
            update: {
              animals: [
                {
                  connectOrCreate: [
                    {
                      where: { node: { name: 'rex' } },
                      onCreate: { node: {} },
                    },
                  ],
                },
              ],
            },
          }),
        ),
      /connectOrCreate on "animals" \(interface "Animal"\) must be keyed by the member type/,
    ],
    [
      'an unknown relationship in a root op',
      (ogm) =>
        users(ogm).update(
          extra({ where: { id: 'u1' }, create: { pets: [{ node: {} }] } }),
        ),
      'Unknown relationship "pets" in the root "create" of User.update(): it is not a relationship field of the type.',
    ],
    [
      'a root op that is not an object',
      (ogm) =>
        users(ogm).update(loose({ where: { id: 'u1' }, delete: ['posts'] })),
      'The root "delete" of User.update() must be an object keyed by relationship field.',
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
