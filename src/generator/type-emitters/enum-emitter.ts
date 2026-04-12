import type { SchemaMetadata } from '../../schema/types';

/**
 * Converts an UPPER_SNAKE_CASE enum value to PascalCase.
 * Values that are already PascalCase (or mixed case) are returned as-is.
 *
 * Examples:
 * - `WELCOME` → `Welcome`
 * - `PENDING_APPROVAL` → `PendingApproval`
 * - `US_BANK_ACCOUNT` → `UsBankAccount`
 * - `Chart` → `Chart` (already PascalCase)
 */
function toPascalCaseEnum(value: string): string {
  // If the value is not all-uppercase (possibly with underscores/digits),
  // it's already in a mixed case format — return as-is
  if (value !== value.toUpperCase()) return value;

  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

/**
 * Emits TypeScript `enum` declarations for every enum found in the schema,
 * plus the always-present `SortDirection` enum.
 */
export function emitEnums(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  // Schema-defined enums (sorted alphabetically)
  const sortedNames = [...schema.enums.keys()].sort();

  for (const name of sortedNames) {
    const values = schema.enums.get(name)!;
    const members = values
      .map((v) => `  ${toPascalCaseEnum(v)} = "${v}",`)
      .join('\n');
    blocks.push(`export enum ${name} {\n${members}\n}`);
  }

  // SortDirection is always emitted (skip if the schema already declares it)
  // Uses Asc/Desc PascalCase for backward compatibility with @neo4j/graphql-ogm
  if (!schema.enums.has('SortDirection'))
    blocks.push(
      `export enum SortDirection {\n  Asc = "ASC",\n  Desc = "DESC",\n}`,
    );

  return blocks.join('\n\n');
}
