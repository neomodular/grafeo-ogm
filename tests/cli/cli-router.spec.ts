import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main } from '../../src/cli/index';
import { renderError, CliError } from '../../src/cli/errors';
import { OGMError } from '../../src/errors';
import type { CliIO } from '../../src/cli/types';

function makeIO(cwd?: string): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    cwd: cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-cli-')),
    env: {},
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
    stdout,
    stderr,
  };
}

describe('CLI router (cli-config spec)', () => {
  it('prints help and exits 0 with no arguments', async () => {
    const io = makeIO();
    expect(await main([], io)).toBe(0);
    expect(io.stdout.join('\n')).toContain('grafeo generate');
    expect(io.stdout.join('\n')).toContain('grafeo db push');
  });

  it('rejects --password before doing anything else', async () => {
    const io = makeIO();
    expect(await main(['db', 'push', '--password', 'secret'], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain('NEO4J_PASSWORD');
  });

  it('rejects --password=value form too', async () => {
    const io = makeIO();
    expect(await main(['db', 'seed', '--password=secret'], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain('NEO4J_PASSWORD');
  });

  it('unknown command exits non-zero with help on stderr', async () => {
    const io = makeIO();
    expect(await main(['frobnicate'], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain('unknown command "frobnicate"');
  });

  it('shows focused per-command help for `db push --help`', async () => {
    const io = makeIO();
    expect(await main(['db', 'push', '--help'], io)).toBe(0);
    const out = io.stdout.join('\n');
    expect(out).toContain('grafeo db push —');
    expect(out).toContain('--force-drop');
    expect(out).not.toContain('grafeo db seed'); // focused, not the global block
  });

  it('shows focused per-command help for `generate --help`', async () => {
    const io = makeIO();
    expect(await main(['generate', '--help'], io)).toBe(0);
    const out = io.stdout.join('\n');
    expect(out).toContain('grafeo generate —');
    expect(out).toContain('--verify');
  });

  it('routes by leading positional, slicing the command tokens correctly', async () => {
    const io = makeIO();
    // `--out push` (output path named "push") + `--nope` forces a
    // generate-specific parse error, proving generate received the sliced
    // argv intact — a flag value equal to a command name does not misroute.
    expect(await main(['generate', '--out', 'push', '--nope'], io)).toBe(1);
    const err = io.stderr.join('\n');
    expect(err).toContain('generate:');
    expect(err).toContain('--nope');
  });

  it('honors a global flag placed before the command', async () => {
    const io = makeIO();
    // `--debug generate` must route to generate, not be read as "no command".
    // `--nope` forces a generate-specific parse error, proving generate ran.
    expect(await main(['--debug', 'generate', '--nope'], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain('generate:');
  });
});

describe('renderError (cli-config error convention)', () => {
  it('CliError renders message without stack and uses its exit code', () => {
    const io = makeIO();
    const code = renderError(new CliError('boom', 2), io, false);
    expect(code).toBe(2);
    expect(io.stderr.join('\n')).toBe('error: boom');
  });

  it('OGMError renders with its class name', () => {
    const io = makeIO();
    renderError(new OGMError('bad identifier'), io, false);
    expect(io.stderr[0]).toBe('OGMError: bad identifier');
    expect(io.stderr).toHaveLength(1);
  });

  it('--debug appends stack frames without repeating the message', () => {
    const io = makeIO();
    renderError(new CliError('boom'), io, true);
    expect(io.stderr[0]).toBe('error: boom');
    expect(io.stderr.length).toBeGreaterThan(1); // frames emitted
    // The message appears once — the stack's redundant first line is stripped.
    expect(io.stderr.join('\n').match(/boom/g)).toHaveLength(1);
  });

  it('non-Error values are stringified', () => {
    const io = makeIO();
    expect(renderError('plain failure', io, false)).toBe(1);
    expect(io.stderr[0]).toBe('error: plain failure');
  });
});
