import { OGMError } from '../errors';
import type { PropertyDefinition } from '../schema/types';
import type { StrictMode } from './strict-mode';
import { assertSafeIdentifier, escapeIdentifier } from './validation';

/**
 * v2.14.0 — whether a `@cypher` field is projected as a LIST (strict item
 * 24). `@neo4j/graphql` 5.x resolves a list-typed scalar `@cypher` field
 * by `UNWIND`ing the statement's column and `collect`ing every element
 * (`CustomCypherSelection` + `CypherScalarOperation` / `CypherFilter`), so
 * a statement returning one row per element yields the whole list, one
 * returning a single list row yields that list, and no rows yield `[]`.
 * 2.x reduces every column with `head(collect(...))`, which keeps only
 * the first row's value. Strict mode follows upstream; default mode keeps
 * the 2.x Cypher byte for byte and warns once per OGM, type and field.
 * Non-list fields always take the scalar path.
 */
export function cypherFieldAsList(
  strictMode: StrictMode,
  typeName: string,
  fieldName: string,
  propDef: PropertyDefinition,
): boolean {
  if (!propDef.isArray) return false;
  if (strictMode.strict) return true;
  strictMode.warn(
    'cypher-list-field',
    `${typeName}.${fieldName}`,
    `@cypher list field "${typeName}.${fieldName}" resolves to its statement's first row only: ` +
      `a statement that returns one row per element yields a single element (from an unspecified row), not the list.`,
    `collect every row into the list, as @neo4j/graphql does`,
  );
  return false;
}

/** v2.14.0 — the private name each list element is `UNWIND`ed into. */
function listElementVar(base: string): string {
  const name = `${base}__cf_el`;
  assertSafeIdentifier(name, '@cypher list element');
  return name;
}

/**
 * Builds the `CALL { ... }` subquery that projects a `@cypher` field (used
 * by the SELECT, WHERE and sort preludes). `this` is rebound from the
 * outer node variable inside the subquery, no text substitution.
 *
 * Row-preserving: the user's statement runs in an inner CALL and its
 * `columnName` column is reduced with `head(collect(...))`. A grouping-
 * free aggregation always yields exactly ONE row, so the outer row is
 * kept with `null` when the statement returns no rows, and kept once
 * (first value) when it returns several — matching the nested
 * `head(COLLECT { ... })` projection. Pre-2.4.0 the statement was CALLed
 * directly, which dropped the node on zero rows and duplicated it on many.
 * Works on every Neo4j 5.x (unlike `OPTIONAL CALL`, 5.24+) and still lets
 * the statement return extra columns (unlike `COLLECT { }`).
 */
export function buildCypherFieldCall(
  statement: string,
  nodeVar: string,
  columnName: string,
  /**
   * v2.4.8 — run the statement only for nodes carrying this label (an
   * implementer's field selected through an inline fragment on an
   * abstract type). Other rows still keep their row, with `null`.
   * v2.11.0 — or all of these labels (strict `@node(labels)`).
   */
  guardLabel?: string | readonly string[],
  /**
   * v2.5.3 — name the reduced column with this (unique) alias instead of
   * `columnName`. Pre-2.5.3 the CALL returned `AS <columnName>` and the
   * caller renamed it in a following WITH, so a `columnName` equal to a
   * variable already in scope (`n`, `score`, `__typename`) failed the
   * query with "Variable already declared".
   */
  outputAlias?: string,
  /**
   * v2.14.0 — strict item 24 (see `cypherFieldAsList`): `UNWIND` the
   * column and `collect` every element, as `@neo4j/graphql` does. Still a
   * grouping-free aggregation, so still exactly one row per outer row.
   */
  asList: boolean = false,
): string {
  const col = escapeIdentifier(columnName);
  if (outputAlias !== undefined)
    assertSafeIdentifier(outputAlias, '@cypher alias');
  const out = outputAlias ?? col;
  // v2.5.3 — a statement that returns a column named like the node
  // variable (`RETURN this.rank AS n`) would redeclare it when the inner
  // CALL hands its columns back. Rebind the node to a private name first
  // (only then, so every other statement's Cypher is unchanged).
  const shadows = mentionsIdentifier(statement, nodeVar);
  const inner = shadows ? `${nodeVar}__cf_this` : nodeVar;
  return [
    `CALL {`,
    `  WITH ${nodeVar}`,
    ...(shadows ? [`  WITH ${nodeVar} AS ${inner}`] : []),
    ...(guardLabel !== undefined
      ? [
          `  WITH ${inner} WHERE ${inner}:${(typeof guardLabel === 'string' ? [guardLabel] : guardLabel).map((l) => escapeIdentifier(l)).join(':')}`,
        ]
      : []),
    `  CALL {`,
    `    WITH ${inner}`,
    `    WITH ${inner} AS this`,
    `    ${statement}`,
    `  }`,
    ...(asList
      ? (() => {
          const el = escapeIdentifier(
            listElementVar(outputAlias ?? columnName),
          );
          return [
            `  UNWIND ${col} AS ${el}`,
            `  RETURN collect(${el}) AS ${out}`,
          ];
        })()
      : [`  RETURN head(collect(${col})) AS ${out}`]),
    `}`,
  ].join('\n');
}

