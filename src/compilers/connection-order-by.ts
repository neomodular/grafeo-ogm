import { OGMError } from '../errors';
import type {
  NodeDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../schema/types';
import {
  assertSafeIdentifier,
  assertSafeKey,
  assertSortDirection,
  isPlainObject,
} from '../utils/validation';

/** One normalized connection sort entry (see `SelectionNode.connectionOrderBy`). */
export interface ConnectionOrderByEntry {
  field: string;
  direction: 'ASC' | 'DESC';
  scope: 'node' | 'edge';
}

/**
 * The schema a connection sort is checked against: the connection's target
 * type and relationship. Without it only the shape is checked (scope keys,
 * field names, directions) — the selectionSet parser runs schema-free.
 */
export interface ConnectionOrderBySchema {
  targetDef: NodeDefinition;
  relDef: RelationshipDefinition;
  schema: SchemaMetadata;
}

/**
 * Normalize and validate a connection sort: the typed `select` connection
 * `orderBy`, and (v2.7.0) the selectionSet connection `sort` argument.
 * Both compile through the same `apoc.coll.sortMulti` path.
 *
 * Each entry must be an object with exactly one key: `node` or `edge`.
 * The inner value is a `{ field: 'ASC' | 'DESC' }` map, which may contain
 * multiple fields (preserving insertion order as sort priority).
 *
 * @param argument `orderBy` (typed select) or `sort` (selectionSet) — names
 *   the input in error messages; `orderBy` messages are unchanged from
 *   before v2.7.0.
 */
export function normalizeConnectionOrderBy(
  orderByInput: unknown,
  fieldName: string,
  argument: 'orderBy' | 'sort',
  against?: ConnectionOrderBySchema,
): ConnectionOrderByEntry[] {
  // Example values in messages: JS strings for `orderBy`, GraphQL enum
  // values for a selectionSet `sort`.
  const q = argument === 'orderBy' ? "'" : '';
  const items = Array.isArray(orderByInput) ? orderByInput : [orderByInput];
  const result: ConnectionOrderByEntry[] = [];

  for (const item of items) {
    if (typeof item !== 'object' || item === null)
      throw new OGMError(
        `Invalid ${argument} entry on connection "${fieldName}". ` +
          `Each entry must be an object like { node: { field: ${q}ASC${q} } } or { edge: { field: ${q}DESC${q} } }.`,
      );

    const entries = Object.entries(item as Record<string, unknown>);
    if (entries.length === 0) continue;
    if (entries.length > 1)
      throw new OGMError(
        `Invalid ${argument} entry on connection "${fieldName}". ` +
          `Each entry must have exactly one of "node" or "edge" — got keys: ${entries
            .map(([k]) => `"${k}"`)
            .join(', ')}.`,
      );

    const [scopeKey, scopeValue] = entries[0];
    if (scopeKey !== 'node' && scopeKey !== 'edge')
      throw new OGMError(
        `Invalid ${argument} scope "${scopeKey}" on connection "${fieldName}". ` +
          `Use "node" (to sort by target node fields) or "edge" (to sort by relationship property fields).`,
      );

    if (!isPlainObject(scopeValue))
      throw new OGMError(
        `Invalid ${argument} "${scopeKey}" value on connection "${fieldName}". ` +
          `Expected an object like { field: ${q}ASC${q} }.`,
      );

    const scope = scopeKey as 'node' | 'edge';
    let edgePropsDef: { properties: NodeDefinition['properties'] } | undefined;
    if (scope === 'edge' && against) {
      const { relDef, schema } = against;
      if (!relDef.properties)
        throw new OGMError(
          `Invalid ${argument} on connection "${fieldName}": relationship has no @relationshipProperties, ` +
            `so "edge" sort keys are not available. Use { node: { ... } } instead.`,
        );
      const resolved = schema.relationshipProperties.get(relDef.properties);
      if (!resolved)
        throw new OGMError(
          `Invalid ${argument} on connection "${fieldName}": relationship properties type ` +
            `"${relDef.properties}" is not defined in the schema.`,
        );
      edgePropsDef = resolved;
    }

    for (const [sortField, rawDirection] of Object.entries(scopeValue)) {
      assertSafeKey(sortField, `${argument} ${scope} field`);
      assertSafeIdentifier(sortField, `${argument} ${scope} field`);

      if (against)
        if (scope === 'node') {
          if (!against.targetDef.properties.has(sortField))
            throw new OGMError(
              `Invalid ${argument} node field "${sortField}" on connection "${fieldName}". ` +
                `Field must be a scalar property of ${against.targetDef.typeName}.`,
            );
        } else if (!edgePropsDef?.properties.has(sortField))
          throw new OGMError(
            `Invalid ${argument} edge field "${sortField}" on connection "${fieldName}". ` +
              `Field must be a scalar property of relationship type "${against.relDef.properties}".`,
          );

      const direction = assertSortDirection(String(rawDirection));
      result.push({ field: sortField, direction, scope });
    }
  }

  return result;
}
