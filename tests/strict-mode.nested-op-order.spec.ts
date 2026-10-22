/**
 * v2.9.0 — order of the ops within one nested update item.
 *
 * 2.x runs them as delete, disconnect, connect, create, update. In
 * `@neo4j/graphql` 5.x `update` runs before `connect` / `create`
 * (`translate/create-update-and-params.js`), so its MATCH only reaches the
 * relationships that existed before the item's connect / create.
 *
 * - Default mode: the Cypher is byte-identical to v2.8.0 (hard-coded below,
 *   captured from v2.8.0 main), and an item that combines `update` with
 *   `connect` / `create` warns once.
 * - Strict mode: delete, disconnect, update, connect, create; never warns.
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
  'update + connect': (ogm) =>
    user(ogm).update({
      where,
      update: {
        posts: [
          {
            where: { node: { title: 'match' } },
            update: { node: { title: 'renamed' } },
            connect: [{ where: { node: { id: 'p9' } } }],
          },
        ],
      },
    }),
  'update + create': (ogm) =>
    user(ogm).update({
      where,
      update: {
        posts: [
          {
            update: { node: { title: 'renamed' } },
            create: [{ node: { title: 'new' } }],
          },
        ],
      },
    }),
  'all five ops': (ogm) =>
    user(ogm).update({
      where,
      update: {
        posts: [
          {
            delete: [{ where: { node: { id: 'd1' } } }],
            disconnect: [{ where: { node: { id: 'q1' } } }],
            connect: [{ where: { node: { id: 'c1' } }, edge: { role: 'r' } }],
            create: [{ node: { title: 'new' }, edge: { role: 'r' } }],
            where: { node: { id: 'u1' } },
            update: { node: { title: 'renamed' }, edge: { role: 'x' } },
          },
        ],
      },
    }),
  'update only': (ogm) =>
    user(ogm).update({
      where,
      update: { posts: [{ update: { node: { title: 'renamed' } } }] },
    }),
  'connect + create, no update': (ogm) =>
    user(ogm).update({
      where,
      update: {
        posts: [
          {
            connect: [{ where: { node: { id: 'c1' } } }],
            create: [{ node: { title: 'new' } }],
          },
        ],
      },
    }),
  'update and connect in separate items': (ogm) =>
    user(ogm).update({
      where,
      update: {
        posts: [
          { update: { node: { title: 'renamed' } } },
          { connect: [{ where: { node: { id: 'c1' } } }] },
        ],
      },
    }),
};

/** v2.8.0 Cypher for each shape. */
const V280: Record<string, string> = {
  'update + connect':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n_conn0:`Post`)\nWHERE n_conn0.`id` = $param1\nMERGE (n)-[:`WROTE`]->(n_conn0)\nRETURN count(*) AS _cn_posts_0\n}\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u1:`Post`)\nWHERE n_u1.`title` = $param2\nSET n_u1.`title` = $update_posts_0_set_title\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'update + create':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCREATE (n_cr0:`Post` { `id`: randomUUID(), `title`: $update_posts_0_create0_title })\nCREATE (n)-[:`WROTE`]->(n_cr0)\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u1:`Post`)\nSET n_u1.`title` = $update_posts_0_set_title\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'all five ops':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[:`WROTE`]->(n_del0:`Post`)\nWHERE n_del0.`id` = $param1\nDETACH DELETE n_del0\nRETURN count(*) AS _del_posts_0_0\n}\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_disc_posts_0_0:`WROTE`]->(n_disc1:`Post`)\nWHERE n_disc1.`id` = $param2\nDELETE r_disc_posts_0_0\nRETURN count(*) AS _r_disc_posts_0_0\n}\nWITH n\nCALL {\nWITH n\nMATCH (n_conn2:`Post`)\nWHERE n_conn2.`id` = $param3\nMERGE (n)-[r_conn_posts_0:`WROTE`]->(n_conn2)\nSET r_conn_posts_0.`role` = $update_posts_0_conn0_edge_role\nRETURN count(*) AS _cn_posts_0\n}\nWITH n\nCREATE (n_cr3:`Post` { `id`: randomUUID(), `title`: $update_posts_0_create0_title })\nCREATE (n)-[n_cr3_e:`WROTE`]->(n_cr3)\nSET n_cr3_e.`role` = $update_posts_0_create0_edge_role\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u4:`Post`)\nWHERE n_u4.`id` = $param4\nSET n_u4.`title` = $update_posts_0_set_title\nSET r_posts_0.`role` = $update_posts_0_edge_role\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'update only':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nSET n_u0.`title` = $update_posts_0_set_title\nRETURN count(*) AS _uc_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'connect + create, no update':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n_conn0:`Post`)\nWHERE n_conn0.`id` = $param1\nMERGE (n)-[:`WROTE`]->(n_conn0)\nRETURN count(*) AS _cn_posts_0\n}\nWITH n\nCREATE (n_cr1:`Post` { `id`: randomUUID(), `title`: $update_posts_0_create0_title })\nCREATE (n)-[:`WROTE`]->(n_cr1)\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'update and connect in separate items':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n)-[r_posts_0:`WROTE`]->(n_u0:`Post`)\nSET n_u0.`title` = $update_posts_0_set_title\nRETURN count(*) AS _uc_posts_0\n}\nWITH n\nCALL {\nWITH n\nMATCH (n_conn1:`Post`)\nWHERE n_conn1.`id` = $param1\nMERGE (n)-[:`WROTE`]->(n_conn1)\nRETURN count(*) AS _cn_posts_0\n}\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
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
  return {
    records,
    warnings: warnings.filter((w) => !w.includes('share relationship type')),
  };
}

