/**
 * Escapes special Lucene characters in a query string.
 * Special characters: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
 *
 * Handles multi-character operators (&&, ||) as atomic units,
 * then escapes remaining individual special characters.
 */
export function sanitizeLuceneQuery(query: string): string {
  // First pass: escape multi-char operators as atomic units
  // Use placeholders to prevent double-escaping by the second pass
  let result = query
    .replace(/&&/g, '\u0000AND\u0000')
    .replace(/\|\|/g, '\u0000OR\u0000');

  // Second pass: escape individual special characters (& and | individually)
  result = result.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');

  // Restore multi-char operators with proper escaping
  result = result
    .replace(/\u0000AND\u0000/g, '\\&\\&')
    .replace(/\u0000OR\u0000/g, '\\|\\|');

  return result;
}
