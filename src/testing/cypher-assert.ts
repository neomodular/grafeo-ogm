/**
 * Structural Cypher comparison utility that normalizes whitespace
 * and parameter names for deterministic test assertions.
 */
export class CypherAssert {
  /**
   * Normalize a Cypher string for structural comparison:
   * - Collapse all whitespace sequences to a single space
   * - Trim leading/trailing whitespace
   * - Rename params to canonical $p0, $p1, etc. (in order of appearance)
   */
  static normalize(cypher: string): string {
    const collapsed = cypher.replace(/\s+/g, ' ').trim();

    const seen = new Map<string, string>();
    let counter = 0;

    const normalized = collapsed.replace(
      /\$[a-zA-Z_][a-zA-Z0-9_]*/g,
      (match) => {
        if (!seen.has(match)) seen.set(match, `$p${counter++}`);

        return seen.get(match)!;
      },
    );

    return normalized;
  }

  /**
   * Assert two Cypher strings are structurally equal after normalization.
   * Throws an Error if they differ.
   */
  static assertStructurallyEqual(actual: string, expected: string): void {
    const normalizedActual = CypherAssert.normalize(actual);
    const normalizedExpected = CypherAssert.normalize(expected);
    if (normalizedActual !== normalizedExpected)
      throw new Error(
        `Cypher mismatch:\n  Actual:   ${normalizedActual}\n  Expected: ${normalizedExpected}`,
      );
  }

  /**
   * Assert that a Cypher string contains a specific clause.
   * @param cypher - The full Cypher string
   * @param clauseType - e.g., 'WHERE', 'MATCH', 'RETURN', 'SET'
   * @param pattern - Substring to search for within the clause
   */
  static assertContainsClause(
    cypher: string,
    clauseType: string,
    pattern: string,
  ): void {
    if (!cypher.toUpperCase().includes(clauseType.toUpperCase()))
      throw new Error(
        `Cypher does not contain clause '${clauseType}':\n  ${cypher}`,
      );

    if (!cypher.includes(pattern))
      throw new Error(
        `Cypher does not contain pattern '${pattern}':\n  ${cypher}`,
      );
  }

  /**
   * Assert that a Cypher string does NOT contain a specific clause/pattern.
   */
  static assertNotContainsClause(
    cypher: string,
    clauseTypeOrPattern: string,
    pattern?: string,
  ): void {
    const effectivePattern = pattern ?? clauseTypeOrPattern;
    if (cypher.includes(effectivePattern))
      throw new Error(
        `Cypher unexpectedly contains pattern '${effectivePattern}':\n  ${cypher}`,
      );
  }

  /**
   * Assert parameter values match expected.
   * Only checks the keys present in expected (doesn't require exact match on all params).
   */
  static assertParams(
    actual: Record<string, unknown>,
    expected: Record<string, unknown>,
  ): void {
    for (const key of Object.keys(expected)) {
      if (!(key in actual))
        throw new Error(
          `Missing param key '${key}' in actual params: ${JSON.stringify(actual)}`,
        );

      const actualVal = JSON.stringify(actual[key]);
      const expectedVal = JSON.stringify(expected[key]);
      if (actualVal !== expectedVal)
        throw new Error(
          `Param '${key}' mismatch:\n  Actual:   ${actualVal}\n  Expected: ${expectedVal}`,
        );
    }
  }
}
