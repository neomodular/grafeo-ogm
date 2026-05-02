import { createHash } from 'crypto';
import type { SchemaMetadata } from '../schema/types';
import type {
  Operation,
  OperationOrWildcard,
  PermissivePolicy,
  Policy,
  PolicyContext,
  ResolvedPolicies,
  RestrictivePolicy,
} from './types';

/**
 * Build an immutable resolver from a registry. The registry is built by
 * the OGM constructor after schema validation.
 *
 * The resolver is the single place where "which policies fire for this
 * (type, op, ctx)" is decided. Both compilers and the model wrappers use
 * the same resolver instance, so behavior stays consistent.
 */
export class PolicyResolver<C extends PolicyContext = PolicyContext> {
  private readonly registry: ReadonlyMap<string, ReadonlyArray<Policy<C>>>;
  private readonly schema: SchemaMetadata;

  constructor(
    registry: ReadonlyMap<string, ReadonlyArray<Policy<C>>>,
    schema: SchemaMetadata,
  ) {
    this.registry = registry;
    this.schema = schema;
  }

  /** Whether ANY policies are configured. Used to skip work in non-policy paths. */
  hasAny(): boolean {
    return this.registry.size > 0;
  }

  /**
   * Resolve the policy set for `(typeName, op, ctx)`. Considers both the
   * concrete type's own policies AND inherited interface policies (per
   * v1.7.0 inheritance rule: AND-restrictive, OR-permissive).
   *
   * Returns `null` when no policies are registered anywhere applicable
   * to this type (so call sites can short-circuit and emit byte-
   * identical Cypher).
   */
  resolve(typeName: string, op: Operation, ctx: C): ResolvedPolicies<C> | null {
    const sources = this.gatherSources(typeName);
    if (sources.length === 0) return null;

    const matching: Policy<C>[] = [];
    for (const list of sources)
      for (const p of list)
        if (operationMatches(p.operations, op)) matching.push(p);

    if (matching.length === 0) return null;

    // Override short-circuit. First matching override whose `when` returns
    // true wins — emit nothing.
    for (const p of matching)
      if (p.kind === 'override' && p.when(ctx))
        return {
          overridden: true,
          permissives: [],
          restrictives: [],
          evaluated: [p.name ?? 'override'],
        };

    const permissives: PermissivePolicy<C>[] = [];
    const restrictives: RestrictivePolicy<C>[] = [];
    const evaluated: string[] = [];

    for (const p of matching)
      if (p.kind === 'permissive') {
        // appliesWhen is compile-time. False → drop policy entirely.
        if (p.appliesWhen && !p.appliesWhen(ctx)) continue;
        permissives.push(p);
        evaluated.push(p.name ?? 'permissive');
      } else if (p.kind === 'restrictive') {
        restrictives.push(p);
        evaluated.push(p.name ?? 'restrictive');
      }

    return {
      overridden: false,
      permissives,
      restrictives,
      evaluated,
    };
  }

  /**
   * Gather all sources of policy that apply to a given concrete type:
   * the type's own list, plus any interfaces it implements.
   */
  private gatherSources(
    typeName: string,
  ): ReadonlyArray<ReadonlyArray<Policy<C>>> {
    const out: ReadonlyArray<Policy<C>>[] = [];
    const own = this.registry.get(typeName);
    if (own) out.push(own);

    const nodeDef = this.schema.nodes.get(typeName);
    if (nodeDef)
      for (const ifaceName of nodeDef.implementsInterfaces) {
        const ifacePolicies = this.registry.get(ifaceName);
        if (ifacePolicies) out.push(ifacePolicies);
      }

    return out;
  }
}

function operationMatches(
  operations: ReadonlyArray<OperationOrWildcard>,
  op: Operation,
): boolean {
  for (const candidate of operations)
    if (candidate === '*' || candidate === op) return true;
  return false;
}

/**
 * Stable, value-free fingerprint of a context object. Used in audit
 * metadata so query logs can be correlated by ctx-shape WITHOUT leaking
 * any sensitive ctx values. Hashes the SORTED key list only.
 *
 * Truncated to 16 hex chars — collision resistance is not the goal here.
 * Documented as NOT a security primitive.
 */
export function hashCtx(ctx: PolicyContext | undefined): string {
  if (!ctx || typeof ctx !== 'object') return 'empty';
  const keys = Object.keys(ctx).sort();
  const json = JSON.stringify(keys);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}
