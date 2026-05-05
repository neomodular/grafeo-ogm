import { OGMError } from '../errors';

/** Dangerous property names that could indicate prototype pollution */
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Assert that a key is not a prototype pollution vector.
 */
export function assertSafeKey(key: string, context: string): void {
  if (BLOCKED_KEYS.has(key))
    throw new OGMError(
      `Potentially dangerous key "${key}" in ${context}. This key is not allowed.`,
    );
}

/** Regex for valid Cypher identifiers */
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate that a string is a safe Cypher identifier.
 * Throws if the identifier contains characters that could enable Cypher injection.
 */
export function assertSafeIdentifier(value: string, context: string): void {
  if (!SAFE_IDENTIFIER.test(value))
    throw new OGMError(
      `Invalid identifier "${value}" in ${context}. Identifiers must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
    );
}

/**
 * Escape an identifier for safe interpolation into Cypher queries.
 * Wraps in backticks and doubles any existing backticks inside.
 * This handles Cypher reserved words (ORDER, MATCH, SET, CALL, etc.)
 * since backtick-quoted identifiers bypass keyword interpretation.
 *
 * v1.8.0 fast path: identifiers in well-formed schemas effectively
 * never contain backticks. Skipping the regex-replace + intermediate
 * string allocation in that case shaves ~7ns per call. Multiplied by
 * the dozens of escapeIdentifier calls inside a single compile (every
 * relationship type, every label, every property name), it adds up at
 * high QPS.
 */
export function escapeIdentifier(identifier: string): string {
  if (identifier.indexOf('`') === -1) return `\`${identifier}\``;
  const sanitized = identifier.replace(/`/g, '``');
  return `\`${sanitized}\``;
}

/**
 * Validate a label name is a safe identifier and return it backtick-escaped.
 */
export function assertSafeLabel(label: string): string {
  assertSafeIdentifier(label, 'label');
  return escapeIdentifier(label);
}

/**
 * Validate sort direction is strictly ASC or DESC.
 */
export function assertSortDirection(direction: string): 'ASC' | 'DESC' {
  if (direction !== 'ASC' && direction !== 'DESC')
    throw new OGMError(
      `Invalid sort direction "${direction}". Must be "ASC" or "DESC".`,
    );
  return direction;
}

/**
 * Type guard that narrows an unknown value to a plain object.
 * Returns false for null, arrays, and non-object primitives.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge parameter records into the target. Skips merge if `source` is empty
 * or undefined. Returns the target for chaining.
 *
 * Use this instead of `Object.assign(params, result.params)` to keep call sites
 * declarative and centralize parameter accumulation logic.
 */
export function mergeParams(
  target: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (source) Object.assign(target, source);
  return target;
}
