import { OGMError } from '../errors';

/** Dangerous property names that could indicate prototype pollution */
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Assert that a key is not a prototype pollution vector.
 */
export function assertSafeKey(key: string, context: string): void {
  if (BLOCKED_KEYS.has(key))
    throw new OGMError(
      `Potentially dangerous key "${key}" in ${context}. This key is not allowed.`,
    );
}

/**
 * Combined guard for user-supplied property names that will be persisted
 * or matched as node/relationship properties. Blocks prototype-pollution
 * names (`assertSafeKey`) THEN validates identifier shape
 * (`assertSafeIdentifier`) — mirroring the WhereCompiler convention.
 *
 * v1.8.7 — pre-1.8.7 the MutationCompiler validated identifier shape
 * only, so properties literally named `__proto__`/`constructor`/
 * `prototype` (own properties via `JSON.parse` or computed keys) were
 * accepted and persisted to Neo4j. Reads through the OGM stay safe
 * (`Object.create(null)` in ResultMapper), but downstream consumers
 * doing `Object.assign({}, node)` would re-trigger setter semantics on
 * those names. Mutations now reject them, consistent with WHERE filters.
 */
export function assertSafePropertyName(name: string, context: string): void {
  assertSafeKey(name, context);
  assertSafeIdentifier(name, context);
}

/** Regex for valid Cypher identifiers */
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate that a string is a safe Cypher identifier.
 * Throws if the identifier contains characters that could enable Cypher injection.
 */
