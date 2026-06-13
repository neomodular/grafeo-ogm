#!/usr/bin/env node
import * as readline from 'node:readline/promises';
import { CliError, renderError } from './errors';
import type { CliIO } from './types';

const HELP = `grafeo — CLI for grafeo-ogm

Usage:
  grafeo init     [--schema <path>] [--out <path>] [--seed] [--fresh] [--yes] [--force]
  grafeo generate [--schema <path>] [--out <path>] [--watch] [--verify] [--poll <ms>]
  grafeo db push  [--schema <path>] [--dry-run] [--force-drop] [--yes]
                  [--uri <bolt-uri>] [--username <user>] [--database <name>]
  grafeo db seed  [--schema <path>] [--uri <bolt-uri>] [--username <user>] [--database <name>]

Global flags:
  --debug   include stack traces in error output
  --help    show this help (or per-command help, e.g. \`grafeo db push --help\`)

Configuration:
  Settings come from grafeo.config.ts (or .js/.json) in the working
  directory; flags override the config file. Database credentials come from
  the config file or NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD /
  NEO4J_DATABASE. The password is never accepted as a flag.`;

/** Focused per-command help, shown for \`grafeo <command> --help\`. */
const COMMAND_HELP: Record<string, string> = {
  init: `grafeo init — scaffold (or auto-detect) a grafeo project

Usage:
  grafeo init [--schema <path>] [--out <path>] [--seed] [--fresh] [--yes] [--force]

  Detects an existing grafeo schema + generated types and wires grafeo.config.ts
  to them. With nothing to detect (or --fresh), scaffolds a starter schema
  (the Neo4j movie example) and config.

  --schema <path>  schema path (skip detection/prompt)
  --out <path>     generated-types output path
  --seed           also scaffold a seed.ts stub
  --fresh          ignore any detected setup and scaffold a new project
  --yes            non-interactive: accept detected values / defaults, no prompts
  --force          overwrite an existing grafeo.config.ts / seed.ts`,
  generate: `grafeo generate — generate TypeScript types from your SDL

Usage:
  grafeo generate [--schema <path>] [--out <path>] [--watch] [--verify] [--poll <ms>]

  --schema <path>  SDL path (default ./schema.graphql)
  --out <path>     output path (default ./grafeo.generated.ts)
  --watch          regenerate on change; a failed parse keeps watching
  --poll <ms>      use polling instead of fs.watch (with --watch only)
  --verify         CI gate: exit 1 if the generated file is stale; writes nothing`,
  'db push': `grafeo db push — sync SDL-declared constraints/indexes to the database

Usage:
  grafeo db push [--schema <path>] [--dry-run] [--force-drop] [--yes]
                 [--uri <bolt-uri>] [--username <user>] [--database <name>]

  --dry-run        print the full plan (with exact Cypher) and exit; no writes
  --force-drop     allow dropping orphaned grafeo-managed constraints/indexes
  --yes            confirm destructive drops non-interactively (CI)

  Additive and idempotent by default. Connection: flags > config > NEO4J_* env.`,
  'db seed': `grafeo db seed — run your seed script with a connected OGM

Usage:
  grafeo db seed [--schema <path>] [--uri <bolt-uri>] [--username <user>] [--database <name>]

  Resolves the seed from config "seed", then ./seed.ts, then ./seed.js.
  The default export receives a connected OGM; use \`upsert\` to stay idempotent.`,
};

/**
 * Dispatch a CLI invocation. Pure with respect to `process` — all side
 * effects flow through `io`, so tests drive commands directly.
 */
export async function main(argv: string[], io: CliIO): Promise<number> {
  // cli-config spec: passwords must never travel through argv (process
  // listings and shell history leak them). Reject before any parsing.
  if (argv.some((a) => a === '--password' || a.startsWith('--password=')))
    return renderError(
      new CliError(
        '--password is not accepted. Set NEO4J_PASSWORD or database.password ' +
          'in grafeo.config.ts instead — flags leak via process listings.',
      ),
      io,
      false,
    );

  const debug = argv.includes('--debug');
  const wantsHelp = argv.includes('--help') || argv.includes('-h');

  // The command (and `db` subcommand) are the leading POSITIONAL tokens, but
  // the global boolean flags may appear anywhere — so we skip those while
  // scanning and stop at the first command-specific flag. Identifying the
  // command by position (not `indexOf` string-match) means a flag VALUE equal
  // to a command name (e.g. a database literally named "push") cannot
  // misroute, and `grafeo --debug generate` still routes to generate.
  const GLOBAL_FLAGS = new Set(['--debug', '--help', '-h']);
  const keywordIndices: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (GLOBAL_FLAGS.has(token)) continue;
    if (token.startsWith('-')) break;
    keywordIndices.push(i);
  }
  const command =
    keywordIndices[0] === undefined ? undefined : argv[keywordIndices[0]];
  const subcommand =
    keywordIndices[1] === undefined ? undefined : argv[keywordIndices[1]];
  const helpKey =
    command === 'db' ? `db ${subcommand ?? ''}`.trim() : (command ?? '');

  // Command argv = everything except the command keyword tokens (by position).
  // Global flags pass through; the command parsers tolerate --debug, and
  // --help is handled here before any dispatch.
  const dropCount = command === 'db' ? 2 : 1;
  const dropped = new Set(keywordIndices.slice(0, dropCount));
  const commandArgs = argv.filter((_, i) => !dropped.has(i));

  try {
    if (!command) {
      io.out(HELP);
      return 0;
    }
    if (wantsHelp) {
      io.out(COMMAND_HELP[helpKey] ?? HELP);
      return 0;
    }

    // Commands load lazily so `generate` never pays for neo4j-driver.
    if (command === 'init') {
      const { runInit } = await import('./commands/init');
      return await runInit(commandArgs, io);
    }

    if (command === 'generate') {
      const { runGenerate } = await import('./commands/generate');
      return await runGenerate(commandArgs, io);
    }

    if (command === 'db' && subcommand === 'push') {
      const { runDbPush } = await import('./commands/db-push');
      return await runDbPush(commandArgs, io);
    }

    if (command === 'db' && subcommand === 'seed') {
      const { runDbSeed } = await import('./commands/db-seed');
      return await runDbSeed(commandArgs, io);
    }

    io.err(
      `error: unknown command "${[command, subcommand].filter(Boolean).join(' ')}"`,
    );
    io.err('');
    io.err(HELP);
    return 1;
  } catch (error) {
    return renderError(error, io, debug);
  }
}

// Bin entry — only when executed directly (the `typeof require` guard keeps
// the ESM build copy import-safe; the published bin points at the CJS build).
/* istanbul ignore next */
if (typeof require !== 'undefined' && require.main === module) {
  const io: CliIO = {
    cwd: process.cwd(),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    interactive: process.stdin.isTTY === true,
    // Real interactive confirmation for destructive `db push --force-drop`.
    // Without this the prompt branch in confirmDrops was unreachable and a
    // TTY user was wrongly refused unless they passed --yes.
    confirm: async (question) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = await rl.question(`${question} [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
    // Free-text prompt for `grafeo init` (path entry, candidate selection).
    prompt: async (question, defaultValue) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const suffix = defaultValue ? ` (${defaultValue})` : '';
        const answer = (await rl.question(`${question}${suffix} `)).trim();
        return answer || defaultValue || '';
      } finally {
        rl.close();
      }
    },
  };
  void main(process.argv.slice(2), io).then((code) => {
    process.exitCode = code;
  });
}
