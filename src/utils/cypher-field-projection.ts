import { OGMError } from '../errors';
import type { PropertyDefinition } from '../schema/types';
import { assertSafeIdentifier, escapeIdentifier } from './validation';

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
   * v2.5.0 — run the statement only for nodes carrying this label (an
   * implementer's field selected through an inline fragment on an
   * abstract type). Other rows still keep their row, with `null`.
   */
  guardLabel?: string,
): string {
  const col = escapeIdentifier(columnName);
  return [
    `CALL {`,
    `  WITH ${nodeVar}`,
    ...(guardLabel !== undefined
      ? [`  WITH ${nodeVar} WHERE ${nodeVar}:${escapeIdentifier(guardLabel)}`]
      : []),
    `  CALL {`,
    `    WITH ${nodeVar}`,
    `    WITH ${nodeVar} AS this`,
    `    ${statement}`,
    `  }`,
    `  RETURN head(collect(${col})) AS ${col}`,
    `}`,
  ].join('\n');
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
   * v2.5.0 — optional so ad-hoc callers keep compiling.
   */
  fieldLabel?: string,
): string {
  if (fieldLabel !== undefined)
    assertInlineableCypherField(fieldLabel, statement);
  return `head(COLLECT { WITH ${nodeVar} AS this\n  ${statement}\n})`;
}

/**
 * Cypher's aggregating functions, as a call (`count(`, not the `COUNT {`
 * subquery expression, which does not aggregate the enclosing query).
 */
const AGGREGATING_CALL =
  /\b(?:avg|collect|count|max|min|percentileCont|percentileDisc|stDev|stDevP|sum)\s*\(/i;

/**
 * Refuse an aggregating `@cypher` statement where it would be projected
 * inline (v2.5.0). Neo4j 5 rejects ANY aggregating subquery expression
 * nested inside a projection that also references outer variables —
 * "Aggregation column contains implicit grouping expressions" — and fails
 * the whole query. Verified on 5.26 for `head(COLLECT { ... })`, an inner
 * `CALL { }`, `CALL (this) { }`, `WITH count(x) AS c` and a COLLECT in
 * place of the pattern comprehension: none parse. Pre-2.5.0 the query
 * reached the server and failed with that opaque error; the top-level
 * CALL-prelude projection is unaffected and keeps working.
 */
export function assertInlineableCypherField(
  fieldLabel: string,
  statement: string,
): void {
  if (!AGGREGATING_CALL.test(statement)) return;
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
     * v2.5.0 — project only for nodes with this label (see
     * `buildCypherFieldCall`); keyed and aliased separately per label.
     */
    guardLabel?: string,
  ): string {
    assertSafeIdentifier(fieldName, '@cypher field');
    if (guardLabel !== undefined)
      assertSafeIdentifier(guardLabel, '@cypher guard label');

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
        guardLabel,
      ),
    );
    this.callLines.push(
      `WITH ${this.nodeVar}${carryStr}, ${escapeIdentifier(columnName)} AS ${alias}`,
    );

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
