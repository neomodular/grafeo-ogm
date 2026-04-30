import type { PropertyDefinition } from '../schema/types';
import {
  assertSafeIdentifier,
  assertSortDirection,
  escapeIdentifier,
} from './validation';

/**
 * Builds the `CALL { ... }` subquery used to project an `@cypher` field
 * for `ORDER BY`. The user's statement is embedded verbatim with `this`
 * rebound from the outer node variable — no text substitution.
 *
 * The caller is expected to follow this CALL with its own `WITH` clause
 * to rename the projected column (`<columnName>`) to a unique alias
 * (e.g. `__sort_<fieldName>`) and carry forward any prior sort aliases.
 *
 * Example output:
 * ```cypher
 * CALL {
 *   WITH n
 *   WITH n AS this
 *   MATCH (this)-[:HAS_STATUS]->(s) RETURN s.name AS statusName
 * }
 * ```
 */
export function buildCypherSortProjection(
  statement: string,
  nodeVar: string,
): string {
  return [
    `CALL {`,
    `  WITH ${nodeVar}`,
    `  WITH ${nodeVar} AS this`,
    `  ${statement}`,
    `}`,
  ].join('\n');
}

/**
 * Compiles a `sort` array (mixed stored-field + `@cypher`-field entries)
 * into the Cypher fragments needed before and after the `RETURN` clause.
 *
 * - Stored fields → emit `<nodeVar>.<field> <DIR>` directly in the ORDER BY.
 *   Byte-identical to the pre-1.5.0 behavior.
 * - `@cypher` fields → emit a `CALL { ... }` subquery plus a `WITH` to
 *   rename the projected column into a unique `__sort_<field>` alias,
 *   carrying forward any prior aliases plus caller-supplied `preserveVars`
 *   (e.g. `__typename` for `InterfaceModel`).
 *
 * The returned `pre` string is intended to be appended BEFORE the `RETURN`,
 * and `orderBy` to be appended AFTER it.
 */
export function compileSortClause(args: {
  sort: ReadonlyArray<Record<string, unknown>>;
  nodeVar: string;
  propertyLookup: (field: string) => PropertyDefinition | undefined;
  preserveVars?: ReadonlyArray<string>;
}): { pre: string; orderBy: string } {
  const { sort, nodeVar, propertyLookup, preserveVars = [] } = args;
  const preLines: string[] = [];
  const sortItems: string[] = [];
  const carriedAliases: string[] = [];

  for (const sortObj of sort) {
    const entries = Object.entries(sortObj as Record<string, string>);
    if (entries.length === 0) continue;
    const [field, direction] = entries[0];
    assertSafeIdentifier(field, 'sort field');
    const validDirection = assertSortDirection(direction);

    const propDef = propertyLookup(field);
    if (propDef?.isCypher && propDef.cypherStatement) {
      const alias = `__sort_${field}`;
      const columnName = propDef.cypherColumnName ?? field;
      assertSafeIdentifier(columnName, '@cypher columnName');

      preLines.push(
        buildCypherSortProjection(propDef.cypherStatement, nodeVar),
      );

      const carry = [...preserveVars, ...carriedAliases];
      const carryStr = carry.length ? `, ${carry.join(', ')}` : '';
      preLines.push(
        `WITH ${nodeVar}${carryStr}, ${escapeIdentifier(columnName)} AS ${alias}`,
      );
      carriedAliases.push(alias);
      sortItems.push(`${alias} ${validDirection}`);
    } else
      sortItems.push(`${nodeVar}.${escapeIdentifier(field)} ${validDirection}`);
  }

  return {
    pre: preLines.join('\n'),
    orderBy: sortItems.length ? `ORDER BY ${sortItems.join(', ')}` : '',
  };
}
