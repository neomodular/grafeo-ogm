/**
 * vNEXT — strict item 30: top-level params a Model / InterfaceModel method
 * does not read. Pre-vNEXT they were ignored: an upstream-style
 * `update({ where, delete })` deleted nothing, `deleteMany({ where,
 * delete })` did not cascade, and `delete({ where, labels })` deleted
 * without the label filter.
 *
 * - Default mode: byte-identical to v2.15.0 (hard-coded below, captured
 *   from main @ 6572bdc); warns once per OGM, owner and key set
 *   (`unknown-param`).
 * - Strict mode: `OGMError` before anything runs; never warns.
 */
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';
import {
  badParamShapes,
  legitParamShapes,
  paramsTypeDefs,
} from './strict-mode.unknown-params.cases';
import { Recorded, recordingDriver, Run } from './strict-mode.writes.cases';

const V2150: Record<string, string> = {
  'update() with an upstream-style root "delete"':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'update() with a root "create"':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'update() with "data"':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'deleteMany() with a cascade "delete"':
    'MATCH (n:`User`)\nWHERE n.`id` = $param0\nDETACH DELETE n',
  'deleteMany() with "labels"':
    'MATCH (n:`User`)\nWHERE n.`id` = $param0\nDETACH DELETE n',
  'delete() with "labels"':
    'MATCH (n:`User`)\nWHERE n.`id` = $param0\nDETACH DELETE n',
  'find() with a Prisma-style "orderBy" and "take"':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'findFirst() with "sort"':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH *\nLIMIT $options_limit\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'findUnique() with "include"':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH *\nLIMIT $options_limit\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'create() with "skipDuplicates"':
    "CREATE (n:`User` { `id`: randomUUID(), `name`: $create0_name })\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'createMany() with "select"':
    'UNWIND $items AS item\nCREATE (n:`User` { `id`: randomUUID(), `name`: item.`name` })\nRETURN count(n) AS count',
  'updateMany() with "update" beside "data"':
    'MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nRETURN count(n) AS count',
  'upsert() with "connect"':
    "MERGE (n:`User` { `name`: $merge_name })\nON CREATE SET n.`name` = $onCreate_name, n.`id` = randomUUID()\nRETURN n { __typename: 'User', .`id`, .`name` }",
  'count() with "options"':
    'MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN count(n) AS count',
  'aggregate() with "options"':
    'MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN count(n) AS count',
  'setLabels() with "labels"':
    'MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n:`Vip`',
  'InterfaceModel find() with "select"':
    "MATCH (n:(`Dog`|`Cat`))\nWHERE n.`name` = $param0\nWITH n, CASE WHEN n:`Dog` THEN 'Dog' WHEN n:`Cat` THEN 'Cat' END AS __typename\nRETURN n { __typename: head([__label IN labels(n) WHERE __label IN ['Dog', 'Cat']]), .`name` , __typename: __typename }",
  'InterfaceModel count() with "fulltext"':
    'MATCH (n:(`Dog`|`Cat`))\nWHERE n.`name` = $param0\nRETURN count(n) AS count',
  'every method with its own params':
    "MATCH (n:`User`:`Vip`)\nWHERE n.`id` = $param0\nWITH *\nLIMIT $options_limit\nRETURN n { .`id` }\n;;\nMATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH *\nSKIP $options_offset\nLIMIT $options_limit\nRETURN n { .`id` }\n;;\nMATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH *\nLIMIT $options_limit\nRETURN n { __typename: 'User', .`id`, .`name` }\n;;\nCREATE (n:`User` { `id`: randomUUID(), `name`: $create0_name })\nSET n:`Vip`\nRETURN n { __typename: 'User', .`id`, .`name` }\n;;\nMATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nRETURN n\n;;\nMATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->(target_posts_0:`Post`)\nWHERE target_posts_0.`id` = $param1\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nWITH n\nCALL {\nWITH n\nUNWIND $connect_posts AS connItem\nMATCH (target:`Post`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[:`WROTE`]->(target)\nRETURN count(*) AS _conn_posts\n}\nRETURN n { __typename: 'User', .`id`, .`name` }\n;;\nMATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[:`WROTE`]->(cascade_0:`Post`)\nDETACH DELETE cascade_0\nRETURN count(*) AS _del_posts_0\n}\nDETACH DELETE n\n;;\nMATCH (n:`User`)\nWHERE n.`id` = $param0\nDETACH DELETE n\n;;\nUNWIND $items AS item\nMERGE (n:`User` { `name`: item.`name` })\nON CREATE SET n.`id` = randomUUID()\nRETURN count(n) AS count\n;;\nMATCH (n:`User`:`Vip`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nRETURN count(n) AS count\n;;\nMERGE (n:`User` { `name`: $merge_name })\nON CREATE SET n.`name` = $onCreate_name, n.`id` = randomUUID()\nON MATCH SET n.`name` = $onMatch_name\nRETURN n { __typename: 'User', .`id`, .`name` }\n;;\nMATCH (n:`User`:`Vip`)\nWHERE n.`id` = $param0\nRETURN count(n) AS count\n;;\nMATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN count(n) AS count\n;;\nMATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n:`Vip`\nREMOVE n:`Old`\n;;\nMATCH (n:(`Dog`|`Cat`))\nWHERE n.`name` = $param0\nWITH n, CASE WHEN n:`Dog` THEN 'Dog' WHEN n:`Cat` THEN 'Cat' END AS __typename\nWITH *\nLIMIT $options_limit\nRETURN n { __typename: head([__label IN labels(n) WHERE __label IN ['Dog', 'Cat']]), .`name` , __typename: __typename }\n;;\nMATCH (n:(`Dog`|`Cat`))\nWHERE n.`name` = $param0\nRETURN count(n) AS count",
  'an unknown param set to undefined':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nRETURN n { __typename: 'User', .`id`, .`name` }\n;;\nMATCH (n:`User`)\nWHERE n.`id` = $param0\nDETACH DELETE n",
};