const cypherOf = (records: Recorded[]) =>
  records.map((r) => r.cypher).join('\n;;\n');

const orderWarnings = (warnings: string[]) =>
  warnings.filter((w) => w.includes('runs `connect` / `create` before'));

describe('nested update item op order — default mode (v2.9.0)', () => {
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
    ['update + connect', 1],
    ['update + create', 1],
    ['all five ops', 1],
    ['update only', 0],
    ['connect + create, no update', 0],
    ['update and connect in separate items', 0],
  ] as const)('%s warns %i time(s)', async (name, n) => {
    const { warnings } = await compile(shapes[name], undefined);
    expect(orderWarnings(warnings)).toHaveLength(n);
    if (n) {
      expect(orderWarnings(warnings)[0]).toContain('User.posts');
      expect(orderWarnings(warnings)[0]).toContain('Enable `strict: true`');
    }
  });

  it('warns once per OGM and field', async () => {
    const records: Recorded[] = [];
    const warnings: string[] = [];
    const ogm = new OGM({
      typeDefs: writeTypeDefs,
      driver: recordingDriver(records),
      logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
    });
    await shapes['update + connect'](ogm);
    await shapes['update + create'](ogm);
    await shapes['all five ops'](ogm);
    expect(orderWarnings(warnings)).toHaveLength(1);
  });
});

