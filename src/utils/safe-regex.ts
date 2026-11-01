import { OGMError } from '../errors';
import { assertSafeRegexPattern } from './validation';

/**
 * v2.27.0 — whether the `_MATCHES` guard accepts `pattern`: `true` exactly
 * when {@link assertSafeRegexPattern} would not throw. The accepted set can
 * tighten in a security release, so test the patterns your code sends.
 */
export function isSafeRegexPattern(pattern: string): boolean {
  try {
    assertSafeRegexPattern(pattern, 'isSafeRegexPattern');
    return true;
  } catch (err) {
    if (err instanceof OGMError) return false;
    throw err;
  }
}
