/**
 * Live `grafeo db push` suite (v2.4.8).
 *
 * Opt-in: runs only when NEO4J_URI is set. Every label it uses starts with
 * `LaPush` and every constraint / index it creates starts with `LaPush` or
 * `la_`; `afterAll` drops exactly those (and checks nothing of ours is left).
 * Other items in the database are never touched: `--force-drop` only drops
 * grafeo-named constraints over the schema's own (`LaPush*`) labels.
 *
 * Covers three planner bugs confirmed on Neo4j 5.26:
 *  - a changed fulltext / vector definition was reported "in sync" and never
 *    applied (`IF NOT EXISTS` on an existing name is a silent no-op);
 *  - an equivalent constraint under another name made push print
 *    "created X" on every run while creating nothing, and a plain RANGE
 *    index on the property made push crash;
 *  - every in-sync grafeo constraint's backing index was listed as
 *    "Unmanaged — ignored" on rerun.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import neo4j, { Driver } from 'neo4j-driver';
import { runDbPush } from '../../src/cli/commands/db-push';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(120_000);

const USER = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j';
const PASSWORD = process.env.NEO4J_PASSWORD ?? 'password';

const OURS = (name: string) =>
  name.startsWith('LaPush') || name.startsWith('la_');

interface PushResult {
  code: number;
  out: string;
  err: string;
}

describeLive('grafeo db push — live Neo4j', () => {
  let driver: Driver;
  const dirs: string[] = [];

  async function run(cypher: string): Promise<Record<string, unknown>[]> {
    const session = driver.session();
    try {
      const res = await session.run(cypher);
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  async function indexRow(name: string) {
    const rows = await run(
      `SHOW INDEXES YIELD name, properties, options WHERE name = '${name}' RETURN *`,
    );
    return rows[0] as
      | {
          properties: string[];
          options: { indexConfig: Record<string, unknown> };
        }
      | undefined;
  }

  async function constraintNames(): Promise<string[]> {
    const rows = await run('SHOW CONSTRAINTS YIELD name RETURN name');
    return rows.map((r) => r.name as string);
  }

  async function push(
    schema: string,
    argv: string[] = [],
    config?: Record<string, unknown>,
  ): Promise<PushResult> {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'la-push-'));
    dirs.push(cwd);
    fs.writeFileSync(path.join(cwd, 'schema.graphql'), schema);
    if (config)
      fs.writeFileSync(
        path.join(cwd, 'grafeo.config.json'),
        JSON.stringify(config),
      );
    const out: string[] = [];
    const err: string[] = [];
    const code = await runDbPush(argv, {
      cwd,
      env: { NEO4J_URI: URI, NEO4J_USERNAME: USER, NEO4J_PASSWORD: PASSWORD },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  async function dropOurs(): Promise<void> {
    for (const name of await constraintNames())
      if (OURS(name)) await run(`DROP CONSTRAINT \`${name}\` IF EXISTS`);
    const indexes = await run(
      'SHOW INDEXES YIELD name, owningConstraint RETURN name, owningConstraint',
    );
    for (const row of indexes)
      if (OURS(row.name as string) && !row.owningConstraint)
        await run(`DROP INDEX \`${row.name as string}\` IF EXISTS`);
  }

  beforeAll(async () => {
    driver = neo4j.driver(URI!, neo4j.auth.basic(USER, PASSWORD));
    await driver.verifyConnectivity();
    await dropOurs();
  });

  afterAll(async () => {
    if (!driver) return;
    await dropOurs();
    const leftC = (await constraintNames()).filter(OURS);
    const leftI = (await run('SHOW INDEXES YIELD name RETURN name'))
      .map((r) => r.name as string)
      .filter(OURS);
    await driver.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    expect([...leftC, ...leftI]).toEqual([]);
  });

  it('a rerun does not list in-sync grafeo constraints as unmanaged', async () => {
    const schema = 'type LaPushA @node { id: ID! @unique }';
    const first = await push(schema);
    expect(first.code).toBe(0);
    expect(first.out).toContain('✓ created LaPushA_id_unique');

    const second = await push(schema);
    expect(second.code).toBe(0);
    expect(second.out).toContain('No changes');
    expect(second.out).not.toMatch(/Unmanaged.*LaPushA_id_unique/);
  });

  it('reports a changed fulltext definition instead of "in sync", and recreates it only under --force-drop', async () => {
    const v1 = `type LaPushFt @node @fulltext(indexes: [{ name: "LaPushFtSearch", fields: ["title"] }]) {
      id: ID!
      title: String
      body: String
    }`;
    const v2 = v1.replace('fields: ["title"]', 'fields: ["title", "body"]');

    expect((await push(v1)).code).toBe(0);
    expect((await indexRow('LaPushFtSearch'))?.properties).toEqual(['title']);

    const plain = await push(v2);
    expect(plain.code).toBe(0);
    expect(plain.out).not.toContain('No changes');
    expect(plain.out).toContain('LaPushFtSearch');
    expect(plain.out).toMatch(/NOT in sync/);
    // Left as-is without --force-drop.
    expect((await indexRow('LaPushFtSearch'))?.properties).toEqual(['title']);

    const forced = await push(v2, ['--force-drop', '--yes']);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('✓ recreated LaPushFtSearch');
    expect((await indexRow('LaPushFtSearch'))?.properties).toEqual([
      'title',
      'body',
    ]);

    expect((await push(v2)).out).toContain('No changes');
  });

  // v2.5.1 — Neo4j treats a fulltext/vector index with the same entity,
  // labels and properties as EQUIVALENT regardless of name, so when a DBA
  // index already covers the SDL definition the recreate's
  // `CREATE … IF NOT EXISTS` is a silent no-op. Pre-2.5.1 --force-drop
  // dropped the SDL-named index anyway and printed "✓ recreated", leaving
  // fulltext queries (which address the index by SDL name) broken.
  it('never drops an index it cannot recreate under its SDL name', async () => {
    const v1 = `type LaPushEq @node @fulltext(indexes: [{ name: "LaPushEqSearch", fields: ["title"] }]) {
      id: ID!
      title: String
      summary: String
    }`;
    const v2 = v1.replace('fields: ["title"]', 'fields: ["title", "summary"]');
    expect((await push(v1)).code).toBe(0);
    await run(
      'CREATE FULLTEXT INDEX la_dba_eq IF NOT EXISTS FOR (n:LaPushEq) ON EACH [n.title, n.summary]',
    );

    const forced = await push(v2, ['--force-drop', '--yes']);
    expect(forced.out).not.toContain('✓ recreated LaPushEqSearch');
    expect(`${forced.out}\n${forced.err}`).toMatch(/la_dba_eq/);
    // The SDL-named index must still exist — fulltext queries use it.
    expect((await indexRow('LaPushEqSearch'))?.properties).toEqual(['title']);
  });

  it('reports a changed vector dimension / similarity', async () => {
    const schema = `type LaPushVec @node @vector(indexes: [{ indexName: "LaPushVecIdx", queryName: "laPushVecQ", embeddingProperty: "emb" }]) {
      id: ID!
      emb: [Float!]
    }`;
    const cfg = (dimensions: number, similarity: string) => ({
      vectorIndexes: { LaPushVecIdx: { dimensions, similarity } },
    });

    expect((await push(schema, [], cfg(4, 'cosine'))).code).toBe(0);
    expect((await push(schema, [], cfg(4, 'cosine'))).out).toContain(
      'No changes',
    );

    const changed = await push(schema, [], cfg(8, 'euclidean'));
    expect(changed.out).toContain('LaPushVecIdx');
    expect(changed.out).toMatch(/NOT in sync/);
    expect(changed.out).toMatch(/dimensions/);

    const forced = await push(
      schema,
      ['--force-drop', '--yes'],
      cfg(8, 'euclidean'),
    );
    expect(forced.out).toContain('✓ recreated LaPushVecIdx');
    const row = await indexRow('LaPushVecIdx');
    expect(Number(row?.options.indexConfig['vector.dimensions'])).toBe(8);
  });

  it('treats an equivalent constraint under another name as in sync, never claiming "created"', async () => {
    await run(
      'CREATE CONSTRAINT la_dba_isbn IF NOT EXISTS FOR (n:LaPushCov) REQUIRE n.isbn IS UNIQUE',
    );
    const schema = 'type LaPushCov @node { isbn: String @unique }';

    for (let i = 0; i < 2; i++) {
      const res = await push(schema);
      expect(res.code).toBe(0);
      expect(res.out).not.toContain('created LaPushCov_isbn_unique');
      expect(res.out).toContain('LaPushCov_isbn_unique covered by la_dba_isbn');
    }
    expect(await constraintNames()).not.toContain('LaPushCov_isbn_unique');
  });

  it('reports a RANGE index blocking a unique constraint instead of crashing', async () => {
    await run(
      'CREATE INDEX la_dba_code_range IF NOT EXISTS FOR (n:LaPushRng) ON (n.code)',
    );
    const schema = `type LaPushRng @node {
      code: String @unique
      id: ID! @unique
    }`;

    const res = await push(schema);
    expect(res.code).toBe(0);
    expect(res.err).toContain('LaPushRng_code_unique');
    expect(res.err).toContain('la_dba_code_range');
    // The rest of the plan is still applied.
    expect(res.out).toContain('✓ created LaPushRng_id_unique');
    expect(res.out).not.toContain('No changes');
    // grafeo never drops the index it does not manage.
    expect(await indexRow('la_dba_code_range')).toBeDefined();
  });
});
