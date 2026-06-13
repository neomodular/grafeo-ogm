import { printSplash, shouldShowSplash } from '../../src/cli/logo';
import type { CliIO } from '../../src/cli/types';

function makeIO(opts?: {
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
}): CliIO & { stdout: string[] } {
  const stdout: string[] = [];
  return {
    cwd: '/tmp',
    env: opts?.env ?? {},
    out: (l) => stdout.push(l),
    err: () => undefined,
    interactive: opts?.interactive,
    stdout,
  };
}

const BLUE = '\x1b[38;2;96;165;250m';

describe('logo splash', () => {
  it('prints the wordmark + subtitle, in color, in an interactive terminal', () => {
    const io = makeIO({ interactive: true });
    printSplash(io);
    const out = io.stdout.join('\n');
    expect(out).toContain('██████'); // ANSI Shadow block glyphs
    expect(out).toContain('type-safe ogm for neo4j');
    expect(out).toContain(BLUE); // blueprint blue
  });

  it('is a no-op when not interactive (piped / redirected)', () => {
    const io = makeIO({ interactive: false });
    printSplash(io);
    expect(io.stdout).toEqual([]);
    expect(shouldShowSplash(io)).toBe(false);
  });

  it('is a no-op in CI even when interactive', () => {
    const io = makeIO({ interactive: true, env: { CI: 'true' } });
    printSplash(io);
    expect(io.stdout).toEqual([]);
    expect(shouldShowSplash(io)).toBe(false);
  });

  it('honors NO_COLOR — prints the wordmark without ANSI escapes', () => {
    const io = makeIO({ interactive: true, env: { NO_COLOR: '1' } });
    printSplash(io);
    const out = io.stdout.join('\n');
    expect(out).toContain('██████');
    expect(out).toContain('type-safe ogm for neo4j');
    expect(out).not.toContain('\x1b['); // color suppressed
  });
});
