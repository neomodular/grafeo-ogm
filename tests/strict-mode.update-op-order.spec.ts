/**
 * v2.9.0 — order of the root `update()` arguments.
 *
 * 2.x runs the `update` body (root SET, then the nested ops of each
 * relationship field) before the root `disconnect`, then the root
 * `connect`. In `@neo4j/graphql` 5.x the root `disconnect` runs before the
 * `update` body (`translate/translate-update.js`: delete, disconnect,
 * update, connect, create), so a nested op never sees the relationships the
 * root `disconnect` removes, and a blanket root `disconnect` never removes
 * what a nested `connect` / `create` just added.
 *
 * - Default mode: byte-identical to v2.8.0 (hard-coded below, captured from
 *   v2.8.0 main); warns once (`update-op-order`) when the root `disconnect`
 *   and a nested update / connect / create / delete touch the same
 *   relationship type.
 * - Strict mode: root disconnect, update body, root connect; never warns.
 */
import { OGM } from '../src/ogm';
import {
  policies,
  typeDefs as nlsTypeDefs,
} from './fixtures/nls-enforcement.fixture';
import {
  Recorded,
  recordingDriver,
  Run,
  writeTypeDefs,
} from './strict-mode.writes.cases';

const user = (ogm: OGM) => ogm.model('User');
const where = { id: 'u1' };

const shapes: Record<string, Run> = {
  'root disconnect + nested update (same field)': (ogm) =>
    user(ogm).update({
      where,
      update: { posts: [{ update: { node: { title: 'new' } } }] },
      disconnect: { posts: [{ where: { node: { id: 'p1' } } }] },
    }),
  'root blanket disconnect + nested create + SET': (ogm) =>
    user(ogm).update({
      where,
      update: { name: 'x', posts: [{ create: [{ node: { title: 'n' } }] }] },
      disconnect: { posts: null },
    }),
  'root disconnect + nested delete': (ogm) =>
    user(ogm).update({
      where,
      update: { posts: [{ delete: [{ where: { node: { id: 'p2' } } }] }] },
      disconnect: { posts: [{ where: { node: { id: 'p1' } } }] },
    }),
  'root blanket disconnect + nested connect on a field sharing the type': (
    ogm,
  ) =>
    user(ogm).update({
      where,
      update: { toys: [{ connect: [{ where: { node: { id: 't1' } } }] }] },
      disconnect: { pets: {} },
    }),
  'root disconnect + nested update + root connect': (ogm) =>
    user(ogm).update({
      where,
      update: { posts: [{ update: { node: { title: 'new' } } }] },
      disconnect: { posts: [{ where: { node: { id: 'p1' } } }] },
      connect: { posts: [{ where: { node: { id: 'p3' } } }] },
    }),
  'root disconnect + nested disconnect only': (ogm) =>
    user(ogm).update({
      where,
      update: { posts: [{ disconnect: [{ where: { node: { id: 'p2' } } }] }] },
      disconnect: { posts: [{ where: { node: { id: 'p1' } } }] },
    }),
  'root disconnect + nested update on another type': (ogm) =>
    user(ogm).update({
      where,
      update: { pets: [{ update: { node: { name: 'n' } } }] },
      disconnect: { posts: [{ where: { node: { id: 'p1' } } }] },
    }),
  'root disconnect + SET only': (ogm) =>
    user(ogm).update({
      where,
      update: { name: 'x' },
      disconnect: { posts: [{ where: { node: { id: 'p1' } } }] },
    }),
  'root connect + nested update (no disconnect)': (ogm) =>
    user(ogm).update({
      where,
      update: { posts: [{ update: { node: { title: 'new' } } }] },
      connect: { posts: [{ where: { node: { id: 'p3' } } }] },
    }),
};

