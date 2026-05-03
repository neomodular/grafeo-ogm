import type { PropertyDefinition } from '../schema/types';
import { assertSafeIdentifier, escapeIdentifier } from './validation';

/**
 * Builds the `CALL { ... }` subquery that projects a `@cypher` field. Same
 * shape as the v1.5.0 sort prelude — `this` is rebound from the outer node
 * variable inside the subquery, no text substitution.
 */
export function buildCypherFieldCall(
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
): string {
  return `head(COLLECT { WITH ${nodeVar} AS this\n  ${statement}\n})`;
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
  register(fieldName: string, propDef: PropertyDefinition): string {
    assertSafeIdentifier(fieldName, '@cypher field');

    const cached = this.aliases.get(fieldName);
    if (cached) return cached;

    if (!propDef.cypherStatement)
      throw new Error(
        `Internal: register() called for "${fieldName}" without cypherStatement.`,
      );

    const columnName = propDef.cypherColumnName ?? fieldName;
    assertSafeIdentifier(columnName, '@cypher columnName');

    const alias = `${this.aliasNamespace}_${this.nodeVar}_${fieldName}`;
    assertSafeIdentifier(alias, '@cypher alias');

    const carry = [...this.preserveVars, ...this.carriedAliases];
    const carryStr = carry.length ? `, ${carry.join(', ')}` : '';

    this.callLines.push(
      buildCypherFieldCall(propDef.cypherStatement, this.nodeVar),
    );
    this.callLines.push(
      `WITH ${this.nodeVar}${carryStr}, ${escapeIdentifier(columnName)} AS ${alias}`,
    );

    this.carriedAliases.push(alias);
    this.aliases.set(fieldName, alias);

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