export function assertSafeIdentifier(value: string, context: string): void {
  if (!SAFE_IDENTIFIER.test(value))
    throw new OGMError(
      `Invalid identifier "${value}" in ${context}. Identifiers must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
    );
}

/**
 * Escape an identifier for safe interpolation into Cypher queries.
 * Wraps in backticks and doubles any existing backticks inside.
 * This handles Cypher reserved words (ORDER, MATCH, SET, CALL, etc.)
 * since backtick-quoted identifiers bypass keyword interpretation.
 *
 * v1.8.0 fast path: identifiers in well-formed schemas effectively
 * never contain backticks. Skipping the regex-replace + intermediate
 * string allocation in that case shaves ~7ns per call. Multiplied by
 * the dozens of escapeIdentifier calls inside a single compile (every
 * relationship type, every label, every property name), it adds up at
 * high QPS.
 */
export function escapeIdentifier(identifier: string): string {
  if (identifier.indexOf('`') === -1) return `\`${identifier}\``;
  const sanitized = identifier.replace(/`/g, '``');
  return `\`${sanitized}\``;
}

/**
 * Validate a label name is a safe identifier and return it backtick-escaped.
 */
export function assertSafeLabel(label: string): string {
  assertSafeIdentifier(label, 'label');
  return escapeIdentifier(label);
}

/**
 * Validate sort direction is strictly ASC or DESC.
 */
export function assertSortDirection(direction: string): 'ASC' | 'DESC' {
  if (direction !== 'ASC' && direction !== 'DESC')
    throw new OGMError(
      `Invalid sort direction "${direction}". Must be "ASC" or "DESC".`,
    );
  return direction;
}

/**
 * Type guard that narrows an unknown value to a plain object.
 * Returns false for null, arrays, and non-object primitives.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge parameter records into the target. Skips merge if `source` is empty
 * or undefined. Returns the target for chaining.
 *
 * Use this instead of `Object.assign(params, result.params)` to keep call sites
 * declarative and centralize parameter accumulation logic.
 */
export function mergeParams(
  target: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (source) Object.assign(target, source);
  return target;
}

/* -------------------------------------------------------------------------- *
 *  `_MATCHES` ReDoS guard — assertSafeRegexPattern
 * -------------------------------------------------------------------------- *
 * The `_MATCHES` where-operator forwards its (bound) value into a Neo4j `=~`
 * predicate, which the server evaluates with Java's *backtracking* regex
 * engine. An attacker who can influence a `where` filter could otherwise
 * supply a catastrophic-backtracking pattern (e.g. `(a+)+$`, `([a-z]+)+$`,
 * `(a?)+$`, `(a|ab)*$`) and pin shared Neo4j CPU — a server-side ReDoS
 * (CWE-1333). Parameterization stops *injection* but not this: the payload
 * *is* the regex.
 *
 * DESIGN — SOUND BY CONSTRUCTION. A static blacklist ("detect the evil
 * shapes, else accept") is fundamentally incomplete: there is always another
 * evil family it misses. So this guard is inverted — it ACCEPTS a pattern
 * only when it can *prove* the pattern is linear, and REJECTS everything
 * else (fail-closed), including every construct it does not fully model.
 * The cost is precision, not safety: some exotic-but-safe patterns are
 * refused. That is the intended trade for a security guard on untrusted
 * input; operators that only need substring/prefix/suffix semantics have
 * dedicated, always-safe forms (`_CONTAINS` / `_STARTS_WITH` / `_ENDS_WITH`
 * / `_IN`), and `_MATCHES` itself can be turned off entirely via
 * `features.filters.String.MATCHES`.
 *
 * The proof sketch: after rejecting alternation, quantified groups, and any
 * unsupported feature, an accepted pattern is a flat concatenation of
 * single-atom matchers (non-quantified groups are transparent). In that
 * shape the ONLY source of super-linear backtracking is two "loose"
 * (variable-length or optional) quantifiers contending over an overlapping
 * character set; the guard rejects unless every such pair is either over
 * provably-disjoint character sets or separated by a required atom whose
 * character set is provably disjoint from both (a hard fence). Both the
 * parse and the pair check are single-pass / bounded (no regex is ever run
 * against the input), so the guard cannot itself become a DoS vector.
 */

/** Longest `_MATCHES` pattern accepted — a shape-independent backstop. */
const MAX_MATCHES_PATTERN_LENGTH = 1000;

/** Most atoms a `_MATCHES` pattern may parse to — bounds the fence scan. */
const MAX_MATCHES_ATOMS = 256;

/**
 * The set of code points a single regex atom can match.
 * `ranges` is a finite union of positive, inclusive code-point ranges, over
 * which disjointness is *provable*. `broad` marks any atom that cannot be
 * pinned to a finite positive set (`.`, `\D`/`\W`/`\S`, negated or exotic
 * classes): a broad set is NEVER reported as provably disjoint from
 * anything, which is what keeps the analysis sound.
 */
type MatchCharSet =
  | {
      readonly kind: 'ranges';
      readonly ranges: ReadonlyArray<readonly [number, number]>;
    }
  | { readonly kind: 'broad' };

interface MatchAtom {
  readonly charset: MatchCharSet;
  /** Quantifier admits a variable number of repetitions or zero (min<max or min===0). */
  readonly loose: boolean;
  /** Quantifier requires at least one repetition (min>=1) — a fence candidate. */
  readonly required: boolean;
}

const BROAD_CHARSET: MatchCharSet = { kind: 'broad' };
const ranges = (
  ...rs: ReadonlyArray<readonly [number, number]>
): MatchCharSet => ({ kind: 'ranges', ranges: rs });

// Predefined ASCII classes (Java's default, non-Unicode semantics).
const CS_DIGIT = ranges([48, 57]); // \d
const CS_WORD = ranges([48, 57], [65, 90], [95, 95], [97, 122]); // \w
const CS_SPACE = ranges([9, 13], [32, 32]); // \s : \t \n \x0B \f \r space

/** All ASCII punctuation — the characters valid as a `\`-escaped literal. */
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

/** True only when two character sets are *provably* disjoint. */
function provablyDisjoint(a: MatchCharSet, b: MatchCharSet): boolean {
  if (a.kind === 'broad' || b.kind === 'broad') return false;
  for (const [al, ah] of a.ranges)
    for (const [bl, bh] of b.ranges) if (al <= bh && bl <= ah) return false;
  return true;
}

/**
 * Inline-flag characters accepted inside `(?…)` / `(?…:`. Deliberately ONLY
 * the flags that provably do not change this analysis: `i` (modeled via
 * caseFold), `m`/`d` (affect only where zero-width `^`/`$` match — never a
 * fence), and `s` (affects only `.`, which is already `broad`). `x`
 * (COMMENTS: whitespace/comments stripped → changes parsing) and `u`/`U`
 * (Unicode-widen `\d\w\s` and Unicode case-folding beyond ASCII) are NOT
 * modeled, so a group carrying them fails the flag scan and is refused
 * fail-closed — otherwise e.g. `(?x)(a+) +` would parse as the exponential
 * `(a+)+` on the server while looking benign here.
 */
const FLAG_CHARS = /[imsd-]/;

/**
 * Fold ASCII letter case into a character set. Under a case-insensitive
 * flag (`(?i)`) `a` also matches `A`, so disjointness must account for it —
 * otherwise `A` could be mistaken for a fence between two `a`-matchers. We
 * over-approximate (fold the whole pattern when `i` appears anywhere), which
 * only ever merges sets and therefore stays sound.
 */
function caseFold(cs: MatchCharSet): MatchCharSet {
  if (cs.kind === 'broad') return cs;
  const out: Array<readonly [number, number]> = [];
  for (const [lo, hi] of cs.ranges) {
    out.push([lo, hi]);
    const uLo = Math.max(lo, 65);
    const uHi = Math.min(hi, 90); // A–Z → +32
    if (uLo <= uHi) out.push([uLo + 32, uHi + 32]);
    const lLo = Math.max(lo, 97);
    const lHi = Math.min(hi, 122); // a–z → −32
    if (lLo <= lHi) out.push([lLo - 32, lHi - 32]);
  }
  return { kind: 'ranges', ranges: out };
}

/**
 * Assert that a `_MATCHES` regex pattern is provably free of catastrophic
 * backtracking. Throws `OGMError` on anything it cannot prove linear. Only
 * string values reach here; the value is already parameterized, so this is a
 * semantic guard on the operator, never string interpolation.
 */
export function assertSafeRegexPattern(pattern: string, context: string): void {
  const refuse = (why: string): never => {
    throw new OGMError(
      `Unsafe \`_MATCHES\` pattern in ${context}: ${why}. ` +
        `It cannot be proven free of catastrophic backtracking (ReDoS) and is refused. ` +
        `Use a dedicated operator (_CONTAINS / _STARTS_WITH / _ENDS_WITH / _IN) where possible, ` +
        `simplify the pattern, or disable the _MATCHES operator via features.filters.String.MATCHES if you must run arbitrary regexes and accept the risk.`,
    );
  };

  // 1. Length cap first — O(1), and bounds every step that follows.
  if (pattern.length > MAX_MATCHES_PATTERN_LENGTH)
    refuse(`pattern exceeds ${MAX_MATCHES_PATTERN_LENGTH} characters`);

  // 2. Parse into a flat atom list, rejecting anything not fully modeled.
  const parsed = parseLinearAtomsOrRefuse(pattern, refuse);
  const atoms = parsed.caseInsensitive
    ? parsed.atoms.map((a) => ({ ...a, charset: caseFold(a.charset) }))
    : parsed.atoms;

  // Hard atom cap — bounds the O(atoms^3) fence scan below to a few ms even
  // on a fully-fenced adversarial pattern. No realistic filter regex has this
  // many atoms; refusing one is a fail-closed backstop, not a real limit.
  if (atoms.length > MAX_MATCHES_ATOMS)
    refuse(`pattern has too many components (>${MAX_MATCHES_ATOMS})`);

  // 3. Loose-pair rule: no two loose atoms may contend over an overlapping
  //    character set unless a hard fence provably separates them.
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (!a.loose) continue;
    for (let j = i + 1; j < atoms.length; j++) {
      const b = atoms[j];
      if (!b.loose) continue;
      if (provablyDisjoint(a.charset, b.charset)) continue;
      let fenced = false;
      for (let k = i + 1; k < j; k++) {
        const m = atoms[k];
        if (
          m.required &&
          provablyDisjoint(m.charset, a.charset) &&
          provablyDisjoint(m.charset, b.charset)
        ) {
          fenced = true;
          break;
        }
      }
      if (!fenced)
        refuse(
          'two variable-length quantifiers can contend over the same input',
        );
    }
  }
}

/**
 * Parse a regex into a flat list of single-atom matchers, inlining
 * non-quantified groups and REFUSING on any construct outside the provably
 * modelable subset (alternation, quantified groups, lookaround, named
 * groups, backreferences, unrecognized escapes, unbalanced brackets, stray
 * quantifiers). Single forward pass — O(n), no backtracking.
 */
function parseLinearAtomsOrRefuse(
  pattern: string,
  refuse: (why: string) => never,
): { atoms: MatchAtom[]; caseInsensitive: boolean } {
  const atoms: MatchAtom[] = [];
  const n = pattern.length;
  let depth = 0; // open non-quantified groups
  let caseInsensitive = false;
  let i = 0;

  while (i < n) {
    const c = pattern[i];

    // Anchors (zero-width) — not atoms, and not fences.
    if (c === '^' || c === '$') {
      i++;
      continue;
    }
    // Word-boundary anchors.
    if (c === '\\' && (pattern[i + 1] === 'b' || pattern[i + 1] === 'B')) {
      i += 2;
      continue;
    }
    // Alternation — not modeled; refuse.
    if (c === '|') refuse('alternation (`|`) is not supported');
    // Group open — plain `(`, non-capturing `(?:`, or inline-flag groups.
    if (c === '(') {
      if (pattern[i + 1] === '?') {
        if (pattern[i + 2] === ':') {
          depth++;
          i += 3;
          continue;
        }
        // `(?flags)` (zero-width) or `(?flags:...)` (scoped). Any other
        // `(?…)` — lookaround, named, atomic — is refused (fail-closed).
        let j = i + 2;
        while (j < n && FLAG_CHARS.test(pattern[j])) j++;
        if (j > i + 2 && (pattern[j] === ')' || pattern[j] === ':')) {
          if (pattern.slice(i + 2, j).includes('i')) caseInsensitive = true;
          if (pattern[j] === ')')
            i = j + 1; // zero-width flag setting — emits no atom
          else {
            depth++;
            i = j + 1; // scoped-flag group behaves like a plain group
          }
          continue;
        }
        refuse('lookaround, named, atomic, or unsupported group syntax');
      }
      depth++;
      i++;
      continue;
    }
    // Group close — refuse a quantifier applied to the group.
    if (c === ')') {
      if (depth === 0) refuse('unbalanced `)`');
      depth--;
      const q = pattern[i + 1];
      if (q === '*' || q === '+' || q === '?' || q === '{')
        refuse('a quantified group cannot be proven linear');
      i++;
      continue;
    }
    // Otherwise: an atom (with an optional quantifier).
    const atom = parseAtomOrRefuse(pattern, i, refuse);
    const quant = parseQuantifier(pattern, atom.next);
    atoms.push({
      charset: atom.charset,
      loose: quant.max !== quant.min || quant.min === 0,
      required: quant.min >= 1,
    });
    i = quant.next;
  }

  if (depth !== 0) refuse('unbalanced `(`');
  return { atoms, caseInsensitive };
}

/** Parse a single atom's character set. Returns the index after the atom. */
function parseAtomOrRefuse(
  p: string,
  i: number,
  refuse: (why: string) => never,
): { charset: MatchCharSet; next: number } {
  const c = p[i];
  if (c === '*' || c === '+' || c === '?' || c === '{' || c === '}')
    refuse('quantifier or brace with no preceding atom');
  if (c === '.') return { charset: BROAD_CHARSET, next: i + 1 };
  if (c === '[') return parseClassOrRefuse(p, i, refuse);
  if (c === '\\') return parseEscapeOrRefuse(p, i, refuse);
  // Ordinary literal character.
  return { charset: ranges([c.charCodeAt(0), c.charCodeAt(0)]), next: i + 1 };
}

/** Parse a `\`-escape at index `i` (points at the backslash). */
function parseEscapeOrRefuse(
  p: string,
  i: number,
  refuse: (why: string) => never,
): { charset: MatchCharSet; next: number } {
  if (i + 1 >= p.length) refuse('trailing backslash');
  const e = p[i + 1];
  switch (e) {
    case 'd':
      return { charset: CS_DIGIT, next: i + 2 };
    case 'w':
      return { charset: CS_WORD, next: i + 2 };
    case 's':
      return { charset: CS_SPACE, next: i + 2 };
    case 'D':
    case 'W':
    case 'S':
      return { charset: BROAD_CHARSET, next: i + 2 }; // complement — broad
    case 'n':
      return { charset: ranges([10, 10]), next: i + 2 };
    case 'r':
      return { charset: ranges([13, 13]), next: i + 2 };
    case 't':
      return { charset: ranges([9, 9]), next: i + 2 };
    case 'f':
      return { charset: ranges([12, 12]), next: i + 2 };
    case 'v':
      // Java (JDK 8+): `\v` is the vertical-whitespace CLASS (includes \n),
      // NOT the single vertical tab it is in JavaScript. Under-modeling it as
      // one char would let `\n*\v*` slip the loose-pair check while Java's
      // engine backtracks on the shared newline — so model it as broad.
      return { charset: BROAD_CHARSET, next: i + 2 };
    default: {
      // `\0`, `\1`…`\9` — octal escapes / backreferences. Java's octal rule
      // (`\0` + 1–3 octal digits) differs from JS and would let the trailing
      // digits mis-parse (e.g. Java reads `\011` as one TAB, inside `\s`); a
      // backreference we cannot model. Refuse all `\<digit>` (fail-closed).
      // Escaped ASCII punctuation → the literal character.
      if (ASCII_PUNCT.test(e))
        return {
          charset: ranges([e.charCodeAt(0), e.charCodeAt(0)]),
          next: i + 2,
        };
      // Backreferences, \x, \u, \p, \k, \Q…\E, and any other escape are not
      // modeled — refuse (fail-closed).
      return refuse(`unsupported escape \`\\${e}\``);
    }
  }
}

/** Parse a `[...]` character class. Returns the index after the closing `]`. */
function parseClassOrRefuse(
  p: string,
  start: number,
  refuse: (why: string) => never,
): { charset: MatchCharSet; next: number } {
  let i = start + 1;
  let negated = false;
  if (p[i] === '^') {
    negated = true;
    i++;
  }
  const rs: Array<readonly [number, number]> = [];
  let broad = false;
  let first = true;

  while (i < p.length) {
    const c = p[i];
    // A `]` closes the class — unless it is the very first member (Java
    // treats a leading `]` as a literal).
    if (c === ']' && !first) {
      i++;
      if (negated || broad) return { charset: BROAD_CHARSET, next: i };
      return { charset: ranges(...rs), next: i };
    }
    first = false;
    if (c === '[') refuse('nested character class is not supported');
    if (c === '&' && p[i + 1] === '&')
      refuse('character-class intersection (`&&`) is not supported');

    // One class member → its low code point (and its index advance).
    let low: number;
    if (c === '\\') {
      if (i + 1 >= p.length) refuse('trailing backslash in character class');
      const e = p[i + 1];
      if (e === 'd' || e === 'w' || e === 's') {
        const set = e === 'd' ? CS_DIGIT : e === 'w' ? CS_WORD : CS_SPACE;
        if (set.kind === 'ranges') rs.push(...set.ranges);
        i += 2;
        continue;
      }
      // `\v` (Java vertical-whitespace class) and the negated/property
      // classes broaden the set beyond a finite positive range we model.
      if (
        e === 'D' ||
        e === 'W' ||
        e === 'S' ||
        e === 'p' ||
        e === 'P' ||
        e === 'v'
      ) {
        broad = true;
        i += 2;
        continue;
      }
      const lit: Record<string, number> = {
        n: 10,
        r: 13,
        t: 9,
        f: 12,
      };
      if (e in lit) low = lit[e];
      else if (ASCII_PUNCT.test(e)) low = e.charCodeAt(0);
      else return refuse(`unsupported escape \`\\${e}\` in character class`);
      i += 2;
    } else {
      low = c.charCodeAt(0);
      i++;
    }

    // Optional range `low-high` (a `-` not immediately before the closing `]`).
    if (p[i] === '-' && i + 1 < p.length && p[i + 1] !== ']') {
      const hc = p[i + 1];
      let high: number;
      if (hc === '\\') {
        if (i + 2 < p.length && ASCII_PUNCT.test(p[i + 2]))
          high = p[i + 2].charCodeAt(0);
        else return refuse('unsupported range endpoint in character class');
        i += 3;
      } else {
        high = hc.charCodeAt(0);
        i += 2;
      }
      if (high < low) refuse('inverted range in character class');
      rs.push([low, high]);
    } else rs.push([low, low]);
  }
  return refuse('unterminated character class');
}

/**
 * Parse a quantifier at index `i` (the position just after an atom). Returns
 * the repetition bounds and the index after the quantifier (and any lazy `?`
 * or possessive `+` modifier). No quantifier → exactly-once `(1,1)`.
 */
function parseQuantifier(
  p: string,
  i: number,
): { min: number; max: number; next: number } {
  const c = p[i];
  let min: number;
  let max: number;
  let next: number;
  if (c === '*') [min, max, next] = [0, Infinity, i + 1];
  else if (c === '+') [min, max, next] = [1, Infinity, i + 1];
  else if (c === '?') [min, max, next] = [0, 1, i + 1];
  else if (c === '{') {
    const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(p.slice(i));
    if (!m) return { min: 1, max: 1, next: i }; // literal `{` — treat atom as exact
    min = Number(m[1]);
    const comma = m[2] as string | undefined;
    const upper = m[3] as string | undefined;
    if (comma === undefined) max = min;
    else if (upper === undefined || upper === '') max = Infinity;
    else max = Number(upper);
    next = i + m[0].length;
  } else return { min: 1, max: 1, next: i };

  // Consume an optional lazy (`?`) or possessive (`+`) modifier.
  if (p[next] === '?' || p[next] === '+') next++;
  return { min, max, next };
}
