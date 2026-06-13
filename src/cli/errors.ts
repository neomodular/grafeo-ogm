import { OGMError } from '../errors';

/**
 * CLI failure with a controlled exit code. Always rendered as a clean,
 * stack-free message (the stack only appears under --debug).
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** Generator error classes (they extend bare Error, matched by name). */
const GENERATOR_ERROR_NAMES = new Set([
  'SchemaParseError',
  'OutputPathError',
  'EmptySchemaError',
]);

/**
 * Append stack frames only. The leading `Name: message` portion — which spans
 * multiple lines for a multi-line message — is dropped so `--debug` doesn't
 * repeat the human-readable message we already printed. We keep everything
 * from the first real frame (`    at …`) onward.
 */
function emitFrames(error: Error, io: { err(line: string): void }): void {
  if (!error.stack) return;
  const lines = error.stack.split('\n');
  const firstFrame = lines.findIndex((line) => /^\s+at /.test(line));
  if (firstFrame === -1) return;
  io.err(lines.slice(firstFrame).join('\n'));
}

/**
 * Render any thrown value to stderr per the cli-config spec: human-readable
 * message, no stack trace unless `debug`, and return the process exit code.
 */
export function renderError(
  error: unknown,
  io: { err(line: string): void },
  debug: boolean,
): number {
  if (error instanceof CliError) {
    io.err(`error: ${error.message}`);
    if (debug) emitFrames(error, io);
    return error.exitCode;
  }

  if (
    error instanceof OGMError ||
    (error instanceof Error && GENERATOR_ERROR_NAMES.has(error.name))
  ) {
    io.err(`${error.name}: ${error.message}`);
    if (debug) emitFrames(error, io);
    return 1;
  }

  if (error instanceof Error) {
    io.err(`error: ${error.message}`);
    if (debug) emitFrames(error, io);
    return 1;
  }

  io.err(`error: ${String(error)}`);
  return 1;
}
