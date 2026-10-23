/**
 * v2.12.3 — `count()` enforces the restrictives registered on `count`.
 *
 * `count` has been a policy operation since v1.7.0, but `Model.count` and
 * `InterfaceModel.count` resolve policies exactly as `aggregate` does: the
 * type's `aggregate` policies, falling back to its `read` policies. A
 * `restrictive({ operations: ['count'] })` matched neither, so in
 * 1.7.0–2.12.1 it was never enforced: a count that was meant to leave rows
 * out counted them.
 *
 * The fix can only make a count STRICTER, so it ships in default mode:
 *
 *   - the `aggregate` → `read` resolution is unchanged — it still decides
 *     the permissives, the override short-circuit, default-deny and the
 *     `onDeny: 'throw'` pre-check;
 *   - every restrictive that matches `count` and is not already part of
 *     that resolution is ANDed onto its clause. A restrictive that lists
 *     `count` beside the resolved operation (`['read', 'count']`) is already
 *     applied and is not added twice, so a policy set without a
 *     count-only restrictive compiles byte-identical Cypher. A firing
 *     override on the resolved operation lifts the whole count, as before,
 *     and an override that matches `count` lifts the `count` restrictives
 *     like any override lifts its operation's policies;
 *   - `count` PERMISSIVES grant nothing in 2.x, as before: honouring them
 *     would change what a count returns. `OGM` warns once per policy
 *     (`count-permissive-ignored`) instead.
 *
 * When the resolution has no clause of its own (no `aggregate` / `read`
 * policy on the type) the `count` restrictives are ANDed onto `true`
 * through a synthetic match-all permissive, so the count is the
 * unrestricted count minus the rows they exclude.
 */
import type {
  PermissivePolicy,
  PolicyContext,
  ResolvedPolicies,
  RestrictivePolicy,
} from './types';

/** Match-all grant the `count` restrictives are ANDed onto when the resolved operation has no clause. */
const COUNT_MATCH_ALL: PermissivePolicy = Object.freeze({
  kind: 'permissive',
  operations: Object.freeze(['count']),
  when: () => ({}),
  name: 'count.match-all',
}) as PermissivePolicy;

/**
 * The `count` restrictives `base` does not already apply: none when there is
 * no `count` policy, when an override matching `count` fired, or when a
 * firing override on the resolved operation lifts the whole count.
 */
function extraCountRestrictives(
  base: ResolvedPolicies | null,
  forCount: ResolvedPolicies | null,
): RestrictivePolicy[] {
  if (!forCount || forCount.overridden) return [];
  if (base?.overridden) return [];
  const applied: ReadonlyArray<RestrictivePolicy> = base?.restrictives ?? [];
  return forCount.restrictives.filter((r) => !applied.includes(r));
}

/**
 * Audit names of the restrictives that apply, as the resolver lists them
 * for the base resolution (`appliesWhen` is a pure function of ctx).
 */
function appliedNames(
  restrictives: ReadonlyArray<RestrictivePolicy>,
  ctx: PolicyContext,
): string[] {
  return restrictives
    .filter((r) => !r.appliesWhen || r.appliesWhen(ctx))
    .map((r) => r.name ?? 'restrictive');
}

/**
 * The resolution `count()` enforces: `base` (the type's `aggregate` → `read`
 * resolution, `null` when it has none) plus the restrictives of `forCount`
 * (the type's `count` resolution, `null` when it has none) that `base` does
 * not already apply. Returns `base` itself when nothing is added.
 */
export function applyCountRestrictives(
  base: ResolvedPolicies | null,
  forCount: ResolvedPolicies | null,
  ctx: PolicyContext,
): ResolvedPolicies | null {
  const extra = extraCountRestrictives(base, forCount);
  if (extra.length === 0) return base;
  // Already default-deny (`false`): the extra restrictives change nothing.
  if (base && base.permissives.length === 0) return base;

  const evaluated = appliedNames(extra, ctx);
  if (!base)
    return {
      overridden: false,
      permissives: [COUNT_MATCH_ALL],
      restrictives: extra,
      evaluated,
    };
  return {
    overridden: false,
    permissives: base.permissives,
    restrictives: [...base.restrictives, ...extra],
    evaluated: [...base.evaluated, ...evaluated],
  };
}
