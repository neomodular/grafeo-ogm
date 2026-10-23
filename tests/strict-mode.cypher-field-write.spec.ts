/**
 * vNEXT — strict item 29: a `@cypher` field given as write input. The
 * field is computed when read and the generated write inputs leave it
 * out, but pre-vNEXT every write path stored it as a property that no
 * read returns.
 *
 * - Default mode: byte-identical to v2.15.0 (hard-coded below, captured
 *   from main @ 6572bdc); warns once per OGM, type and field
 *   (`cypher-field-write`).
 * - Strict mode: `OGMError` before anything runs; never warns.
 */
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';
import {
  badCypherWriteShapes,
  cypherWriteTypeDefs,
  legitCypherWriteShapes,
} from './strict-mode.cypher-field-write.cases';
import { Recorded, recordingDriver, Run } from './strict-mode.writes.cases';

const V2150: Record<string, string> = {
  'create()':
    "CREATE (n:`User` { `id`: randomUUID(), `name`: $create0_name, `double`: $create0_double })\nRETURN n { __typename: 'User', .`id`, .`name`, .`n` }",
  'update()':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name, n.`double` = $update_double\nRETURN n { __typename: 'User', .`id`, .`name`, .`n` }",
  'update() with null':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`double` = $update_double\nRETURN n { __typename: 'User', .`id`, .`name`, .`n` }",
  'updateMany()':
    'MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`double` = $update_double\nRETURN count(n) AS count',
  'createMany()':
    'UNWIND $items AS item\nCREATE (n:`User` { `id`: randomUUID(), `name`: item.`name`, `double`: item.`double` })\nRETURN count(n) AS count',
  'upsert() create':
    "MERGE (n:`User` { `name`: $merge_name })\nON CREATE SET n.`name` = $onCreate_name, n.`double` = $onCreate_double, n.`id` = randomUUID()\nON MATCH SET n.`n` = $onMatch_n\nRETURN n { __typename: 'User', .`id`, .`name`, .`n` }",
  'upsert() update':
    "MERGE (n:`User` { `name`: $merge_name })\nON CREATE SET n.`name` = $onCreate_name, n.`id` = randomUUID()\nON MATCH SET n.`double` = $onMatch_double\nRETURN n { __typename: 'User', .`id`, .`name`, .`n` }",
  'nested create in create()':
    "CREATE (n:`User` { `id`: randomUUID(), `name`: $create0_name })\nWITH n\nCREATE (n_c0:`Post` { `id`: randomUUID(), `title`: $create0_posts_create0_title, `score`: $create0_posts_create0_score })\nCREATE (n)-[:`WROTE`]->(n_c0)\nRETURN n { __typename: 'User', .`id`, .`name`, .`n` }",
  'nested create in update()':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCREATE (n_cr0:`Post` { `id`: randomUUID(), `title`: $update_posts_0_create0_title, `score`: $update_posts_0_create0_score })\nCREATE (n)-[:`WROTE`]->(n_cr0)\nRETURN n { __typename: 'User', .`id`, .`name`, .`n` }",
  'nested update':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nWHERE n_u0.`id` = $param1\nSET n_u0.`score` = $update_posts_0_set_score\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`name`, .`n` }",
  'create and update stored fields, @cypher field selected':
    'CREATE (n:`User` { `id`: randomUUID(), `name`: $create0_name, `n`: $create0_n })\nWITH n\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    RETURN this.n * 2 AS d\n  }\n  RETURN head(collect(`d`)) AS __sel_n_double\n}\nWITH n, __sel_n_double\nRETURN n { .`id`, `double`: __sel_n_double }\n;;\nMATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`n` = $update_n\nWITH n\nCREATE (n_cr0:`Post` { `id`: randomUUID(), `title`: $update_posts_0_create0_title })\nCREATE (n)-[:`WROTE`]->(n_cr0)\nWITH n\nCALL {\n  WITH n\n  CALL {\n    WITH n\n    WITH n AS this\n    RETURN this.n * 2 AS d\n  }\n  RETURN head(collect(`d`)) AS __sel_n_double\n}\nWITH n, __sel_n_double\nRETURN n { .`id`, `double`: __sel_n_double }',
  'a @cypher field set to undefined':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`n` = $update_n\nRETURN n { __typename: 'User', .`id`, .`name`, .`n` }",
};

function setup(strict?: boolean) {
  const records: Recorded[] = [];
  const warnings: string[] = [];
  const ogm = new OGM({
    typeDefs: cypherWriteTypeDefs,
    driver: recordingDriver(records),
    logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
    ...(strict === undefined ? {} : { strict }),
  });
  return { ogm, records, warnings };
}

const bad = Object.entries(badCypherWriteShapes);

describe('strict mode off: Cypher is byte-identical to v2.15.0', () => {
  const cases: [string, Run][] = [
    ...bad.map(([name, s]): [string, Run] => [name, s.run]),
    ...Object.entries(legitCypherWriteShapes),
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

describe('item 29 — @cypher fields in write inputs', () => {
  it.each(bad)('default warns once: %s', async (_name, s) => {
    const { ogm, warnings } = setup();
    await s.run(ogm);
    await s.run(ogm);
    expect(warnings).toEqual([
      `[OGM] Field "${s.field}" in the ${s.input} input of ${s.type} is a @cypher field, computed when read; ` +
        `it is written as a stored property that no read returns. Enable \`strict: true\` (default in 3.0) ` +
        `to throw an OGMError for @cypher fields in write inputs.`,
    ]);
  });

  it.each(bad)('strict throws before running: %s', async (_name, s) => {
    const { ogm, records, warnings } = setup(true);
    await expect(s.run(ogm)).rejects.toThrow(
      new OGMError(
        `Field "${s.field}" in the ${s.input} input of ${s.type} is a @cypher field: it is computed when ` +
          `read and cannot be written. Remove it from the input.`,
      ),
    );
    expect(records).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('an unknown field still throws in both modes', async () => {
    for (const strict of [false, true]) {
      const { ogm } = setup(strict);
      await expect(
        ogm.model('User').create({ input: [{ nmae: 'a' }] }),
      ).rejects.toThrow('Unknown field "nmae" in the create input of User');
    }
  });

  it.each(Object.entries(legitCypherWriteShapes))(
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
