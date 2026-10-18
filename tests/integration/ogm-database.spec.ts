/**
 * Live database-selection suite (v2.4.8).
 *
 * Opt-in: runs only when NEO4J_URI is set. Creates no data: it only reads
 * `CALL db.info()` (the name of the database a session actually reached)
 * on the `system` database, which exists on every server, and asks for a
 * database that does not exist.
 *
 * Pre-2.4.8 `OGMConfig` had no `database` option and every OGM-opened
 * session went to the default database — so `grafeo db seed --database x`
 * seeded the default database.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import neo4j, { Driver } from 'neo4j-driver';
import { runDbSeed } from '../../src/cli/commands/db-seed';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const USER = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j';
const PASSWORD = process.env.NEO4J_PASSWORD ?? 'password';
const typeDefs = 'type LaDbProbe @node { id: ID! @id }';
const DB_INFO = 'CALL db.info() YIELD name RETURN name';

describeLive('OGMConfig.database — live Neo4j', () => {
  let driver: Driver;

  beforeAll(async () => {
    driver = neo4j.driver(URI!, neo4j.auth.basic(USER, PASSWORD));
    await driver.verifyConnectivity();
  });

  afterAll(async () => {
    if (driver) await driver.close();
  });

  it('raw queries reach the configured database', async () => {
    const ogm = new OGM({ typeDefs, driver, database: 'system' });
    expect(await ogm.$queryRaw(DB_INFO)).toEqual([{ name: 'system' }]);
  });

  it('$transaction reaches the configured database', async () => {
    const ogm = new OGM({ typeDefs, driver, database: 'system' });
    const name = await ogm.$transaction(async ({ transaction }) => {
      const res = await transaction.run(DB_INFO);
      return res.records[0].get('name') as string;
    });
    expect(name).toBe('system');
  });

  it('model queries go to the configured database', async () => {
    const ogm = new OGM({
      typeDefs,
      driver,
      database: 'la-missing-db-probe',
    });
    await expect(ogm.model('LaDbProbe').find({})).rejects.toThrow(
      /la-missing-db-probe/,
    );
  });

  it('without database, sessions use the default database as before', async () => {
    const ogm = new OGM({ typeDefs, driver });
    const [row] = await ogm.$queryRaw<{ name: string }>(DB_INFO);
    expect(row.name).not.toBe('system');
  });

  it('grafeo db seed --database runs the seed against that database', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'la-seed-db-'));
    try {
      fs.writeFileSync(path.join(cwd, 'schema.graphql'), typeDefs);
      fs.writeFileSync(
        path.join(cwd, 'seed.js'),
        `const fs = require('node:fs');
const path = require('node:path');
module.exports = async (ogm) => {
  const [row] = await ogm.$queryRaw(${JSON.stringify(DB_INFO)});
  fs.writeFileSync(path.join(__dirname, 'seeded-db.txt'), row.name);
};`,
      );
      const out: string[] = [];
      const code = await runDbSeed(['--database', 'system'], {
        cwd,
        env: {
          NEO4J_URI: URI,
          NEO4J_USERNAME: USER,
          NEO4J_PASSWORD: PASSWORD,
        },
        out: (l) => out.push(l),
        err: (l) => out.push(l),
      });
      expect(code).toBe(0);
      expect(fs.readFileSync(path.join(cwd, 'seeded-db.txt'), 'utf-8')).toBe(
        'system',
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
