import type {
  NodeDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from './types';
import { assertSafeLabel } from '../utils/validation';

/**
 * Module-level cache for resolved union/interface target definitions.
 * Bounded by the number of unique type names in the schema (~50-100 entries).
 * Use `clearResolveTargetDefCache()` to reset (e.g., between tests).
 */
const resolveTargetDefCache = new Map<string, NodeDefinition | null>();

/**
 * Clear the module-level resolve cache.
 * Useful in tests to prevent cross-test state pollution.
 */
export function clearResolveTargetDefCache(): void {
  resolveTargetDefCache.clear();
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

  const cached = resolveTargetDefCache.get(target);
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
    resolveTargetDefCache.set(target, result);
    return result;
  }

  const unionMembers = schema.unions?.get(target);
  if (!unionMembers || unionMembers.length === 0) {
    resolveTargetDefCache.set(target, null);
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

  resolveTargetDefCache.set(target, result);
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
