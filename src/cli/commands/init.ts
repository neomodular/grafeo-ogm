import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { detectProject } from '../detect';
import { CliError } from '../errors';
import { printSplash } from '../logo';
import type { CliIO } from '../types';

interface InitFlags {
  schema?: string;
  out?: string;
  seed?: boolean;
  fresh?: boolean;
  yes?: boolean;
  force?: boolean;
  debug?: boolean;
}

function parseInitFlags(argv: string[]): InitFlags {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        schema: { type: 'string' },
        out: { type: 'string' },
        seed: { type: 'boolean' },
        fresh: { type: 'boolean' },
        yes: { type: 'boolean' },
        force: { type: 'boolean' },
        debug: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
    return values as InitFlags;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`init: ${message}`);
  }
}

// The classic Neo4j movie graph, expressed in grafeo SDL — recognizable to
// Neo4j users and it exercises relationship arity/direction both ways.
const MOVIE_SCHEMA = `# grafeo schema — the Neo4j movie example.
# Run \`npx grafeo generate\` (or \`npm run generate\`) to emit typed models.

type Movie @node {
  title: String! @unique
  released: Int
  tagline: String
  actors: [Person!]! @relationship(type: "ACTED_IN", direction: IN)
  directors: [Person!]! @relationship(type: "DIRECTED", direction: IN)
}

type Person @node {
  name: String! @id @unique
  born: Int
  actedIn: [Movie!]! @relationship(type: "ACTED_IN", direction: OUT)
  directed: [Movie!]! @relationship(type: "DIRECTED", direction: OUT)
}
`;

const SEED_STUB = `import type { OGM } from 'grafeo-ogm';

// Prefer upsert over create so repeated seeds converge instead of duplicating.
export default async function seed(ogm: OGM) {
  const Movie = ogm.model('Movie');
  await Movie.upsert({
    where: { title: 'The Matrix' },
    create: { title: 'The Matrix', released: 1999 },
    update: { released: 1999 },
  });
}
`;

function renderConfig(
  schemaPath: string,
  outPath: string,
  includeSeed: boolean,
): string {
  // JSON.stringify, NOT string-templating: the paths come from --schema/--out
  // /prompts and this file is later EXECUTED by jiti, so a raw `'${path}'`
  // would let a quote in the path break out and inject code (and an innocent
  // apostrophe would produce a broken config). JSON.stringify emits a fully
  // escaped, valid string literal.
  const seedLine = includeSeed ? `\n  seed: './seed.ts',` : '';
  return `import { defineConfig } from 'grafeo-ogm';

export default defineConfig({
  schema: ${JSON.stringify(rel(schemaPath))},
  out: ${JSON.stringify(rel(outPath))},
  database: {
    uri: process.env.NEO4J_URI,
    username: process.env.NEO4J_USERNAME,
    // Never commit a password — set NEO4J_PASSWORD in your environment.
    password: process.env.NEO4J_PASSWORD,
  },${seedLine}
});
`;
}

