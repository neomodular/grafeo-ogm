import type {
  NodeDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from './types';
import {
  assertSafeIdentifier,
  assertSafeLabel,
  escapeIdentifier,
} from '../utils/validation';

/**
 * Module-level cache for resolved union/interface target definitions,
 * one inner map per parsed schema. Each inner map is bounded by the number
 * of unique type names in that schema (~50-100 entries).
 *
 * v2.12.4 — keyed by schema identity. Pre-2.12.4 a single map was keyed by
 * type name only, so two OGMs with different schemas shared entries: an
 * interface/union resolved by OGM A was served to OGM B (wrong property
 * types, false unknown-field warnings). The `WeakMap` lets a discarded
 * schema's entries be collected with it.
 * Use `clearResolveTargetDefCache()` to reset (e.g., between tests).
 */
let resolveTargetDefCache = new WeakMap<
  SchemaMetadata,
  Map<string, NodeDefinition | null>
>();

function schemaResolveCache(
  schema: SchemaMetadata,
): Map<string, NodeDefinition | null> {
  let cache = resolveTargetDefCache.get(schema);
  if (!cache) {
    cache = new Map();
    resolveTargetDefCache.set(schema, cache);
  }
  return cache;
}

/**
 * Clear the module-level resolve cache (every schema's entries).
 * Useful in tests to prevent cross-test state pollution.
 */
export function clearResolveTargetDefCache(): void {
  resolveTargetDefCache = new WeakMap();
}

/**
 * Resolve a target type name to a NodeDefinition, handling union targets
 * by merging all member nodes' properties and relationships.
 *
 * Results are memoized per (schema identity + target) to avoid repeated
 * O(members × properties) merges for the same union type.
 */
export function resolveTargetDef(
  target: string,
  schema: SchemaMetadata,
): NodeDefinition | null {
  const direct = schema.nodes.get(target);
  if (direct) return direct;

  const cache = schemaResolveCache(schema);
  const cached = cache.get(target);
  if (cached !== undefined) return cached;

  // Check interfaces — build a NodeDefinition from the interface definition
  const interfaceDef = schema.interfaces?.get(target);
  if (interfaceDef) {
    const result: NodeDefinition = {
      typeName: interfaceDef.name,
      label: interfaceDef.label,
      labels: [interfaceDef.label],
      pluralName: interfaceDef.name.toLowerCase() + 's',
      properties: interfaceDef.properties,
      relationships: interfaceDef.relationships,
      fulltextIndexes: [],
      implementsInterfaces: [],
    };
    cache.set(target, result);
    return result;
  }

  const unionMembers = schema.unions?.get(target);
  if (!unionMembers || unionMembers.length === 0) {
    cache.set(target, null);
    return null;
  }

  const mergedProperties = new Map<
    string,
    NodeDefinition['properties'] extends Map<string, infer V> ? V : never
  >();
  const mergedRelationships = new Map<string, RelationshipDefinition>();

  for (const memberName of unionMembers) {
    const memberDef = schema.nodes.get(memberName);
    if (!memberDef) continue;
    for (const [k, v] of memberDef.properties)
      if (!mergedProperties.has(k)) mergedProperties.set(k, v);
    for (const [k, v] of memberDef.relationships)
      if (!mergedRelationships.has(k)) mergedRelationships.set(k, v);
  }

  const result: NodeDefinition = {
    typeName: target,
    label: target,
    labels: [target],
    pluralName: target.toLowerCase() + 's',
    properties: mergedProperties,
    relationships: mergedRelationships,
    fulltextIndexes: [],
    implementsInterfaces: [],
  };

  cache.set(target, result);
  return result;
}

/**
 * Compute the validated label string for a NodeDefinition.
 * Deduplicates labels, validates each, and joins with ':'.
 *
 * Callers that need caching should maintain their own cache (e.g., per MutationCompiler instance)
 * to avoid cross-test pollution from module-level state.
 */
export function getTargetLabelString(nodeDef: NodeDefinition): string {
  const allLabels = [...new Set([nodeDef.label, ...nodeDef.labels])].map((l) =>
    assertSafeLabel(l),
  );
  return allLabels.join(':');
}

/**
 * Options for building a Cypher relationship pattern.
 */
export interface BuildRelPatternOptions {
  /** Cypher variable for the source node (e.g. `'n'`) */
  sourceVar: string;
  /** Relationship definition from the schema */
  relDef: RelationshipDefinition;
  /** Cypher variable for the target node (e.g. `'n0'`). Empty string omits the var. */
  targetVar: string;
  /** Optional edge variable to bind the relationship (e.g. `'e0'`). Omit for anonymous `[:TYPE]`. */
  edgeVar?: string;
  /**
   * Target label strategy:
   * - `'auto'` — use `relDef.target` escaped as a label (v2.11.0: its
   *   strict `@node(labels)` when `schema` is passed)
   * - a string — validated and escaped via assertSafeLabel
   * - `undefined` / omit — no label on the target node
   */
  targetLabel?: string | 'auto';
  /**
   * Pre-escaped target label string (e.g. from `getTargetLabelString`).
   * Bypasses validation — used when the caller already composed a multi-label
   * string like `` `Type`:`Label` ``. Takes precedence over `targetLabel`.
   */
  targetLabelRaw?: string;
  /**
   * When true, checks if `relDef.target` is an abstract type (union/interface)
   * and omits the target label. Requires `schema` to be passed.
   */
  schema?: SchemaMetadata;
  /**
   * v2.7.0 — match the relationship in either direction (`(a)-[:T]-(b)`),
   * for a `<rel>Aggregate(directed: false)` selection. Omitted: the
   * relationship's declared direction, as before.
   */
  undirected?: boolean;
}

/**
 * Build a Cypher relationship pattern string from a RelationshipDefinition.
 * Shared across SelectionCompiler, WhereCompiler, and MutationCompiler.
 *
 * Examples:
 *   `(n)-[:HAS]->(n0:Book)`
 *   `(n)<-[e0:WRITTEN_BY]-(n0)`
 */
export function buildRelPattern(opts: BuildRelPatternOptions): string {
  assertSafeIdentifier(opts.relDef.type, 'relationship type');

  const escapedType = escapeIdentifier(opts.relDef.type);
  const relPart = opts.edgeVar
    ? `[${opts.edgeVar}:${escapedType}]`
    : `[:${escapedType}]`;

  let targetPart: string;
  if (opts.targetLabelRaw)
    // Pre-escaped label string — use directly
    targetPart = opts.targetVar
      ? `(${opts.targetVar}:${opts.targetLabelRaw})`
      : `(:${opts.targetLabelRaw})`;
  else if (opts.targetLabel)
    if (
      opts.targetLabel === 'auto' &&
      opts.schema &&
      isAbstractTarget(opts.relDef.target, opts.schema)
    )
      targetPart = opts.targetVar ? `(${opts.targetVar})` : `()`;
    else {
      const rawLabel =
        opts.targetLabel === 'auto' ? opts.relDef.target : opts.targetLabel;
      // v2.11.0 — strict item 23: a target with custom `@node(labels)` is
      // matched by all of its upstream labels (validated at construction).
      const strictLabels =
        opts.targetLabel === 'auto'
          ? opts.schema?.nodes.get(rawLabel)?.strictLabels
          : undefined;
      const escapedLabel = strictLabels
        ? strictLabels.map((l) => escapeIdentifier(l)).join(':')
        : assertSafeLabel(rawLabel);
      targetPart = opts.targetVar
        ? `(${opts.targetVar}:${escapedLabel})`
        : `(:${escapedLabel})`;
    }
  else targetPart = opts.targetVar ? `(${opts.targetVar})` : `()`;

  const sourcePart = `(${opts.sourceVar})`;
  if (opts.undirected) return `${sourcePart}-${relPart}-${targetPart}`;
  if (opts.relDef.direction === 'IN')
    return `${sourcePart}<-${relPart}-${targetPart}`;

  return `${sourcePart}-${relPart}->${targetPart}`;
}

/**
 * Check if a target type name is a union or interface (not a concrete node).
 */
export function isAbstractTarget(
  target: string,
  schema: SchemaMetadata,
): boolean {
  if (schema.nodes.has(target)) return false;
  return !!(schema.unions?.has(target) || schema.interfaces?.has(target));
}