/** Whether `name` appears in `cypher` as a standalone identifier token. */
function mentionsIdentifier(cypher: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w.$])\`?${escaped}\`?(?![\\w])`).test(cypher);
}

/**
 * Builds an inline `head(COLLECT { ... })` subquery expression for a
 * `@cypher` scalar field. Used inside contexts where a CALL prelude cannot
 * be stitched — most importantly nested relationship pattern comprehensions
 * (`[(n)-[:r]->(n0) | n0 { ... }]`), where preludes have no anchor.
 *
 * `COLLECT { ... }` is a Cypher 5.x subquery expression; the OGM already
 * requires `neo4j-driver ^5.0.0` so this is safe. The user's statement
 * must return exactly one column — Cypher rejects multi-column COLLECT
 * subqueries. `this` is rebound from the outer node variable, no text
 * substitution.
 *
 * `head(...)` extracts the first (and typically only) returned row; this
 * matches the top-level CALL+WITH path which projects a single value.
 */
export function buildInlineCypherFieldExpr(
  statement: string,
  nodeVar: string,
  /**
   * `Type.field`, for the error raised when the statement aggregates.
   * v2.4.8 — optional so ad-hoc callers keep compiling.
   */
  fieldLabel?: string,
  /**
   * v2.14.0 — strict item 24: the `columnName` of a list field, projected
   * as the whole list. The statement runs in an inner `CALL` so its column
   * can be `UNWIND`ed; `COLLECT { }` keeps `null` elements, which upstream's
   * `collect()` drops, so they are filtered out. Verified on 5.26 inside a
   * pattern comprehension (the statement still must not aggregate).
   */
  listColumn?: string,
): string {
  if (fieldLabel !== undefined)
    assertInlineableCypherField(fieldLabel, statement);
  if (listColumn === undefined)
    return `head(COLLECT { WITH ${nodeVar} AS this\n  ${statement}\n})`;
  const col = escapeIdentifier(listColumn);
  const el = escapeIdentifier(listElementVar(listColumn));
  return (
    `COLLECT { WITH ${nodeVar} AS this\n  CALL {\n    WITH this\n    ${statement}\n  }\n` +
    `  UNWIND ${col} AS ${el}\n  WITH ${el} WHERE ${el} IS NOT NULL\n  RETURN ${el}\n}`
  );
}

/**
 * Cypher's aggregating functions, as a call (`count(`, not the `COUNT {`
 * subquery expression, which does not aggregate the enclosing query).
 */
