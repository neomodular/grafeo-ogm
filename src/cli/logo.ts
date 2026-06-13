import type { CliIO } from './types';

// grafeo-ogm wordmark — figlet "ANSI Shadow", embedded statically so there is
// NO runtime figlet dependency. Regenerate with the figlet npm package if the
// name ever changes.
const LOGO: readonly string[] = [
  ' ██████╗ ██████╗  █████╗ ███████╗███████╗ ██████╗        ██████╗  ██████╗ ███╗   ███╗',
  '██╔════╝ ██╔══██╗██╔══██╗██╔════╝██╔════╝██╔═══██╗      ██╔═══██╗██╔════╝ ████╗ ████║',
  '██║  ███╗██████╔╝███████║█████╗  █████╗  ██║   ██║█████╗██║   ██║██║  ███╗██╔████╔██║',
  '██║   ██║██╔══██╗██╔══██║██╔══╝  ██╔══╝  ██║   ██║╚════╝██║   ██║██║   ██║██║╚██╔╝██║',
  '╚██████╔╝██║  ██║██║  ██║██║     ███████╗╚██████╔╝      ╚██████╔╝╚██████╔╝██║ ╚═╝ ██║',
  ' ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚══════╝ ╚═════╝        ╚═════╝  ╚═════╝ ╚═╝     ╚═╝',
];

const SUBTITLE = 'type-safe ogm for neo4j';

// Truecolor "blueprint blue" + a dimmer variant for the subtitle.
const BLUE = '\x1b[38;2;96;165;250m';
const DIM = '\x1b[38;2;96;120;160m';
const RESET = '\x1b[0m';

/**
 * A decorative splash is only appropriate when stdout is a real terminal —
 * never in CI, nor when output is piped/redirected (there it would be noise or
 * would corrupt captured output). Gates on stdout (not stdin's `interactive`):
 * `grafeo init > file` and `grafeo init | tee` must NOT leak the ANSI art.
 */
export function shouldShowSplash(io: CliIO): boolean {
  return io.stdoutTTY === true && !io.env.CI;
}

/**
 * Print the grafeo-ogm logo splash. No-op unless interactive (see
 * shouldShowSplash). Honors NO_COLOR by emitting the wordmark uncolored.
 * Routed through io.out so it stays unit-testable.
 */
export function printSplash(io: CliIO): void {
  if (!shouldShowSplash(io)) return;
  // no-color.org: ANY presence of NO_COLOR (even empty string) disables color.
  const color = io.env.NO_COLOR === undefined;
  const width = Math.max(...LOGO.map((l) => l.length));
  const pad = Math.max(0, Math.floor((width - SUBTITLE.length) / 2));
  io.out('');
  for (const line of LOGO) io.out('  ' + (color ? BLUE + line + RESET : line));
  io.out('');
  io.out('  ' + ' '.repeat(pad) + (color ? DIM + SUBTITLE + RESET : SUBTITLE));
  io.out('');
}
