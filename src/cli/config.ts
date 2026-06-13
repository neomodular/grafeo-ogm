import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliError } from './errors';
import type { GrafeoConfig, ResolvedConnection } from './types';

/** Discovery order — first match in the working directory wins. */
const CONFIG_FILENAMES = [
  'grafeo.config.ts',
  'grafeo.config.js',
  'grafeo.config.json',
] as const;

const CONFIG_EXAMPLE = `// grafeo.config.ts
import { defineConfig } from 'grafeo-ogm';

export default defineConfig({
  schema: './schema.graphql',
  out: './src/grafeo.generated.ts',
});`;

export interface LoadedConfig {
  config: GrafeoConfig;
  /** Absolute path of the file that was loaded, if any. */
  filePath?: string;
}

/**
 * Discover and load grafeo.config.{ts,js,json} from `cwd`. TS/JS configs
 * load through jiti (the CLI's single runtime dependency) so users get
 * `grafeo.config.ts` without pre-compiling — the same DX as Prisma/Drizzle.
 * Returns an empty config when no file exists; commands fall back to flags
 * and defaults.
 */
export async function loadConfigFile(cwd: string): Promise<LoadedConfig> {
  for (const name of CONFIG_FILENAMES) {
    const filePath = path.join(cwd, name);
    if (!fs.existsSync(filePath)) continue;

    if (name.endsWith('.json'))
      try {
        const parsed = JSON.parse(
          fs.readFileSync(filePath, 'utf-8'),
        ) as GrafeoConfig;
        return { config: parsed, filePath };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError(`Failed to parse ${name}: ${message}`);
      }

    const { createJiti } = await import('jiti');
    const jiti = createJiti(__filename);
    let loaded: unknown;
    try {
      loaded = await jiti.import(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError(`Failed to load ${name}: ${message}`);
    }

    const config = extractConfigExport(loaded, name);
    return { config, filePath };
  }

  return { config: {} };
}

/** Keys a config object may legitimately carry. */
const KNOWN_CONFIG_KEYS = new Set([
  'schema',
  'out',
  'generate',
  'database',
  'seed',
  'vectorIndexes',
]);

/**
 * Pull the config object out of a jiti-loaded module. `export default {…}`
 * arrives under `default`; CJS `module.exports = {…}` arrives as the
 * namespace itself — accepted only when every key is a known config key,
 * so a module that merely forgot its default export fails loudly instead
 * of being silently treated as an (empty-ish) config.
 */
function extractConfigExport(loaded: unknown, name: string): GrafeoConfig {
  const invalid = () =>
    new CliError(
      `${name} must export a configuration object as its default export.\n\n${CONFIG_EXAMPLE}`,
    );

  if (!loaded || typeof loaded !== 'object') throw invalid();

  if ('default' in loaded) {
    const dflt = (loaded as { default: unknown }).default;
    if (!dflt || typeof dflt !== 'object') throw invalid();
    return dflt as GrafeoConfig;
  }

  const keys = Object.keys(loaded);
  if (keys.some((k) => !KNOWN_CONFIG_KEYS.has(k))) throw invalid();
  return loaded as GrafeoConfig;
}

/**
 * Resolve the SDL schema path. Precedence: flag > config > ./schema.graphql
 * (zero-config default, only when the file actually exists). A flag/config
 * path that doesn't exist is an error naming the resolved path; nothing at
 * all is an error showing a minimal config example (cli-config spec).
 */
export function resolveSchemaPath(
  flags: { schema?: string },
  config: GrafeoConfig,
  cwd: string,
): string {
  const declared = flags.schema ?? config.schema;
  if (declared) {
    const resolved = path.resolve(cwd, declared);
    if (!fs.existsSync(resolved))
      throw new CliError(`Schema file not found: ${resolved}`);
    return resolved;
  }

  const fallback = path.resolve(cwd, 'schema.graphql');
  if (fs.existsSync(fallback)) return fallback;

  throw new CliError(
    `No schema found. Pass --schema <path>, set "schema" in grafeo.config.ts, ` +
      `or create ./schema.graphql.\n\n${CONFIG_EXAMPLE}`,
  );
}

/** Resolve the codegen output path. Precedence: flag > config > default. */
export function resolveOutPath(
  flags: { out?: string },
  config: GrafeoConfig,
  cwd: string,
): string {
  return path.resolve(cwd, flags.out ?? config.out ?? 'grafeo.generated.ts');
}

/**
 * Resolve the Neo4j connection per the cli-config spec. Precedence per
 * setting: flag > config `database` block > NEO4J_* env var. The password
 * has NO flag path by design.
 */
export function resolveConnection(
  flags: { uri?: string; username?: string; database?: string },
  config: GrafeoConfig,
  env: NodeJS.ProcessEnv,
): ResolvedConnection {
  const uri = flags.uri ?? config.database?.uri ?? env.NEO4J_URI;
  const username =
    flags.username ?? config.database?.username ?? env.NEO4J_USERNAME;
  const password = config.database?.password ?? env.NEO4J_PASSWORD;
  const database =
    flags.database ?? config.database?.database ?? env.NEO4J_DATABASE;

  const missing: string[] = [];
  if (!uri) missing.push('uri — pass --uri, set database.uri, or NEO4J_URI');
  if (!username)
    missing.push(
      'username — pass --username, set database.username, or NEO4J_USERNAME',
    );
  if (!password)
    missing.push(
      'password — set database.password or NEO4J_PASSWORD (never a flag)',
    );

  if (missing.length > 0)
    throw new CliError(
      `Missing database connection settings:\n  - ${missing.join('\n  - ')}`,
    );

  return {
    uri: uri as string,
    username: username as string,
    password: password as string,
    database,
  };
}
