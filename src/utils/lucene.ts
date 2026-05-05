/**
 * Escapes special Lucene characters in a query string.
 *
 * Symbol-form operators escaped:
 *   + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
 *
 * Bareword booleans (`AND`, `OR`, `NOT`, `TO`) are also neutralised. Pre-
 * 1.7.3 they survived sanitisation, letting an attacker inject a boolean
 * query (e.g. `foo AND _exists_:adminFlag`) even after symbol escaping.
 * The standard Lucene analyser lowercases tokens during indexing, so
 * lowercasing the bareword turns it into a literal-word match — which
 * is what callers of `sanitizeLuceneQuery` expect (the function exists
 * to make untrusted user input safe to pass to Lucene). Range-modifier
 * boost/fuzzy (`^N`, `~N`) are already disarmed because `^` and `~`
 * get backslash-escaped in the symbol pass.
 */
export function sanitizeLuceneQuery(query: string): string {
  // FIRST pass: neutralise bareword booleans BEFORE the placeholder dance
  // below. Running this last would let user-typed " AND " / " OR " collide
  // with the restoration regex (which matches those exact tokens) and
  // wrongly rewrite literal user words to escaped `\&\&` / `\|\|`. Running
  // this first turns user `foo AND bar` into `foo and bar` (literal-word
  // match) before any other pass sees it. Word boundaries (`\b`) keep us
  // from touching middle-of-word matches like `BAND` or `STOP`.
  let result = query.replace(/\b(AND|OR|NOT|TO)\b/g, (match) =>
    match.toLowerCase(),
  );

  // Second pass: escape multi-char operators as atomic units. We use
  // " AND " / " OR " as placeholders (rather than NULL bytes) because
  // the lowercase pass above guarantees no user-typed uppercase " AND "
  // / " OR " can survive to collide with the restoration regex below.
  result = result.replace(/&&/g, ' AND ').replace(/\|\|/g, ' OR ');

  // Third pass: escape individual special characters (& and | individually)
  result = result.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');

  // Fourth pass: restore multi-char operators with proper escaping
  result = result.replace(/ AND /g, '\\&\\&').replace(/ OR /g, '\\|\\|');

  return result;
}
