import { print, type DocumentNode } from 'graphql';

/**
 * vNEXT — the text of a `selectionSet` given as a string or a DocumentNode.
 *
 * A DocumentNode that still carries `loc.source.body` (a `gql` tag, plain
 * `parse()`) keeps using that body, so parse-cache keys and the compiled
 * Cypher are unchanged. A DocumentNode without location info
 * (`parse(…, { noLocation: true })`, graphql-codegen `documentMode:
 * documentNode`, a JSON-serialized AST) used to fall back to
 * `String(doc)` — `"[object Object]"`, a parse error — and is now printed.
 */
export function selectionSetSource(
  selectionSet: string | DocumentNode,
): string {
  if (typeof selectionSet === 'string') return selectionSet;
  const body = selectionSet?.loc?.source?.body;
  if (body) return body;
  if (
    selectionSet &&
    typeof selectionSet === 'object' &&
    (selectionSet as { kind?: unknown }).kind === 'Document'
  )
    try {
      return print(selectionSet);
    } catch {
      // Not a printable AST: fall through to the old behaviour (a parse
      // error from the selection parser).
    }

  return String(selectionSet);
}
