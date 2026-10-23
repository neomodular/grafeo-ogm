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
 * Returns `true` when `typeName` is a built-in scalar or a custom scalar
 * the schema declares (`scalar JSON`) — i.e. it has a `Scalars` entry.
 */
export function isScalar(
  typeName: string,
  customScalars: ReadonlySet<string> | undefined,
): boolean {
  return SCALAR_TYPES.has(typeName) || (customScalars?.has(typeName) ?? false);
}

/**
 * Maps a GraphQL scalar type name to its TypeScript output representation.
 *
 * Built-in and custom scalars → `Scalars["<TYPE>"]["output"]`
 * Enum / other types → used directly (the type name itself).
 *
 * v2.12.6 — custom scalars map through `Scalars`; pre-2.12.6 they fell
 * through to the bare type name, which the generated file never declares.
 */
export function mapScalarType(
  typeName: string,
  enums: Map<string, string[]>,
  customScalars?: ReadonlySet<string>,
): string {
  if (isScalar(typeName, customScalars))
    return `Scalars["${typeName}"]["output"]`;

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