function setup(strict?: boolean) {
  const records: Recorded[] = [];
  const warnings: string[] = [];
  const ogm = new OGM({
    typeDefs: paramsTypeDefs,
    driver: recordingDriver(records),
    logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
    ...(strict === undefined ? {} : { strict }),
  });
  return { ogm, records, warnings };
}

const STRICT_HINT =
  'Enable `strict: true` (default in 3.0) to throw an OGMError for unknown parameters.';

const bad = Object.entries(badParamShapes);

describe('strict mode off: Cypher is byte-identical to v2.15.0', () => {
  const cases: [string, Run][] = [
    ...bad.map(([name, s]): [string, Run] => [name, s.run]),
    ...Object.entries(legitParamShapes),
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

describe('item 30 — unknown params of Model / InterfaceModel methods', () => {
  it.each(bad)('default warns once: %s', async (_name, s) => {
    const { ogm, warnings } = setup();
    await s.run(ogm);
    await s.run(ogm);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      new RegExp(
        `^\\[OGM\\] Unknown parameters? ${escape(s.keys)} of ${escape(s.call)}\\(\\) (is|are) ignored\\. Allowed: "`,
      ),
    );
    if (s.hint) expect(warnings[0]).toContain(`. ${s.hint} ${STRICT_HINT}`);
    expect(warnings[0].endsWith(STRICT_HINT)).toBe(true);
  });

  it.each(bad)('strict throws before running: %s', async (_name, s) => {
    const { ogm, records, warnings } = setup(true);
    const err = await s.run(ogm).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OGMError);
    const message = (err as Error).message;
    expect(message).toMatch(
      new RegExp(
        `^Unknown parameters? ${escape(s.keys)} of ${escape(s.call)}\\(\\)\\. Allowed: "`,
      ),
    );
    if (s.hint) expect(message.endsWith(` ${s.hint}`)).toBe(true);
    expect(records).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('names the allowed params in full', async () => {
    const { ogm } = setup(true);
    await expect(
      badParamShapes['update() with an upstream-style root "delete"'].run(ogm),
    ).rejects.toThrow(
      new OGMError(
        'Unknown parameter "delete" of User.update(). Allowed: "where", "update", "connect", "disconnect", ' +
          '"labels", "selectionSet", "select", "context", "unsafe". update() has no root "delete": put it in a ' +
          'relationship field of "update", e.g. `update: { posts: [{ delete: … }] }`.',
      ),
    );
  });

  it('a find routed through findFirst / findUnique warns once', async () => {
    const { ogm, warnings } = setup();
    await badParamShapes['findUnique() with "include"'].run(ogm);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('of User.findUnique()');
  });

  it('strict also checks searchByVector, searchByPhrase and explainPolicies', async () => {
    const { ogm } = setup(true);
    const u = ogm.model('User');
    const extra = <T extends object>(o: T): T => o;
    await expect(
      u.searchByVector(extra({ indexName: 'x', vector: [1], k: 1, limit: 3 })),
    ).rejects.toThrow('Unknown parameter "limit" of User.searchByVector().');
    await expect(
      u.searchByPhrase(extra({ indexName: 'x', phrase: 'a', k: 1, top: 3 })),
    ).rejects.toThrow('Unknown parameter "top" of User.searchByPhrase().');
    await expect(
      u.explainPolicies(extra({ where: { id: 'u1' }, unsafe: {} })),
    ).rejects.toThrow('Unknown parameter "unsafe" of User.explainPolicies().');
  });

  it.each(Object.entries(legitParamShapes))(
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

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
