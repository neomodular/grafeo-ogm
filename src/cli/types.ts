import type { Driver } from 'neo4j-driver';
import type { GenerateTypesConfig } from '../generator/generate-types';

/** Connection settings for commands that contact Neo4j (`db push`, `db seed`). */
export interface GrafeoDatabaseConfig {
  uri?: string;
  username?: string;
  /**
   * Only acceptable here or via NEO4J_PASSWORD — the CLI rejects a
   * `--password` flag because argv leaks via process listings and
   * shell history.
   */
  password?: string;
  database?: string;
}

/**
 * Creation parameters for a `@vector` index. The SDL directive carries no
 * dimensions (it only names the index and embedding property), but Neo4j
 * requires them at CREATE time — `db push` reads them from here, keyed by
 * index name.
 */
export interface GrafeoVectorIndexConfig {
  dimensions: number;
  similarity?: 'cosine' | 'euclidean';
}

/** Shape of `grafeo.config.ts` / `.js` / `.json`. */
export interface GrafeoConfig {
  /** Path to the GraphQL SDL schema file. Default: ./schema.graphql */
  schema?: string;
  /** Output path for generated types. Default: ./grafeo.generated.ts */
  out?: string;
  /** Options forwarded verbatim to generateTypes(). */
  generate?: GenerateTypesConfig;
  /** Connection used by db commands; NEO4J_* env vars fill gaps. */
  database?: GrafeoDatabaseConfig;
  /** Seed script path (default export: `async (ogm: OGM) => void`). */
  seed?: string;
  /** Vector index creation parameters, keyed by index name. */
  vectorIndexes?: Record<string, GrafeoVectorIndexConfig>;
}

/** Identity helper so config files get full type inference. */
export function defineConfig(config: GrafeoConfig): GrafeoConfig {
  return config;
}

export interface ResolvedConnection {
  uri: string;
  username: string;
  password: string;
  database?: string;
}

/**
 * Side-effect boundary for every CLI command. Commands never touch
 * `process` directly — the bin entry constructs the real IO, tests
 * construct a fake one (temp cwd, captured output, mock driver).
 */
export interface CliIO {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  err(line: string): void;
  /** Injection seam: db commands create their driver through this. */
  driverFactory?(connection: ResolvedConnection): Driver;
  /** TTY-interactive session (stdin is a TTY)? Gates confirmation prompts. */
  interactive?: boolean;
  /**
   * Is stdout itself a TTY? Distinct from `interactive` (stdin): decorative
   * output like the logo splash must gate on THIS so `grafeo init > file` or
   * `grafeo init | tee` never leak ANSI art into captured output.
   */
  stdoutTTY?: boolean;
  /** Prompt for yes/no confirmation (only called when interactive). */
  confirm?(question: string): Promise<boolean>;
  /**
   * Prompt for a free-text answer (only called when interactive). Returns the
   * trimmed input, or `defaultValue` when the user enters nothing. Used by
   * `grafeo init` for path entry and detected-vs-fresh selection.
   */
  prompt?(question: string, defaultValue?: string): Promise<string>;
  /**
   * Cooperative shutdown for long-running commands (`generate --watch`).
   * The bin runs without one (Ctrl-C kills the process); tests abort it
   * to end the watch loop deterministically.
   */
  signal?: AbortSignal;
}
