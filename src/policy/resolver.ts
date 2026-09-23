import { createHash } from 'crypto';
import type { SchemaMetadata } from '../schema/types';
import type {
  DetailedPolicy,
  DetailedResolution,
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
    const detailed = this.resolveDetailed(typeName, op, ctx);
    return detailed ? projectResolution(detailed) : null;
  }

  /**
   * Resolve every operation-matching policy for `(typeName, op, ctx)`
   * WITHOUT dropping any: `applied` records the `appliesWhen(ctx)` gate
   * (or, for overrides, `when(ctx)`), and `skipped` marks policies never
   * evaluated because an earlier override fired. This is the single place
   * the resolver invokes `appliesWhen`; `resolve()` projects from it.
   *
   * Callback invocation order is unchanged from the pre-explain resolver:
   * override `when` callbacks first (stopping at the first that fires),
   * then `appliesWhen` in registration order — skipped entirely when an
   * override fired.
   *
   * Returns `null` exactly when `resolve()` does.
   */
  resolveDetailed(
    typeName: string,
    op: Operation,
    ctx: C,
  ): DetailedResolution<C> | null {
    const sources = this.gatherSources(typeName);
    if (sources.length === 0) return null;

    const matching: Array<{
      policy: Policy<C>;
      source: string;
      index: number;
    }> = [];
    for (const { source, policies } of sources)
      policies.forEach((policy, index) => {
        if (operationMatches(policy.operations, op))
          matching.push({ policy, source, index });
      });

    if (matching.length === 0) return null;

    // Override short-circuit. First matching override whose `when` returns
    // true wins — nothing after it is evaluated.
    let firing = -1;
    for (let i = 0; i < matching.length; i++) {
      const p = matching[i].policy;
      if (p.kind === 'override' && p.when(ctx)) {
        firing = i;
        break;
      }
    }

    const entries: DetailedPolicy<C>[] = matching.map(
      ({ policy, source, index }, i) => {
        const named = Boolean(policy.name);
        const name = named
          ? (policy.name as string)
          : `${source}.${policy.kind}[${index}]`;
        const base = { policy, kind: policy.kind, source, index, name, named };

        if (firing >= 0) {
          if (i === firing) return { ...base, applied: true, skipped: false };
          // Overrides before the firing one WERE evaluated (to false).
          if (policy.kind === 'override' && i < firing)
            return { ...base, applied: false, skipped: false };
          return { ...base, applied: false, skipped: true };
        }

        if (policy.kind === 'override')
          return { ...base, applied: false, skipped: false };

        const applied = !policy.appliesWhen || policy.appliesWhen(ctx);
        return { ...base, applied, skipped: false };
      },
    );

    return {
      overriddenBy: firing >= 0 ? entries[firing].name : null,
      entries,
    };
  }

  /**
   * Gather all sources of policy that apply to a given concrete type:
   * the type's own list, plus any interfaces it implements — each tagged
   * with the registry key that declared it.
   */
  private gatherSources(
    typeName: string,
  ): ReadonlyArray<{ source: string; policies: ReadonlyArray<Policy<C>> }> {
    const out: { source: string; policies: ReadonlyArray<Policy<C>> }[] = [];
    const own = this.registry.get(typeName);
    if (own) out.push({ source: typeName, policies: own });

    const nodeDef = this.schema.nodes.get(typeName);
    if (nodeDef)
      for (const ifaceName of nodeDef.implementsInterfaces) {
        const ifacePolicies = this.registry.get(ifaceName);
        if (ifacePolicies)
          out.push({ source: ifaceName, policies: ifacePolicies });
      }

    return out;
  }
}

/**
 * Project a detailed resolution onto the `ResolvedPolicies` shape the
 * compilers consume. `PolicyResolver.resolve()` is exactly
 * `projectResolution(resolveDetailed(...))`; the explain path calls it on
 * the SAME detailed object it reports on, so the compiled fragments stay
 * positionally aligned with the reported entries.
 */
export function projectResolution<C extends PolicyContext>(
  detailed: DetailedResolution<C>,
): ResolvedPolicies<C> {
  if (detailed.overriddenBy !== null) {
    const firing = detailed.entries.find(
      (e) => e.policy.kind === 'override' && e.applied,
    )!;
    return {
      overridden: true,
      permissives: [],
      restrictives: [],
      evaluated: [firing.policy.name ?? 'override'],
    };
  }

  const permissives: PermissivePolicy<C>[] = [];
  const restrictives: RestrictivePolicy<C>[] = [];
  const evaluated: string[] = [];

  for (const { policy: p, applied } of detailed.entries)
    if (p.kind === 'permissive') {
      // appliesWhen is compile-time. False → drop policy entirely.
      if (!applied) continue;
      permissives.push(p);
      evaluated.push(p.name ?? 'permissive');
    } else if (p.kind === 'restrictive') {
      // Restrictives are kept even when `appliesWhen(ctx)` is false —
      // the compiler / `evaluateWriteRestrictives` enforce the gate
      // downstream. Dropping them here would change what
      // `InterfaceModel.compileInterfacePolicyClause` sees: an
      // implementer left with no permissives AND no restrictives is
      // treated as unconstrained (`THEN true`) instead of default-deny.
      restrictives.push(p);
      // Audit metadata lists only policies that actually applied.
      if (applied) evaluated.push(p.name ?? 'restrictive');
    }

  return {
    overridden: false,
    permissives,
    restrictives,
    evaluated,
  };
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
