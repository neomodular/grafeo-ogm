/**
 * Display hygiene for strings sourced from LIVE database introspection.
 *
 * v1.13.0 — names failing `isSafeIdentifier` are correctly routed to
 * `unmanaged` and never executed as Cypher, but they were printed raw. A
 * hostile constraint/index name (Neo4j allows arbitrary characters in
 * backtick-quoted identifiers) could smuggle ANSI/C0 escapes into the
 * developer's terminal — title changes, output spoofing/hiding. The
 * identifier validation that blocks Cypher injection does not cover the
 * display path, so any live-DB string reaching `io.out`/`io.err` must pass
 * through here first.
 */

const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');

/** Replaces C0/C1 control characters with a visible placeholder (U+FFFD). */
export function safeDisplay(value: string): string {
  return value.replace(CONTROL_CHARS, '�');
}
