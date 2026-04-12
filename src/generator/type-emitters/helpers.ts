/**
 * Shared helpers for type emitters — GraphQL-to-TypeScript type mapping
 * and common formatting utilities.
 */

/** Built-in GraphQL scalar names that map to `Scalars[TYPE]["output"]`. */
const SCALAR_TYPES = new Set([
  'ID',
  'String',
  'Int',
  'Float',
  'Boolean',
  'DateTime',
  'BigInt',
  'Date',
  'Time',
  'LocalTime',
  'LocalDateTime',
  'Duration',
  'Point',
  'CartesianPoint',
]);

/**
 * Returns `true` when `typeName` is one of the built-in GraphQL scalars
 * (`ID`, `String`, `Int`, `Float`, `Boolean`, `DateTime`, `BigInt`,
 * `Date`, `Time`, `LocalTime`, `LocalDateTime`, `Duration`, `Point`,
 * `CartesianPoint`).
 */
export function isBuiltInScalar(typeName: string): boolean {
  return SCALAR_TYPES.has(typeName);
}

/**
 * Maps a GraphQL scalar type name to its TypeScript output representation.
 *
 * Built-in scalars → `Scalars["<TYPE>"]["output"]`
 * Enum / other types → used directly (the type name itself).
 */
export function mapScalarType(
  typeName: string,
  enums: Map<string, string[]>,
): string {
  if (SCALAR_TYPES.has(typeName)) return `Scalars["${typeName}"]["output"]`;

  // Enum types are referenced by name directly
  if (enums.has(typeName)) return typeName;

  // Fallback: treat as a known type reference (e.g. another node/interface)
  return typeName;
}

/**
 * Wraps `inner` in `Maybe<>` when the field is optional.
 */
export function wrapMaybe(inner: string, required: boolean): string {
  return required ? inner : `Maybe<${inner}>`;
}

/**
 * Converts a field name to PascalCase (first letter uppercased).
 *
 * Examples:
 * - `drugs`         → `Drugs`
 * - `hasStatus`     → `HasStatus`
 * - `isDescribedBy` → `IsDescribedBy`
 */
export function toPascalCase(fieldName: string): string {
  return fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
}
