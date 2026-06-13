import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
  EmptySchemaError,
  generateTypes,
  SchemaParseError,
} from '../../generator/generate-types';
import { loadConfigFile, resolveOutPath, resolveSchemaPath } from '../config';
import { CliError } from '../errors';
import type { CliIO, GrafeoConfig } from '../types';

/** Local HH:MM:SS stamp prefixed to watch-mode lines (cli-generate spec). */
function timeNow(): string {
  return new Date().toTimeString().slice(0, 8);
}

/**
 * Run the generator, naming the schema file in schema-related failures
 * (cli-config error convention: "stderr names the schema file"). The error
 * class is preserved so renderError still tags it (`SchemaParseError: …`) and
 * `--debug` keeps a usable stack. Output-path errors are left untouched —
 * naming the schema file there would mislead.
 */
async function runGenerator(
  typeDefs: string,
  outFile: string,
  config: GrafeoConfig,
  schemaPath: string,
): Promise<Awaited<ReturnType<typeof generateTypes>>> {
  try {
    return await generateTypes({ typeDefs, outFile, config: config.generate });
  } catch (error) {
    if (error instanceof SchemaParseError)
      throw new SchemaParseError(`${schemaPath}: ${error.message}`);
    if (error instanceof EmptySchemaError)
      throw new EmptySchemaError(`${schemaPath}: ${error.message}`);
    throw error;
  }
}

interface GenerateFlags {
  schema?: string;
  out?: string;
  watch?: boolean;
  verify?: boolean;
  poll?: string;
  debug?: boolean;
}

function parseGenerateFlags(argv: string[]): GenerateFlags {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        schema: { type: 'string' },
        out: { type: 'string' },
        watch: { type: 'boolean' },
        verify: { type: 'boolean' },
        poll: { type: 'string' },
        debug: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
    return values;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`generate: ${message}`);
  }
}

async function generateOnce(
  schemaPath: string,
  outPath: string,
  config: GrafeoConfig,
  io: CliIO,
  opts?: { timestamped?: boolean },
): Promise<void> {
  const typeDefs = fs.readFileSync(schemaPath, 'utf-8');
  const result = await runGenerator(typeDefs, outPath, config, schemaPath);
  for (const warning of result.warnings) io.err(`warning: ${warning.message}`);
  const stamp = opts?.timestamped ? `[${timeNow()}] ` : '';
  io.out(
    `${stamp}✓ generated ${result.outputPath} (${result.typeCount} types, ` +
      `${(result.fileSize / 1024).toFixed(1)} kB, ${result.durationMs} ms)`,
  );
}

/**
 * `--verify` (cli-generate spec): generate through the EXACT same
 * `generateTypes()` pipeline (including its Prettier step) into a temp
 * file, byte-compare against the configured output, and never write to
 * it. Reusing the real pipeline is what makes verify-vs-generate drift
 * structurally impossible.
 */
async function verifyOnce(
  schemaPath: string,
  outPath: string,
  config: GrafeoConfig,
  io: CliIO,
): Promise<number> {
  const staleMessage = `Generated types are out of date. Run \`grafeo generate\`.`;

  if (!fs.existsSync(outPath)) {
    io.err(`error: output file does not exist: ${outPath}`);
    io.err(staleMessage);
    return 1;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-verify-'));
  const tmpOut = path.join(tmpDir, path.basename(outPath));
  try {
    const typeDefs = fs.readFileSync(schemaPath, 'utf-8');
    await runGenerator(typeDefs, tmpOut, config, schemaPath);

    const expected = fs.readFileSync(tmpOut, 'utf-8');
    const actual = fs.readFileSync(outPath, 'utf-8');
    if (expected === actual) {
      io.out(`✓ ${outPath} is up to date`);
      return 0;
    }

    io.err(`error: ${outPath} is stale (schema changed since generation)`);
    io.err(staleMessage);
    return 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * `--watch` (cli-generate spec): debounced re-generation on schema change.
 * A failed regeneration prints the error and KEEPS WATCHING. `--poll <ms>`
 * swaps fs.watch for fs.watchFile polling (documented fallback for
 * platforms/editors where fs.watch misfires).
 */
async function watchLoop(
  schemaPath: string,
  outPath: string,
  config: GrafeoConfig,
  io: CliIO,
  pollMs: number | undefined,
): Promise<number> {
  const DEBOUNCE_MS = 100;
  let timer: NodeJS.Timeout | undefined;

  const regenerate = async () => {
    try {
      await generateOnce(schemaPath, outPath, config, io, {
        timestamped: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.err(`watch: generation failed — ${message}`);
      io.err('watch: still watching; fix the schema and save again');
    }
  };

  const onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void regenerate(), DEBOUNCE_MS);
    timer.unref?.();
  };

  let close: () => void;
  if (pollMs !== undefined) {
    fs.watchFile(schemaPath, { interval: pollMs }, onChange);
    close = () => fs.unwatchFile(schemaPath, onChange);
  } else {
    const watcher = fs.watch(schemaPath, onChange);
    close = () => watcher.close();
  }

  io.out(`watching ${schemaPath} — Ctrl-C to stop`);

  return new Promise<number>((resolve) => {
    const finish = () => {
      if (timer) clearTimeout(timer);
      close();
      resolve(0);
    };
    if (io.signal) {
      if (io.signal.aborted) return finish();
      io.signal.addEventListener('abort', finish, { once: true });
    }
    // Without a signal (the real bin), the promise intentionally never
    // resolves — the process runs until killed.
  });
}

export async function runGenerate(argv: string[], io: CliIO): Promise<number> {
  const flags = parseGenerateFlags(argv);
  if (flags.watch && flags.verify)
    throw new CliError('generate: --watch and --verify are mutually exclusive');

  const { config } = await loadConfigFile(io.cwd);
  const schemaPath = resolveSchemaPath(flags, config, io.cwd);
  const outPath = resolveOutPath(flags, config, io.cwd);

  if (flags.verify) return verifyOnce(schemaPath, outPath, config, io);

  let pollMs: number | undefined;
  if (flags.poll !== undefined) {
    pollMs = Math.trunc(Number(flags.poll));
    if (!Number.isFinite(pollMs) || pollMs <= 0)
      throw new CliError('generate: --poll must be a positive integer (ms)');
  }
  if (pollMs !== undefined && !flags.watch)
    throw new CliError('generate: --poll only applies with --watch');

  // Initial generation always runs (and in watch mode a broken schema at
  // startup is reported but does not prevent watching).
  if (flags.watch) {
    try {
      await generateOnce(schemaPath, outPath, config, io, {
        timestamped: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.err(`watch: initial generation failed — ${message}`);
    }
    return watchLoop(schemaPath, outPath, config, io, pollMs);
  }

  await generateOnce(schemaPath, outPath, config, io);
  return 0;
}