describe('nested update item op order — strict mode (v2.9.0)', () => {
  /** Index of each op's first clause in the compiled Cypher. */
  function positions(cypher: string) {
    return {
      del: cypher.indexOf('DETACH DELETE'),
      disc: cypher.indexOf('DELETE r_disc_posts'),
      upd: cypher.search(
        /MATCH \(n\)-\[r_posts_0:`WROTE`\]->\(n_u\d+:`Post`\)/,
      ),
      conn: cypher.search(/_cn_posts_0/),
      create: cypher.search(/CREATE \(n_cr\d+:`Post`/),
    };
  }

  it('runs update before connect and create', async () => {
    const { records, warnings } = await compile(shapes['all five ops'], true);
    const p = positions(cypherOf(records));
    expect(p.del).toBeGreaterThan(-1);
    expect(p.disc).toBeGreaterThan(p.del);
    expect(p.upd).toBeGreaterThan(p.disc);
    expect(p.conn).toBeGreaterThan(p.upd);
    expect(p.create).toBeGreaterThan(p.conn);
    expect(warnings).toEqual([]);
  });

  it('keeps every param and the same params as default mode', async () => {
    const strict = await compile(shapes['all five ops'], true);
    const lax = await compile(shapes['all five ops'], undefined);
    expect(Object.keys(strict.records[0].params).sort()).toEqual(
      Object.keys(lax.records[0].params).sort(),
    );
  });

  it('puts a WITH between the update CALL and the next write', async () => {
    const { records } = await compile(shapes['update + create'], true);
    const cypher = cypherOf(records);
    expect(cypher).toMatch(
      /RETURN count\(\*\) AS _uc_posts_0\n\}\nWITH n\nCREATE \(n_cr\d+:`Post`/,
    );
    expect(cypher).not.toMatch(/CALL \(/);
  });

  it('leaves items without update unchanged', async () => {
    for (const name of [
      'update only',
      'connect + create, no update',
      'update and connect in separate items',
    ]) {
      const strict = await compile(shapes[name], true);
      const lax = await compile(shapes[name], undefined);
      expect(strict.records).toEqual(lax.records);
    }
  });

  it('orders a per-member (union / interface) item the same way', async () => {
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
    const records: Recorded[] = [];
    const ogm = new OGM({
      typeDefs,
      driver: recordingDriver(records),
      strict: true,
    });
    await ogm.model('Owner').update({
      where: { id: 'o1' },
      update: {
        media: {
          Video: [
            {
              update: { node: { title: 'x' } },
              connect: [{ where: { node: { id: 'v1' } } }],
              create: [{ node: { title: 'new' } }],
            },
          ],
        },
      },
    });
    const cypher = cypherOf(records);
    const upd = cypher.search(/SET n_u\d+\.`title`/);
    const conn = cypher.search(/_cn_media_0/);
    const create = cypher.search(/CREATE \(n_cr\d+:`Video`/);
    expect(upd).toBeGreaterThan(-1);
    expect(conn).toBeGreaterThan(upd);
    expect(create).toBeGreaterThan(conn);
  });

  it('applies the target policies (update gate, connect read, create WITH CHECK) in the strict order', async () => {
    async function compileNls(strict: boolean) {
      const records: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: nlsTypeDefs,
        driver: recordingDriver(records),
        policies,
        strict,
      });
      await ogm
        .withContext({ uid: 'u1', tid: 't1', canCreateChart: true })
        .model('ItTag')
        .update({
          where: { id: 'tag1' },
          update: {
            charts: [
              {
                where: { node: { title: 'a' } },
                update: { node: { title: 'b' } },
                connect: [{ where: { node: { id: 'c1' } } }],
                create: [{ node: { id: 'c2', tenantId: 't1' } }],
              },
            ],
          },
        });
      return records[0].cypher;
    }
    const strict = await compileNls(true);
    const lax = await compileNls(false);
    const count = (s: string, re: RegExp) =>
      (s.match(new RegExp(re.source, 'g')) ?? []).length;
    // Update gate (owner) inside the update CALL, before the connect.
    const upd = strict.search(/MATCH \(n\)-\[r_charts_0:`IT_TAGS`\]->\(n_u\d+/);
    const conn = strict.search(/_cn_charts_0/);
    expect(upd).toBeGreaterThan(-1);
    expect(conn).toBeGreaterThan(upd);
    expect(strict.slice(upd, conn)).toMatch(/`ownerId` = \$\w+/);
    // Every policy predicate of the default order is still there.
    for (const re of [/`ownerId` = \$\w+/, /`secret` = \$\w+/, /`tenantId`/]) {
      expect(count(strict, re)).toBe(count(lax, re));
      expect(count(strict, re)).toBeGreaterThan(0);
    }
  });
});
