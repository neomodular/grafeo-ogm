/**
 * JSON with object keys sorted at every depth and bigints written as
 * `{"$bigint":"<digits>"}`, so two values compare equal regardless of key
 * order and a bigint never equals the number or string with its digits.
 *
 * Every pair that JSON.stringify called equal before v2.4.8 is still equal:
 * this only sorts keys and gives bigint (which used to throw a TypeError)
 * an encoding. A neo4j Integer stays `{"high":…,"low":…}`, so it equals an
 * Integer of the same value and not a plain number.
 */
function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return { $bigint: v.toString() };
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort())
        sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}

interface Token {
  kind: 'word' | 'param' | 'quoted' | 'comment' | 'space' | 'punct';
  text: string;
  start: number;
  end: number;
}

/**
 * Split Cypher into tokens, keeping string literals, backticked names and
 * comments whole so nothing inside them is read as a keyword, a parameter
 * or collapsible whitespace (v2.5.0).
 */
function tokenize(cypher: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: Token['kind'], end: number) => {
    tokens.push({ kind, text: cypher.slice(i, end), start: i, end });
    i = end;
  };
  while (i < cypher.length) {
    const ch = cypher[i];
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < cypher.length && /\s/.test(cypher[j])) j++;
      push('space', j);
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < cypher.length && cypher[j] !== ch)
        j += cypher[j] === '\\' ? 2 : 1;
      push('quoted', Math.min(j + 1, cypher.length));
    } else if (ch === '`') {
      // A backticked name escapes a backtick by doubling it.
      let j = i + 1;
      while (j < cypher.length)
        if (cypher[j] === '`' && cypher[j + 1] === '`') j += 2;
        else if (cypher[j] === '`') break;
        else j++;
      push('quoted', Math.min(j + 1, cypher.length));
    } else if (cypher.startsWith('//', i)) {
      const nl = cypher.indexOf('\n', i);
      push('comment', nl === -1 ? cypher.length : nl);
    } else if (cypher.startsWith('/*', i)) {
      const close = cypher.indexOf('*/', i + 2);
      push('comment', close === -1 ? cypher.length : close + 2);
    } else if (ch === '$' && /[A-Za-z_]/.test(cypher[i + 1] ?? '')) {
      let j = i + 1;
      while (j < cypher.length && /[A-Za-z0-9_]/.test(cypher[j])) j++;
      push('param', j);
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      let j = i + 1;
      while (j < cypher.length && /[A-Za-z0-9_]/.test(cypher[j])) j++;
      push('word', j);
    } else push('punct', i + 1);
  }
  return tokens;
}

/** Keywords that start a clause, and so end the clause before them. */
const CLAUSE_KEYWORDS = new Set([
  'CALL',
  'CREATE',
  'DELETE',
  'DETACH',
  'FINISH',
  'FOREACH',
  'LIMIT',
  'LOAD',
  'MATCH',
  'MERGE',
  'OFFSET',
  'ON',
  'OPTIONAL',
  'ORDER',
  'REMOVE',
  'RETURN',
  'SET',
  'SKIP',
  'UNION',
  'UNWIND',
  'USE',
  'WHERE',
  'WITH',
  'YIELD',
]);

/** The tokens that carry meaning, so keyword checks look past whitespace. */
function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.kind !== 'space' && t.kind !== 'comment');
}

/**
 * Whether `sig[k]` (a word) is used as a keyword rather than a name: not a
 * property (`.set`), a label or type (`:Set`), a map key (`set:`), or the
 * WITH of `STARTS WITH` / `ENDS WITH`.
 */
function isKeywordUse(sig: Token[], k: number): boolean {
  const prev = sig[k - 1];
  const next = sig[k + 1];
  if (prev?.kind === 'punct' && (prev.text === '.' || prev.text === ':'))
    return false;
  if (next?.kind === 'punct' && next.text === ':') return false;
  if (
    sig[k].text.toUpperCase() === 'WITH' &&
    prev?.kind === 'word' &&
    ['STARTS', 'ENDS'].includes(prev.text.toUpperCase())
  )
    return false;
  return true;
}

