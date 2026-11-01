import { OGMError } from '../errors';
import type { PropertyDefinition, SchemaMetadata } from '../schema/types';
import type { StrictMode } from './strict-mode';
import { buildCypherFieldCall } from './cypher-field-projection';
import {
  assertPlainObject,
  assertSafeIdentifier,
  assertSingleSortKey,
  assertSortDirection,
  escapeIdentifier,
} from './validation';

/**
 * Builds the `CALL { ... }` subquery used to project an `@cypher` field
 * for `ORDER BY` — the same row-preserving shape as the SELECT / WHERE
 * preludes (see `buildCypherFieldCall`): a node whose statement returns
 * no rows sorts with `null` instead of vanishing, and one returning
 * several rows sorts once.
 *
 * With `outputAlias` (v2.5.3) the column comes out under that unique
 * alias (e.g. `__sort_<fieldName>`); the caller follows the CALL with its
 * own `WITH` to carry it forward with any prior sort aliases.
 */
export function buildCypherSortProjection(
  statement: string,
  nodeVar: string,
  columnName: string,
  /** v2.5.3 — see `buildCypherFieldCall`'s `outputAlias`. */
  outputAlias?: string,
): string {
  return buildCypherFieldCall(
    statement,
    nodeVar,
    columnName,
    undefined,
    outputAlias,
  );
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
 *
 * Each entry must carry exactly ONE ordering key — precedence comes from the
 * entry's position in the array. Multi-key entries throw (`assertSingleSortKey`).
 */
export function compileSortClause(args: {
  sort: ReadonlyArray<Record<string, unknown>>;
  nodeVar: string;
  propertyLookup: (field: string) => PropertyDefinition | undefined;
  preserveVars?: ReadonlyArray<string>;
  /**
   * v2.22.1 — security: the ORDER BY expression for a `@cypher` sort key's
   * projected alias. `Model` / `InterfaceModel` filter a node-typed field's
   * value by the target's read policy here (`guardCypherSortRef`), so rows
   * don't sort by a node the caller cannot read. Absent → the bare alias.
   */
  guardCypherSort?: (
    alias: string,
    propDef: PropertyDefinition,
    field: string,
  ) => string;
  /**
   * vNEXT — strict item 47: a root sort key that is a node-typed `@cypher`
   * field (see `checkNodeTypedCypherSortKey`). Absent → no check.
   */
  nodeTypedCypherSort?: {
    schema: SchemaMetadata;
    strictMode: StrictMode;
    typeName: string;
  };
}): { pre: string; orderBy: string } {
  const {
    sort,
    nodeVar,
    propertyLookup,
    preserveVars = [],
    guardCypherSort,
    nodeTypedCypherSort,
  } = args;
  const preLines: string[] = [];
  const sortItems: string[] = [];
  const carriedAliases: string[] = [];

  for (const sortObj of sort) {
    // `Object.entries(null)` is a bare TypeError from inside the compiler;
    // callers expect OGMError for every malformed input on this path.
    assertPlainObject(sortObj, 'Sort entry');

    const entries = Object.entries(sortObj as Record<string, string>);
    // A zero-key entry contributes no ordering (rather than a wrong one), so
    // it stays a silent skip. A multi-key entry is always a mistake.
    if (entries.length === 0) continue;
    // Validate every key, not just the surviving one, so `assertSingleSortKey`
    // only ever interpolates identifier-shaped strings into its message.
    for (const [key] of entries) assertSafeIdentifier(key, 'sort field');
    assertSingleSortKey(entries);

    const [field, direction] = entries[0];
    const validDirection = assertSortDirection(direction);

    const propDef = propertyLookup(field);
    if (propDef?.isCypher && propDef.cypherStatement) {
      if (nodeTypedCypherSort)
        checkNodeTypedCypherSortKey(propDef, field, nodeTypedCypherSort);
      const alias = `__sort_${field}`;
      const columnName = propDef.cypherColumnName ?? field;
      assertSafeIdentifier(columnName, '@cypher columnName');

      preLines.push(
        buildCypherSortProjection(
          propDef.cypherStatement,
          nodeVar,
          columnName,
          alias,
        ),
      );

      const carry = [...preserveVars, ...carriedAliases];
      const carryStr = carry.length ? `, ${carry.join(', ')}` : '';
      preLines.push(`WITH ${nodeVar}${carryStr}, ${alias}`);
      carriedAliases.push(alias);
      const key = guardCypherSort
        ? guardCypherSort(alias, propDef, field)
        : alias;
      sortItems.push(`${key} ${validDirection}`);
    } else
      sortItems.push(`${nodeVar}.${escapeIdentifier(field)} ${validDirection}`);
  }

  return {
    pre: preLines.join('\n'),
    orderBy: sortItems.length ? `ORDER BY ${sortItems.join(', ')}` : '',
  };
}

/**
 * vNEXT — strict item 47 (root sort): a root `options.sort` key that is a
 * node-typed `@cypher` field (a node, a list of nodes, an interface or a
 * union) orders the rows by Neo4j's internal order of nodes, which has no
 * meaning. Default mode keeps that sort (byte-identical Cypher) and warns
 * once per OGM instance and field; strict mode throws. A scalar `@cypher`
 * field sorts by its value, as before.
 */
export function checkNodeTypedCypherSortKey(
  propDef: PropertyDefinition,
  field: string,
  ctx: { schema: SchemaMetadata; strictMode: StrictMode; typeName: string },
): void {
  const { schema, strictMode, typeName } = ctx;
  if (
    !schema.nodes.has(propDef.type) &&
    !schema.interfaces?.has(propDef.type) &&
    !schema.unions?.has(propDef.type)
  )
    return;
  const label = `${typeName}.${field}`;
  const problem =
    `it returns ${propDef.isArray ? 'a list of nodes' : 'a node'} (type "${propDef.type}"), which has no sort order: ` +
    "the rows come back in Neo4j's internal order of those nodes";
  if (strictMode.strict)
    throw new OGMError(
      `Cannot sort by the @cypher field "${label}": ${problem}. Sort by a scalar field (e.g. a scalar @cypher field that returns the node's property) instead.`,
    );
  strictMode.warn(
    'root-sort-cypher-node-field',
    label,
    `A sort by the @cypher field "${label}" has no meaning: ${problem}.`,
    'throw an OGMError for a sort key that cannot be sorted by',
  );
}

/**
 * ORDER BY / SKIP / LIMIT must run on a pass-through `WITH *` BEFORE the
 * RETURN projection. After `RETURN n { ... }` the column `n` is the
 * projected MAP, so `ORDER BY n.<field>` read a key the projection didn't
 * select and every row sorted as null — sort (and therefore pagination)
 * was silently ignored for any field not in the selection. Pre-2.4.3 the
 * options trailed the RETURN. `WITH *` keeps every alias (`__sel_*`,
 * `__sort_*`, `__typename`, ...) in scope, and the RETURN preserves the
 * incoming row order. Paging before projecting is also cheaper.
 */
export function orderBeforeProjection(post: string): string[] {
  return post ? ['WITH *', post] : [];
}

/**
 * v2.24.0 — strict item 49: whether `options` both sort (a non-empty `sort`)
 * and page (`offset` or `limit`). Only then does moving the SELECT
 * `@cypher` preludes after the paging save work: an unsorted LIMIT already
 * stops early, and an unpaged sort evaluates every row either way.
 */
export function sortsAndPages(
  options:
    | { sort?: ReadonlyArray<unknown>; offset?: unknown; limit?: unknown }
    | undefined,
): boolean {
  if (!options?.sort?.length) return false;
  return options.offset != null || options.limit != null;
}