/** Normalize a path to a `./`-prefixed relative form for the config file. */
function rel(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

function writeFileEnsuringDir(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
}

/**
 * Add `"generate": "grafeo generate"` to package.json scripts. Non-destructive:
 * an existing `generate` script is preserved. Returns what happened so the
 * summary can report it.
 */
function wireGenerateScript(cwd: string): 'added' | 'kept' | 'none' {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'none';
  // Strip a UTF-8 BOM (common on Windows-edited files) so parse doesn't fail.
  const raw = fs.readFileSync(pkgPath, 'utf-8').replace(/^\uFEFF/, '');
  let pkg: { scripts?: unknown };
  try {
    pkg = JSON.parse(raw) as { scripts?: unknown };
  } catch {
    return 'none';
  }
  // Only treat `scripts` as a map when it's actually an object — otherwise a
  // malformed value would be spread into garbage.
  const scripts =
    typeof pkg.scripts === 'object' && pkg.scripts !== null
      ? (pkg.scripts as Record<string, string>)
      : {};
  if (scripts.generate) return 'kept';

  (pkg as { scripts: Record<string, string> }).scripts = {
    ...scripts,
    generate: 'grafeo generate',
  };
  const indent = /^\t/m.test(raw) ? '\t' : 2;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`, 'utf-8');
  return 'added';
}

/** Pick the schema among detected candidates (prompt only when ambiguous). */
async function chooseSchema(
  candidates: string[],
  io: CliIO,
  canPrompt: boolean,
): Promise<string> {
  if (candidates.length === 1) return candidates[0];
  if (canPrompt && io.prompt) {
    io.out('Multiple grafeo schemas found:');
    candidates.forEach((c, i) => io.out(`  ${i + 1}) ${c}`));
    const answer = await io.prompt('Which is your schema? (number)', '1');
    const idx = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length)
      return candidates[idx];
  }
  return candidates[0];
}

export async function runInit(argv: string[], io: CliIO): Promise<number> {
  const flags = parseInitFlags(argv);
  // Decorative wordmark — interactive TTY only, no-op in CI/piped (see logo.ts).
  printSplash(io);
  const yes = flags.yes === true;
  const force = flags.force === true;
  const canPrompt = io.interactive === true && !yes;

  const detection = detectProject(io.cwd, io.env);
  const hasDetected =
    detection.schemaCandidates.length > 0 || detection.generatedTypes != null;

  // Detected setup vs fresh start.
  let fresh = flags.fresh === true;
  if (hasDetected && !fresh && canPrompt && io.confirm) {
    const detail = [
      detection.schemaCandidates[0]
        ? `schema: ${detection.schemaCandidates[0]}`
        : null,
      detection.generatedTypes ? `types: ${detection.generatedTypes}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const useDetected = await io.confirm(
      `Existing grafeo setup detected (${detail}) — wire the config to it?`,
    );
    fresh = !useDetected;
  }
  const useDetected = hasDetected && !fresh;

  // Resolve schema path: flag > detected > prompt/default.
  let schemaPath = flags.schema;
  if (!schemaPath && useDetected)
    schemaPath = await chooseSchema(detection.schemaCandidates, io, canPrompt);
  if (!schemaPath)
    schemaPath =
      canPrompt && io.prompt
        ? await io.prompt('Schema path?', 'schema.graphql')
        : 'schema.graphql';

  // Resolve output path: flag > detected > prompt/default.
  let outPath = flags.out;
  if (!outPath && useDetected && detection.generatedTypes)
    outPath = detection.generatedTypes;
  if (!outPath)
    outPath =
      canPrompt && io.prompt
        ? await io.prompt('Generated types output path?', 'grafeo.generated.ts')
        : 'grafeo.generated.ts';

  const created: string[] = [];
  const kept: string[] = [];

  // Scaffold the schema only when it doesn't already exist.
  const schemaAbs = path.resolve(io.cwd, schemaPath);
  if (fs.existsSync(schemaAbs)) kept.push(schemaPath);
  else {
    writeFileEnsuringDir(schemaAbs, MOVIE_SCHEMA);
    created.push(schemaPath);
  }

  const wantSeed = flags.seed === true;

  // Write grafeo.config.ts — never clobber an existing one without consent.
  const configAbs = path.resolve(io.cwd, 'grafeo.config.ts');
  const config = renderConfig(schemaPath, outPath, wantSeed);
  if (fs.existsSync(configAbs) && !force) {
    const overwrite =
      canPrompt && io.confirm
        ? await io.confirm('grafeo.config.ts exists — overwrite it?')
        : false;
    if (!overwrite) {
      if (!canPrompt)
        throw new CliError(
          'grafeo.config.ts already exists. Re-run with --force to overwrite.',
        );
      kept.push('grafeo.config.ts');
    } else {
      fs.writeFileSync(configAbs, config, 'utf-8');
      created.push('grafeo.config.ts');
    }
  } else {
    fs.writeFileSync(configAbs, config, 'utf-8');
    created.push('grafeo.config.ts');
  }

  // Optional seed stub.
  if (wantSeed) {
    const seedAbs = path.resolve(io.cwd, 'seed.ts');
    if (fs.existsSync(seedAbs) && !force) kept.push('seed.ts');
    else {
      fs.writeFileSync(seedAbs, SEED_STUB, 'utf-8');
      created.push('seed.ts');
    }
  }

  // Wire an npm script (non-destructive).
  const pkgNote = wireGenerateScript(io.cwd);

  // Summary + next step.
  for (const f of created) io.out(`✓ created ${f}`);
  for (const f of kept) io.out(`• kept ${f} (already present)`);
  if (pkgNote === 'added') io.out('✓ added "generate" script to package.json');
  else if (pkgNote === 'kept')
    io.out('• kept existing "generate" script in package.json');
  io.out('');
  io.out(
    pkgNote === 'added'
      ? 'Next: `npm run generate` (or `npx grafeo generate`)'
      : 'Next: `npx grafeo generate`',
  );
  return 0;
}