/**
 * The source text of every occurrence of `clauseType` used as a keyword:
 * from the keyword to the next clause keyword at the same bracket depth,
 * a `|` at that depth (list and pattern comprehensions), or the bracket
 * that closes the enclosing one — whichever comes first.
 */
function clauseSegments(cypher: string, clauseType: string): string[] {
  const words = clauseType.trim().toUpperCase().split(/\s+/);
  const sig = significant(tokenize(cypher));
  const segments: string[] = [];

  for (let k = 0; k + words.length <= sig.length; k++) {
    const matches = words.every(
      (w, n) =>
        sig[k + n].kind === 'word' && sig[k + n].text.toUpperCase() === w,
    );
    if (!matches || !isKeywordUse(sig, k)) continue;

    let depth = 0;
    let end = cypher.length;
    for (let j = k + words.length; j < sig.length; j++) {
      const t = sig[j];
      if (t.kind === 'punct' && '([{'.includes(t.text)) depth++;
      else if (t.kind === 'punct' && ')]}'.includes(t.text)) {
        if (--depth < 0) {
          end = t.start;
          break;
        }
      } else if (depth === 0 && t.kind === 'punct' && t.text === '|') {
        end = t.start;
        break;
      } else if (
        depth === 0 &&
        t.kind === 'word' &&
        CLAUSE_KEYWORDS.has(t.text.toUpperCase()) &&
        isKeywordUse(sig, j)
      ) {
        end = t.start;
        break;
      }
    }
    segments.push(cypher.slice(sig[k].start, end));
  }
  return segments;
}

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
   *
   * String literals and backticked names are kept verbatim (v2.5.0): their
   * whitespace is part of the value, and a `$name` inside a string is text,
   * not a parameter. Before v2.5.0 both were collapsed and renamed, so
   * `'a  b'` equalled `'a b'`.
   */
  static normalize(cypher: string): string {
    const seen = new Map<string, string>();
    let counter = 0;

    return tokenize(cypher)
      .map((t) => {
        if (t.kind === 'space') return ' ';
        if (t.kind === 'comment') return t.text.replace(/\s+/g, ' ');
        if (t.kind === 'param') {
          if (!seen.has(t.text)) seen.set(t.text, `$p${counter++}`);
          return seen.get(t.text)!;
        }
        return t.text;
      })
      .join('')
      .trim();
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
   * Assert that a Cypher string contains a clause, and that `pattern`
   * appears inside that clause.
   *
   * The clause keyword is matched case-insensitively as a whole word (or
   * words, e.g. 'ORDER BY', 'ON CREATE SET'), never inside a name, a
   * parameter, a string or a comment. A clause runs from its keyword to the
   * next clause keyword at the same bracket depth (WHERE, ORDER BY, SKIP and
   * LIMIT each count as their own clause), a `|` at that depth, or the
   * bracket closing the enclosing one. The assertion passes when any
   * occurrence of the clause contains `pattern`.
   *
   * Before v2.5.0 the clause was a raw substring (`'SET'` matched
   * `$offset`) and `pattern` could appear anywhere in the query.
   *
   * @param cypher - The full Cypher string
   * @param clauseType - e.g., 'WHERE', 'MATCH', 'RETURN', 'SET'
   * @param pattern - Substring to search for within the clause
   */
  static assertContainsClause(
    cypher: string,
    clauseType: string,
    pattern: string,
  ): void {
    const segments = clauseSegments(cypher, clauseType);
    if (segments.length === 0)
      throw new Error(
        `Cypher does not contain clause '${clauseType}':\n  ${cypher}`,
      );

    if (!segments.some((s) => s.includes(pattern)))
      throw new Error(
        `Cypher does not contain pattern '${pattern}' within a '${clauseType}' clause:\n  ${cypher}`,
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

      const actualVal = canonicalJson(actual[key]);
      const expectedVal = canonicalJson(expected[key]);
      if (actualVal !== expectedVal)
        throw new Error(
          `Param '${key}' mismatch:\n  Actual:   ${actualVal}\n  Expected: ${expectedVal}`,
        );
    }
  }
}
