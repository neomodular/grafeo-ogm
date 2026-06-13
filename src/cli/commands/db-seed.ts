import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { OGM } from '../../ogm';
import {
  loadConfigFile,
  resolveConnection,
  resolveSchemaPath,
} from '../config';
import { createDriver } from '../driver';
import { CliError } from '../errors';
import type { CliIO, GrafeoConfig } from '../types';

interface DbSeedFlags {
  schema?: string;
  uri?: string;
  username?: string;
  database?: string;
  debug?: boolean;
}

type SeedFn = (ogm: OGM) => Promise<void> | void;

/** Idempotent-by-upsert example embedded in the no-seed-found message. */
const SEED_EXAMPLE = `// seed.ts
import type { OGM } from 'grafeo-ogm';

export default async function seed(ogm: OGM) {
  const Book = ogm.model('Book');
  // upsert (not create) so repeated seeds converge instead of duplicating.
  await Book.upsert({
    where: { id: '1' },
    create: { id: '1', title: 'Dune' },
    update: { title: 'Dune' },
  });
}`;

function parseDbSeedFlags(argv: string[]): DbSeedFlags {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        schema: { type: 'string' },
        uri: { type: 'string' },
        username: { type: 'string' },
        database: { type: 'string' },
        debug: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
    return values as DbSeedFlags;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`db seed: ${message}`);
  }
}

/**
 * Resolve the seed entry point (cli-db-seed spec). Precedence: config `seed`
 * → `./seed.ts` → `./seed.js`. A config-declared path that is missing is a
 * pointed "not found" error; the zero-config miss instead shows the expected
 * locations plus an upsert-based example.
 */
function resolveSeedPath(config: GrafeoConfig, cwd: string): string {
  if (config.seed) {
    const resolved = path.resolve(cwd, config.seed);
    if (!fs.existsSync(resolved))
      throw new CliError(`Seed file not found: ${resolved}`);
    return resolved;
  }

  for (const name of ['seed.ts', 'seed.js']) {
    const candidate = path.join(cwd, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new CliError(
    `No seed script found. Looked for:\n` +
      `  - "seed" in grafeo.config.ts\n` +
      `  - ${path.join(cwd, 'seed.ts')}\n` +
      `  - ${path.join(cwd, 'seed.js')}\n\n` +
      `Create one (upsert keeps repeated runs idempotent):\n\n${SEED_EXAMPLE}`,
  );
}

/** Load the seed module through jiti and pull out its default function. */
async function loadSeedFn(seedPath: string): Promise<SeedFn> {
  const { createJiti } = await import('jiti');
  const jiti = createJiti(__filename);

  let loaded: unknown;
  try {
    loaded = await jiti.import(seedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `Failed to load seed ${path.basename(seedPath)}: ${message}`,
    );
  }

  const fn =
    loaded && typeof loaded === 'object' && 'default' in loaded
      ? (loaded as { default: unknown }).default
      : loaded;

  if (typeof fn !== 'function')
    throw new CliError(
      `Seed ${path.basename(seedPath)} must export a default async function ` +
        `\`(ogm) => void\`.\n\n${SEED_EXAMPLE}`,
    );

  return fn as SeedFn;
}

export async function runDbSeed(argv: string[], io: CliIO): Promise<number> {
  const flags = parseDbSeedFlags(argv);
  const { config } = await loadConfigFile(io.cwd);
  const schemaPath = resolveSchemaPath(flags, config, io.cwd);
  const typeDefs = fs.readFileSync(schemaPath, 'utf-8');
  const connection = resolveConnection(flags, config, io.env);

  // Resolve and load the seed BEFORE opening a connection, so a missing or
  // broken seed fails without ever creating a driver.
  const seedPath = resolveSeedPath(config, io.cwd);
  const seed = await loadSeedFn(seedPath);

  const driver = createDriver(io, connection);
  try {
    // The OGM constructor parses the SDL synchronously and throws on an
    // invalid schema — it lives inside this try so the driver created above
    // is still closed in that case (cli-db-seed spec: close on any failure).
    const ogm = new OGM({ typeDefs, driver });
    await ogm.init();

    io.out(`running seed ${seedPath}`);
    try {
      await seed(ogm);
    } finally {
      ogm.close();
    }
    io.out('✓ seed complete');
    return 0;
  } finally {
    await driver.close();
  }
}
