import { OGMError } from '../errors';
import { assertSafeIdentifier, escapeIdentifier } from '../utils/validation';
import type { NodeDefinition, SchemaMetadata } from './types';

/**
 * v2.11.0 — strict item 23: `@node(labels: [...])` as in `@neo4j/graphql`.
 *
 * Upstream (5.x `getLabels`) uses the listed labels INSTEAD of the type
 * name: reads match all of them (`MATCH (this:K9:Dog)`), creates write
 * exactly those, and constraints / indexes go on the first one. 2.x
 * matches `(n:<TypeName>)`, creates `:<TypeName>:<labels…>` and puts
 * constraints on the type name. `new OGM({ strict: true })` (and
 * `strict: true` in the grafeo config for `db push`) switches to the
 * upstream labels by rewriting the parsed schema once
 * ({@link applyUpstreamNodeLabels}); every label site reads the labels
 * through the helpers below, which return the 2.x label when the node
 * carries no `strictLabels` — so the default output is byte-identical.
 */

/**
 * True when `@node(labels)` gives this type a label set other than its
 * type name alone, i.e. when strict mode compiles it differently.
 * `labels: ["Person"]` on `Person` is the same in both modes.
 */
export function hasCustomNodeLabels(def: NodeDefinition): boolean {
  return !(def.labels.length === 1 && def.labels[0] === def.typeName);
}

/**
 * Rewrite every node with custom `@node(labels)` to the upstream label
 * set: `label` = labels[0] (the main label: constraints, indexes),
 * `labels` = `strictLabels` = the listed labels, deduplicated.
 *
 * Labels are validated here, at OGM construction: upstream resolves
 * `$jwt.*` / `$context.*` placeholders per request, which grafeo-ogm
 * does not support (2.x rejects them on create too), so they throw.
 */
export function applyUpstreamNodeLabels(schema: SchemaMetadata): void {
  for (const def of schema.nodes.values()) {
    if (!hasCustomNodeLabels(def)) continue;
    for (const label of def.labels) {
      if (label.startsWith('$'))
        throw new OGMError(
          `@node(labels) on type "${def.typeName}": label placeholder "${label}" is not supported. ` +
            `grafeo-ogm does not resolve $jwt / $context labels; list literal labels instead.`,
        );
      assertSafeIdentifier(label, `@node(labels) on type "${def.typeName}"`);
    }
    const labels = [...new Set(def.labels)];
    def.label = labels[0];
    def.labels = labels;
    def.strictLabels = labels;
  }
}

/** The labels a node of this type is matched by (and, in strict mode, created with). */
export function nodeLabelList(def: NodeDefinition): readonly string[] {
  return def.strictLabels ?? [def.label];
}

/** Escaped `` `A`:`B` `` label expression for {@link nodeLabelList}. */
export function nodeLabelExpr(def: NodeDefinition): string {
  return def.strictLabels
    ? def.strictLabels.map((l) => escapeIdentifier(l)).join(':')
    : escapeIdentifier(def.label);
}

/**
 * Labels for a concrete type referenced by name (a relationship target,
 * a union / interface member). 2.x uses the type name; strict mode the
 * node's upstream labels.
 */
export function typeLabelList(
  typeName: string,
  schema: SchemaMetadata,
): readonly string[] {
  return schema.nodes.get(typeName)?.strictLabels ?? [typeName];
}

/** Escaped label expression for {@link typeLabelList}. */
export function typeLabelExpr(
  typeName: string,
  schema: SchemaMetadata,
): string {
  const strict = schema.nodes.get(typeName)?.strictLabels;
  return strict
    ? strict.map((l) => escapeIdentifier(l)).join(':')
    : escapeIdentifier(typeName);
}

/**
 * `__typename` of a node that is one of `members`. 2.x picks the label
 * that equals a member name (`head([__label IN labels(n) WHERE …])`);
 * when a member's labels exclude its type name (strict mode, custom
 * `@node(labels)`) that finds nothing, so this returns a `CASE` over each
 * member's label set instead, in declaration order, as upstream does.
 * Returns `null` when no member has custom labels: callers keep the 2.x
 * expression.
 */
export function typenameByLabels(
  nodeVar: string,
  members: readonly string[],
  schema: SchemaMetadata,
): string | null {
  if (!members.some((m) => schema.nodes.get(m)?.strictLabels)) return null;
  const branches = members.map(
    (m) => `WHEN ${nodeVar}:${typeLabelExpr(m, schema)} THEN '${m}'`,
  );
  return `CASE ${branches.join(' ')} END`;
}
