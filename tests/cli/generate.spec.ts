import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGenerate } from '../../src/cli/commands/generate';
import type { CliIO } from '../../src/cli/types';

const VALID_SCHEMA = `type Book @node {
  id: ID! @id @unique
  title: String!
}`;

const CHANGED_SCHEMA = `type Book @node {
  id: ID! @id @unique
  title: String!
  publishedYear: Int
}`;

interface TestIO extends CliIO {
  stdout: string[];
  stderr: string[];
}

function makeIO(signal?: AbortSignal): TestIO {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-gen-'));
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    cwd,
    env: {},
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
    signal,
    stdout,
    stderr,
  };
}

function writeSchema(cwd: string, content: string): string {
  const p = path.join(cwd, 'schema.graphql');
  fs.writeFileSync(p, content);
  return p;
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms)
      throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('grafeo generate (cli-generate spec)', () => {
  it('one-shot generation writes the file and exits 0 with a summary', async () => {
    const io = makeIO();
    writeSchema(io.cwd, VALID_SCHEMA);

    const code = await runGenerate([], io);

    expect(code).toBe(0);
    const outPath = path.join(io.cwd, 'grafeo.generated.ts');
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.readFileSync(outPath, 'utf-8')).toContain('export type Book =');
    expect(io.stdout.join('\n')).toMatch(
      /✓ generated .* types, .* kB, \d+ ms\)/,
    );
  });

  it('generation failure writes nothing and names the schema file', async () => {
    const io = makeIO();
    writeSchema(io.cwd, 'type Book @node {{{');

    // cli-config: the error must name the schema file AND the parse error.
    const err = (await runGenerate([], io).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/Failed to parse schema/);
    expect(err.message).toContain('schema.graphql');
    expect(fs.existsSync(path.join(io.cwd, 'grafeo.generated.ts'))).toBe(false);
  });

  it('--verify exits 0 and writes nothing when types are up to date', async () => {
    const io = makeIO();
    writeSchema(io.cwd, VALID_SCHEMA);
    await runGenerate([], io);
    const outPath = path.join(io.cwd, 'grafeo.generated.ts');
    const before = fs.statSync(outPath).mtimeMs;

    const io2 = makeIO();
    io2.cwd = io.cwd;
    const code = await runGenerate(['--verify'], io2);

    expect(code).toBe(0);
    expect(io2.stdout.join('\n')).toContain('up to date');
    expect(fs.statSync(outPath).mtimeMs).toBe(before);
  });

  it('--verify exits 1 and writes nothing when the schema changed', async () => {
    const io = makeIO();
    writeSchema(io.cwd, VALID_SCHEMA);
    await runGenerate([], io);
    const outPath = path.join(io.cwd, 'grafeo.generated.ts');
    const staleContent = fs.readFileSync(outPath, 'utf-8');

    writeSchema(io.cwd, CHANGED_SCHEMA);
    const io2 = makeIO();
    io2.cwd = io.cwd;
    const code = await runGenerate(['--verify'], io2);

    expect(code).toBe(1);
    expect(io2.stderr.join('\n')).toContain('Run `grafeo generate`');
    // The stale file must be untouched — verify never writes.
    expect(fs.readFileSync(outPath, 'utf-8')).toBe(staleContent);
  });

  it('--verify exits 1 when the output file is missing', async () => {
    const io = makeIO();
    writeSchema(io.cwd, VALID_SCHEMA);

    const code = await runGenerate(['--verify'], io);

    expect(code).toBe(1);
    expect(io.stderr.join('\n')).toContain('does not exist');
    expect(io.stderr.join('\n')).toContain('Run `grafeo generate`');
  });

  it('--watch regenerates on change and survives a syntax error', async () => {
    const controller = new AbortController();
    const io = makeIO(controller.signal);
    const schemaPath = writeSchema(io.cwd, VALID_SCHEMA);

    // Poll mode for cross-platform determinism in CI.
    const done = runGenerate(['--watch', '--poll', '50'], io);

    await waitFor(() => io.stdout.some((l) => l.includes('✓ generated')));
    const generatedCount = () =>
      io.stdout.filter((l) => l.includes('✓ generated')).length;
    const initial = generatedCount();

    // Valid change → regeneration.
    fs.writeFileSync(schemaPath, CHANGED_SCHEMA);
    await waitFor(() => generatedCount() > initial);
    expect(
      fs.readFileSync(path.join(io.cwd, 'grafeo.generated.ts'), 'utf-8'),
    ).toContain('publishedYear');
    // cli-generate: watch success lines are timestamped.
    expect(
      io.stdout.some((l) => /^\[\d\d:\d\d:\d\d\] ✓ generated/.test(l)),
    ).toBe(true);

    // Broken change → error reported, watcher stays alive.
    fs.writeFileSync(schemaPath, 'type Book @node {{{');
    await waitFor(() => io.stderr.some((l) => l.includes('generation failed')));
    expect(io.stderr.join('\n')).toContain('still watching');

    // Fixed again → regenerates after the error (proves the loop survived).
    const afterError = generatedCount();
    fs.writeFileSync(schemaPath, VALID_SCHEMA);
    await waitFor(() => generatedCount() > afterError);

    controller.abort();
    expect(await done).toBe(0);
  }, 30000);

  it('rejects --watch combined with --verify', async () => {
    const io = makeIO();
    writeSchema(io.cwd, VALID_SCHEMA);
    await expect(runGenerate(['--watch', '--verify'], io)).rejects.toThrow(
      /mutually exclusive/,
    );
  });

  it('rejects unknown flags with a clear error', async () => {
    const io = makeIO();
    await expect(runGenerate(['--bogus'], io)).rejects.toThrow(/--bogus/);
  });

  it('rejects --poll without --watch instead of silently ignoring it', async () => {
    const io = makeIO();
    writeSchema(io.cwd, VALID_SCHEMA);
    await expect(runGenerate(['--poll', '500'], io)).rejects.toThrow(
      /--poll only applies with --watch/,
    );
  });
});