/** v2.8.0 Cypher for each shape. */
const V280: Record<string, string> = {
  'root disconnect + nested update (same field)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nSET n_u0.`title` = $update_posts_0_set_title\nRETURN count(*) AS _uc_posts_0\n}\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->(target_posts_0:`Post`)\nWHERE target_posts_0.`id` = $param1\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'root blanket disconnect + nested create + SET':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nWITH n\nCREATE (n_cr0:`Post` { `id`: randomUUID(), `title`: $update_posts_0_create0_title })\nCREATE (n)-[:`WROTE`]->(n_cr0)\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->()\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'root disconnect + nested delete':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[:`WROTE`]->(n_del0:`Post`)\nWHERE n_del0.`id` = $param1\nDETACH DELETE n_del0\nRETURN count(*) AS _del_posts_0_0\n}\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->(target_posts_0:`Post`)\nWHERE target_posts_0.`id` = $param2\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'root blanket disconnect + nested connect on a field sharing the type':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n_conn0:`Toy`)\nWHERE n_conn0.`id` = $param1\nMERGE (n)-[:`HAS`]->(n_conn0)\nRETURN count(*) AS _cn_toys_0\n}\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_pets_0:`HAS`]->()\nDELETE r_pets_0\nRETURN count(*) AS _r_pets_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'root disconnect + nested update + root connect':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nSET n_u0.`title` = $update_posts_0_set_title\nRETURN count(*) AS _uc_posts_0\n}\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->(target_posts_0:`Post`)\nWHERE target_posts_0.`id` = $param1\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nWITH n\nCALL {\nWITH n\nUNWIND $connect_posts AS connItem\nMATCH (target:`Post`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[:`WROTE`]->(target)\nRETURN count(*) AS _conn_posts\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'root disconnect + nested disconnect only':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_disc_posts_0_0:`WROTE`]->(n_disc0:`Post`)\nWHERE n_disc0.`id` = $param1\nDELETE r_disc_posts_0_0\nRETURN count(*) AS _r_disc_posts_0_0\n}\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->(target_posts_0:`Post`)\nWHERE target_posts_0.`id` = $param2\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'root disconnect + nested update on another type':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_pets_0:`HAS`]->(n_u0:`Pet`)\nSET n_u0.`name` = $update_pets_0_set_name\nRETURN count(*) AS _uc_pets_0\n}\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->(target_posts_0:`Post`)\nWHERE target_posts_0.`id` = $param1\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'root disconnect + SET only':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->(target_posts_0:`Post`)\nWHERE target_posts_0.`id` = $param1\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'root connect + nested update (no disconnect)':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nSET n_u0.`title` = $update_posts_0_set_title\nRETURN count(*) AS _uc_posts_0\n}\nWITH n\nCALL {\nWITH n\nUNWIND $connect_posts AS connItem\nMATCH (target:`Post`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[:`WROTE`]->(target)\nRETURN count(*) AS _conn_posts\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
};

async function compile(
  run: Run,
  strict: boolean | undefined,
): Promise<{ records: Recorded[]; warnings: string[] }> {
  const records: Recorded[] = [];
  const warnings: string[] = [];
  const ogm = new OGM({
    typeDefs: writeTypeDefs,
    driver: recordingDriver(records),
    logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
    ...(strict === undefined ? {} : { strict }),
  });
  await run(ogm);
  return { records, warnings };
}

const cypherOf = (records: Recorded[]) =>
  records.map((r) => r.cypher).join('\n;;\n');

const orderWarnings = (warnings: string[]) =>
  warnings.filter((w) => w.includes('runs the root `disconnect` after'));

describe('root update() argument order — default mode (v2.9.0)', () => {
  const cases = Object.entries(shapes);

  it('covers every shape', () => {
    expect(Object.keys(V280).sort()).toEqual(cases.map(([n]) => n).sort());
  });

  it.each(cases)('%s is byte-identical to v2.8.0', async (name, run) => {
    const unset = await compile(run, undefined);
    const off = await compile(run, false);
    expect(off.records).toEqual(unset.records);
    expect(cypherOf(unset.records)).toBe(V280[name]);
  });

  it.each([
    ['root disconnect + nested update (same field)', 'User.posts'],
    ['root blanket disconnect + nested create + SET', 'User.posts'],
    ['root disconnect + nested delete', 'User.posts'],
    [
      'root blanket disconnect + nested connect on a field sharing the type',
      'User.toys',
    ],
    ['root disconnect + nested update + root connect', 'User.posts'],
  ])('%s warns once, naming %s', async (name, field) => {
    const { warnings } = await compile(shapes[name], undefined);
    expect(orderWarnings(warnings)).toHaveLength(1);
    expect(orderWarnings(warnings)[0]).toContain(`"${field}"`);
    expect(orderWarnings(warnings)[0]).toContain('Enable `strict: true`');
  });

  it.each([
    'root disconnect + nested disconnect only',
    'root disconnect + nested update on another type',
    'root disconnect + SET only',
    'root connect + nested update (no disconnect)',
  ])('%s does not warn', async (name) => {
    const { warnings } = await compile(shapes[name], undefined);
    expect(orderWarnings(warnings)).toEqual([]);
  });

  it('warns for a per-member (interface) nested item', async () => {
    const typeDefs = /* GraphQL */ `
      interface Media {
        id: ID!
        title: String
      }
      type Video implements Media @node {
        id: ID! @id @unique
        title: String
      }
      type Owner @node {
        id: ID! @id @unique
        media: [Media!]! @relationship(type: "OWNS", direction: OUT)
      }
    `;
    const warnings: string[] = [];
    const ogm = new OGM({
      typeDefs,
      driver: recordingDriver([]),
      logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
    });
    await ogm.model('Owner').update({
      where: { id: 'o1' },
      update: { media: { Video: [{ create: [{ node: { title: 'n' } }] }] } },
      disconnect: { media: [{ where: { node: { id: 'v1' } } }] },
    });
    expect(orderWarnings(warnings)).toHaveLength(1);
  });
});