const AGGREGATING_CALL =
  /(?<![\w.$`])(?:avg|collect|count|max|min|percentileCont|percentileDisc|stDev|stDevP|sum)\s*\(/i;

/**
 * v2.5.3 — string literals and comments, blanked before the aggregation
 * test: pre-2.5.3 `RETURN 'count(' + this.x AS c` was refused. A name
 * qualified with `.` (`apoc.coll.max(`) is not an aggregating call either
 * (see the lookbehind above).
 */
const LITERALS_AND_COMMENTS =
  /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Refuse an aggregating `@cypher` statement where it would be projected
 * inline (v2.4.8). Neo4j 5 rejects ANY aggregating subquery expression
 * nested inside a projection that also references outer variables —
 * "Aggregation column contains implicit grouping expressions" — and fails
 * the whole query. Verified on 5.26 for `head(COLLECT { ... })`, an inner
 * `CALL { }`, `CALL (this) { }`, `WITH count(x) AS c` and a COLLECT in
 * place of the pattern comprehension: none parse. Pre-2.4.8 the query
 * reached the server and failed with that opaque error; the top-level
 * CALL-prelude projection is unaffected and keeps working.
 */
export function assertInlineableCypherField(
  fieldLabel: string,
  statement: string,
): void {
  if (!AGGREGATING_CALL.test(statement.replace(LITERALS_AND_COMMENTS, "''")))
    return;
  throw new OGMError(
    `@cypher field "${fieldLabel}" aggregates in its statement, so it can only be selected at the top level of a query. ` +
      `Neo4j 5 rejects aggregating subqueries nested inside a projection ("Aggregation column contains implicit grouping expressions"), ` +
      `which is how a @cypher field selected through a relationship is projected. Select it on its own model instead, ` +
      `or rewrite the statement without an aggregating function.`,
  );
}

/**
 * Resolver for `@cypher` scalar fields referenced inside a single Cypher
 * "scope" — that is, the contiguous sequence of `WITH`-bound vars at one
 * pipeline level (e.g. the top-level WHERE for `n`, or the inner WHERE
 * inside a `_SOME` quantifier for `r0`).
 *
 * Each resolver:
 * - Dedupes references to the same `(nodeVar, fieldName)` so a field
 *   referenced twice in the same scope is projected once.
 * - Tracks the running list of carried aliases so successive `WITH`
 *   clauses build a complete carry list.
 * - Accepts `preserveVars` (e.g. `__typename`) so the carry list never
 *   drops vars the surrounding pipeline depends on.
 *
 * Different consumers use different `aliasNamespace` values (`__where`,
 * `__sel`) to ensure aliases don't collide across pipelines.
 */
export class CypherFieldScope {
  /**
   * Map keyed by fieldName → alias. Insertion order is preserved → emitted
   * preludes appear in the order they were registered. Each scope is
   * pinned to a single `nodeVar`, so keying on fieldName alone is safe.
   */
  private readonly aliases = new Map<string, string>();
  private readonly callLines: string[] = [];
  private readonly carriedAliases: string[] = [];

  constructor(
    /** Cypher variable this scope is rooted at (`n`, `r0`, `n0`, ...). */
    private readonly nodeVar: string,
    /** Vars already in scope from the surrounding pipeline. */
    private readonly preserveVars: ReadonlyArray<string> = [],
    /** Prefix for generated aliases. `__where`, `__sel`, ... */
    private readonly aliasNamespace: string = '__cf',
  ) {
    assertSafeIdentifier(nodeVar, '@cypher scope nodeVar');
  }

  /**
   * Register (or look up) a prelude for `<nodeVar>.<fieldName>`. Returns the
   * alias to use in the consumer body.
   *
   * The same `fieldName` registered twice returns the same alias and DOES
   * NOT emit a duplicate prelude.
   */
  register(
    fieldName: string,
    propDef: PropertyDefinition,
    /**
     * v2.4.8 — project only for nodes with this label (see
     * `buildCypherFieldCall`); keyed and aliased separately per label.
     * v2.11.0 — or all of these labels (strict `@node(labels)`), keyed
     * and aliased by the labels joined with `_`.
     */
    guardLabels?: string | readonly string[],
    /** v2.14.0 — strict item 24: project the whole list (see `cypherFieldAsList`). */
    asList: boolean = false,
  ): string {
    assertSafeIdentifier(fieldName, '@cypher field');
    const guards =
      typeof guardLabels === 'string' ? [guardLabels] : guardLabels;
    if (guards !== undefined)
      for (const l of guards) assertSafeIdentifier(l, '@cypher guard label');
    const guardLabel = guards === undefined ? undefined : guards.join('_');

    const key =
      guardLabel === undefined ? fieldName : `${guardLabel}:${fieldName}`;
    const cached = this.aliases.get(key);
    if (cached) return cached;

    if (!propDef.cypherStatement)
      throw new Error(
        `Internal: register() called for "${fieldName}" without cypherStatement.`,
      );

    const columnName = propDef.cypherColumnName ?? fieldName;
    assertSafeIdentifier(columnName, '@cypher columnName');

    const alias =
      guardLabel === undefined
        ? `${this.aliasNamespace}_${this.nodeVar}_${fieldName}`
        : `${this.aliasNamespace}_${this.nodeVar}_${guardLabel}_${fieldName}`;
    assertSafeIdentifier(alias, '@cypher alias');

    const carry = [...this.preserveVars, ...this.carriedAliases];
    const carryStr = carry.length ? `, ${carry.join(', ')}` : '';

    this.callLines.push(
      buildCypherFieldCall(
        propDef.cypherStatement,
        this.nodeVar,
        columnName,
        guards,
        alias,
        asList,
      ),
    );
    this.callLines.push(`WITH ${this.nodeVar}${carryStr}, ${alias}`);

    this.carriedAliases.push(alias);
    this.aliases.set(key, alias);

    return alias;
  }

  /** Whether any prelude has been registered. */
  hasAny(): boolean {
    return this.callLines.length > 0;
  }

  /** Emit all the prelude lines (`CALL { ... }` + `WITH ...` pairs). */
  emit(): string[] {
    return [...this.callLines];
  }

  /** Aliases already projected, in registration order. */
  carried(): string[] {
    return [...this.carriedAliases];
  }

  /** The nodeVar this scope is bound to. */
  getNodeVar(): string {
    return this.nodeVar;
  }
}
