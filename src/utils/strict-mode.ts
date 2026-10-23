import { OGMError } from '../errors';
import type { OGMLogger } from '../execution/executor';

/**
 * v2.6.0 — strict mode.
 *
 * Several input shapes compile to something other than what the caller
 * meant (a typo'd connect key widening to every target, a fulltext `score`
 * inside `OR` being ignored, …). Fixing them in place would change results
 * callers may rely on, so 2.x keeps the old behaviour by default and only
 * WARNS, once per OGM instance and message key, through the OGM's logger.
 * `new OGM({ …, strict: true })` turns on the corrected behaviour, which
 * becomes the default in 3.0.
 *
 * One `StrictMode` is created per OGM and shared by all its compilers.
 * Compilers built without one (direct use, tests) get a lenient instance
 * with no logger: v2.5.3 behaviour, silently.
 */
export class StrictMode {
  /** Keys already warned about. Bounded so user-derived keys cannot grow it forever. */
  private readonly warned = new Set<string>();
  private static readonly MAX_KEYS = 1000;

  constructor(
    readonly strict: boolean = false,
    private readonly logger?: OGMLogger,
  ) {}

  /**
   * Log a deprecation warning for a shape whose behaviour `strict: true`
   * changes. No-op in strict mode (the caller throws or takes the corrected
   * path instead). Each `key` is logged at most once per instance; past
   * {@link StrictMode.MAX_KEYS} distinct keys only the item `code` dedupes.
   *
   * @param code  stable item code, e.g. `connect-unknown-key`
   * @param detail what makes this occurrence distinct (type, field, key)
   * @param problem what is wrong and what 2.x does about it
   * @param fix   what `strict: true` does instead
   */
  warn(code: string, detail: string, problem: string, fix: string): void {
    this.log(
      code,
      detail,
      `[OGM] ${problem} Enable \`strict: true\` (default in 3.0) to ${fix}.`,
    );
  }

  /**
   * v2.8.0 — log a warning, once per instance and key, for a shape whose
   * behaviour is a documented limitation that `strict: true` does NOT
   * change (so the message names no switch). Default mode only, like
   * {@link StrictMode.warn}: strict mode never warns.
   */
  notice(code: string, detail: string, message: string): void {
    this.log(code, detail, `[OGM] ${message}`);
  }

  /**
   * v2.16.0 — whether {@link StrictMode.warn} with this code and detail would
   * log now (default mode, a logger with `warn`, not yet warned). Lets a
   * caller skip work, such as a detection query, that only feeds a warning.
   */
  wouldWarn(code: string, detail: string): boolean {
    if (this.strict || !this.logger?.warn) return false;
    return !this.warned.has(this.keyFor(code, detail));
  }

  private keyFor(code: string, detail: string): string {
    const key = `${code}\u0000${detail}`;
    if (!this.warned.has(key) && this.warned.size >= StrictMode.MAX_KEYS)
      return code;
    return key;
  }

  private log(code: string, detail: string, message: string): void {
    if (this.strict) return;
    const warn = this.logger?.warn;
    if (!warn) return;
    const key = this.keyFor(code, detail);
    if (this.warned.has(key)) return;
    this.warned.add(key);
    warn.call(this.logger, message);
  }
}

/**
 * v2.19.0 — strict item 34: top-level keys of a `Model` /
 * `InterfaceModel` method's params object that the method does not read.
 * Pre-v2.19.0 (and still by default) they are ignored, so an upstream-style
 * `update({ where, delete })` or a `deleteMany({ where, delete })` cascade
 * silently does nothing, and `delete({ where, labels })` deletes without
 * the label filter. Default: one warning per OGM, owner and key set (not
 * per method, so a find routed through findFirst warns once);
 * strict: `OGMError`. Keys set to `undefined` are ignored in both modes.
 *
 * @param owner   the type or interface name
 * @param method  the method the caller invoked
 * @param allowed the keys the method reads
 * @param hints   per-key advice appended to the message
 */
export function checkParamKeys(
  strictMode: StrictMode,
  owner: string,
  method: string,
  params: unknown,
  allowed: readonly string[],
  hints: Readonly<Record<string, string>> = {},
): void {
  if (params === null || typeof params !== 'object' || Array.isArray(params))
    return;
  const record = params as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (k) => record[k] !== undefined && !allowed.includes(k),
  );
  if (unknown.length === 0) return;
  const quote = (keys: readonly string[]) =>
    keys.map((k) => `"${k}"`).join(', ');
  const advice = unknown
    .filter((k) => Object.prototype.hasOwnProperty.call(hints, k))
    .map((k) => ` ${hints[k]}`)
    .join('');
  const what = `parameter${unknown.length > 1 ? 's' : ''} ${quote(unknown)} of ${owner}.${method}()`;
  if (strictMode.strict)
    throw new OGMError(`Unknown ${what}. Allowed: ${quote(allowed)}.${advice}`);
  strictMode.warn(
    'unknown-param',
    `${owner}\u0000${unknown.join(',')}`,
    `Unknown ${what} ${unknown.length > 1 ? 'are' : 'is'} ignored. Allowed: ${quote(allowed)}.${advice}`,
    'throw an OGMError for unknown parameters',
  );
}

/** Lenient, silent instance for compilers constructed without an OGM. */
export function lenientStrictMode(): StrictMode {
  return new StrictMode(false);
}
