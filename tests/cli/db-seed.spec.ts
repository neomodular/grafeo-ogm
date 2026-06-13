import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Driver } from 'neo4j-driver';
import { runDbSeed } from '../../src/cli/commands/db-seed';
import type { CliIO } from '../../src/cli/types';

const SCHEMA = `type Book @node {
  id: ID! @id @unique
  title: String!
}`;

// CJS seed that records (in its own directory) that it ran with a usable OGM.
const SEED_OK = `const fs = require('node:fs');
const path = require('node:path');
module.exports = async (ogm) => {
  const ok = ogm && typeof ogm.model === 'function';
  fs.writeFileSync(path.join(__dirname, 'seed-ran.txt'), ok ? 'ok' : 'bad');
};`;

const SEED_THROWS = `module.exports = async () => {
  throw new Error('seed boom');
};`;

function makeDriver(): { driver: Driver; isClosed(): boolean } {
  let closed = false;
  const session = {
    run: jest.fn(async () => ({ records: [] })),
    close: jest.fn(async () => undefined),
  };
  const driver = {
    session: jest.fn(() => session),
    close: jest.fn(async () => {
      closed = true;
    }),
  } as unknown as Driver;
  return { driver, isClosed: () => closed };
}

interface TestIO extends CliIO {
  stdout: string[];
  stderr: string[];
}

function makeIO(driver: Driver): TestIO {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-seed-'));
  fs.writeFileSync(path.join(cwd, 'schema.graphql'), SCHEMA);
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    cwd,
    env: {
      NEO4J_URI: 'bolt://localhost',
      NEO4J_USERNAME: 'neo4j',
      NEO4J_PASSWORD: 'secret',
    },
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
    driverFactory: () => driver,
    stdout,
    stderr,
  };
}

describe('grafeo db seed (cli-db-seed spec)', () => {
  it('runs the default ./seed.js with a connected OGM and closes the driver', async () => {
    const mock = makeDriver();
    const io = makeIO(mock.driver);
    fs.writeFileSync(path.join(io.cwd, 'seed.js'), SEED_OK);

    const code = await runDbSeed([], io);

    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(io.cwd, 'seed-ran.txt'), 'utf-8')).toBe(
      'ok',
    );
    expect(io.stdout.join('\n')).toContain('✓ seed complete');
    expect(mock.isClosed()).toBe(true);
  });

  it('resolves a config-declared seed path over the default', async () => {
    const mock = makeDriver();
    const io = makeIO(mock.driver);
    fs.mkdirSync(path.join(io.cwd, 'scripts'));
    fs.writeFileSync(path.join(io.cwd, 'scripts', 'seed.js'), SEED_OK);
    fs.writeFileSync(
      path.join(io.cwd, 'grafeo.config.json'),
      JSON.stringify({ seed: './scripts/seed.js' }),
    );

    const code = await runDbSeed([], io);

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(io.cwd, 'scripts', 'seed-ran.txt'))).toBe(
      true,
    );
  });

  it('propagates a seed failure but still closes the driver', async () => {
    const mock = makeDriver();
    const io = makeIO(mock.driver);
    fs.writeFileSync(path.join(io.cwd, 'seed.js'), SEED_THROWS);

    await expect(runDbSeed([], io)).rejects.toThrow(/seed boom/);
    expect(mock.isClosed()).toBe(true);
  });

  it('errors with expected locations and an upsert example when no seed exists', async () => {
    const mock = makeDriver();
    const io = makeIO(mock.driver);

    await expect(runDbSeed([], io)).rejects.toThrow(/No seed script found/);
    // The embedded example must promote upsert (idempotent seeding).
    await expect(runDbSeed([], io)).rejects.toThrow(/upsert/);
    // No driver should be created when resolution fails before connecting.
    expect(mock.isClosed()).toBe(false);
  });

  it('closes the driver when the schema is invalid (OGM constructor throws)', async () => {
    const mock = makeDriver();
    const io = makeIO(mock.driver);
    // Valid seed, but a broken schema — the OGM constructor parses the SDL
    // synchronously and throws after the driver was created.
    fs.writeFileSync(
      path.join(io.cwd, 'schema.graphql'),
      'type Book @node {{{',
    );
    fs.writeFileSync(path.join(io.cwd, 'seed.js'), SEED_OK);

    await expect(runDbSeed([], io)).rejects.toThrow();
    expect(mock.isClosed()).toBe(true);
  });
});