describe('root update() argument order — strict mode (v2.9.0)', () => {
  it('runs the root disconnect before the update body and the root connect last', async () => {
    const { records, warnings } = await compile(
      shapes['root disconnect + nested update + root connect'],
      true,
    );
    const cypher = cypherOf(records);
    const disc = cypher.indexOf('AS _r_posts_0');
    const upd = cypher.indexOf('AS _uc_posts_0');
    const conn = cypher.indexOf('AS _conn_posts');
    expect(disc).toBeGreaterThan(-1);
    expect(upd).toBeGreaterThan(disc);
    expect(conn).toBeGreaterThan(upd);
    expect(warnings).toEqual([]);
  });

  it('runs the root disconnect before the root SET and a nested create', async () => {
    const { records } = await compile(
      shapes['root blanket disconnect + nested create + SET'],
      true,
    );
    const cypher = cypherOf(records);
    expect(cypher).toContain(
      'WHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->(:`Post`)\nDELETE r_posts_0\nRETURN count(*) AS _r_posts_0\n}\nSET n.`name` = $update_name\nWITH n\nCREATE (n_cr0:`Post`',
    );
    expect(cypher).not.toMatch(/CALL \(/);
  });

  it('keeps the same params as default mode', async () => {
    for (const run of Object.values(shapes)) {
      const strict = await compile(run, true);
      const lax = await compile(run, undefined);
      expect(Object.keys(strict.records[0].params).sort()).toEqual(
        Object.keys(lax.records[0].params).sort(),
      );
    }
  });

  it('leaves an update without a root disconnect unchanged', async () => {
    const run = shapes['root connect + nested update (no disconnect)'];
    expect((await compile(run, true)).records).toEqual(
      (await compile(run, undefined)).records,
    );
  });

  it('applies the target policies (disconnect read, nested update gate) in the strict order', async () => {
    async function compileNls(strict: boolean) {
      const records: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: nlsTypeDefs,
        driver: recordingDriver(records),
        policies,
        strict,
      });
      await ogm
        .withContext({ uid: 'u1', tid: 't1' })
        .model('ItTag')
        .update({
          where: { id: 'tag1' },
          update: { charts: [{ update: { node: { title: 'b' } } }] },
          disconnect: { charts: [{ where: { node: { id: 'c1' } } }] },
        });
      return records[0].cypher;
    }
    const strict = await compileNls(true);
    const lax = await compileNls(false);
    const disc = strict.indexOf('AS _r_charts_0');
    const upd = strict.indexOf('AS _uc_charts_0');
    expect(disc).toBeGreaterThan(-1);
    expect(upd).toBeGreaterThan(disc);
    expect(strict.slice(0, disc)).toMatch(/`secret` = \$\w+/);
    expect(strict.slice(disc, upd)).toMatch(/`ownerId` = \$\w+/);
    const count = (s: string, re: RegExp) =>
      (s.match(new RegExp(re.source, 'g')) ?? []).length;
    for (const re of [/`ownerId` = \$\w+/, /`secret` = \$\w+/])
      expect(count(strict, re)).toBe(count(lax, re));
  });
});
