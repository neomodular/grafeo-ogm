/**
 * v2.28.1 — whether a where input's `mode` key names a field of the type.
 *
 * `mode: 'insensitive'` is the case-insensitivity switch of a where input,
 * but a type may declare its own field named `mode` (a property, an
 * `@cypher` field or a relationship). On such a type the key is that
 * field's filter, and the switch is not available. The where compiler and
 * the generated `<Type>Where` input both decide with this function, so the
 * types offer exactly what the runtime compiles. Pre-2.28.1 the compiler
 * always skipped the key (a `mode` filter disappeared) and the generator
 * emitted `mode?` twice.
 */
export function declaresModeField(
  def:
    | {
        properties?: Map<string, unknown>;
        relationships?: Map<string, unknown>;
      }
    | null
    | undefined,
): boolean {
  if (!def) return false;
  return (
    def.properties?.has('mode') === true ||
    def.relationships?.has('mode') === true
  );
}
