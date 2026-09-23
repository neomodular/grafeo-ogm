/**
 * Pure helpers behind `Model.explainPolicies()` (GitHub issue #6).
 *
 * The explain path never re-derives a policy predicate. It consumes the
 * fragments `WhereCompiler.compileForExplain` produced for enforcement,
 * projects one boolean per applied policy, and cross-checks the verdict
 * implied by those outcomes against the literal enforcement predicate.
 */

import {
  policyValueExpression,
  type CompiledPolicyFragments,
} from '../compilers/where.compiler';
import { OGMError } from '../errors';
import type {
  DetailedPolicy,
  DetailedResolution,
  PolicyClauseExplanation,
  PolicyClauseOutcome,
  PolicyExplanation,
} from './types';

/** Default candidate cap for one `explainPolicies` call. */
export const EXPLAIN_DEFAULT_LIMIT = 100;
/** Hard candidate cap — explain evaluates every policy per candidate. */
export const EXPLAIN_MAX_LIMIT = 1_000;
/** Cypher variable holding the per-policy outcome list. */
export const EXPLAIN_OUTCOMES = '__explain_outcomes';
/** Cypher variable holding the literal enforcement verdict. */
export const EXPLAIN_VISIBLE = '__explain_visible';

/**
 * Validate `options.limit` for an explain call: default 100, reject
 * anything above 1,000 instead of silently clamping (a diagnostic must
 * not quietly drop the candidate an operator asked about).
 */
export function resolveExplainLimit(limit: number | undefined): number {
  if (limit == null) return EXPLAIN_DEFAULT_LIMIT;
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n < 0)
    throw new OGMError('limit must be a non-negative integer');
  if (n > EXPLAIN_MAX_LIMIT)
    throw new OGMError(
      `explainPolicies: limit ${n} exceeds the maximum of ${EXPLAIN_MAX_LIMIT} candidates per call. Narrow the candidate \`where\` instead.`,
    );
  return n;
}

/** How one reported policy's outcome is determined for every candidate. */
type ExplainSlot =
  | { readonly entry: DetailedPolicy; readonly projected: number }
  | { readonly entry: DetailedPolicy; readonly fixed: PolicyClauseOutcome };

export interface ExplainPlan {
  /** Cypher boolean expressions projected as `__explain_outcomes`. */
  readonly outcomeExpressions: ReadonlyArray<string>;
  /** One slot per reported policy, in registration order. */
  readonly slots: ReadonlyArray<ExplainSlot>;
  readonly overriddenBy: string | null;
  /** No policy is registered for the type — reads are unconstrained. */
  readonly unrestricted: boolean;
}

function internalError(message: string): OGMError {
  return new OGMError(
    `explainPolicies: ${message}. No explanation was returned — please report this as a grafeo-ogm bug.`,
  );
}

/**
 * Pair each detailed policy with its compiled fragments and decide which
 * outcomes need a per-row projection. `fragments` must come from compiling
 * `projectResolution(detailed)` — the SAME detailed object — so the
 * positional alignment below holds; it is verified by identity anyway.
 */
export function buildExplainPlan(
  detailed: DetailedResolution | null,
  fragments: CompiledPolicyFragments | null,
): ExplainPlan {
  if (!detailed)
    return {
      outcomeExpressions: [],
      slots: [],
      overriddenBy: null,
      unrestricted: true,
    };

  // An override fired: enforcement emits no predicate, nothing to project.
  if (detailed.overriddenBy !== null)
    return {
      outcomeExpressions: [],
      slots: detailed.entries.map((entry) => ({
        entry,
        fixed: entry.applied
          ? 'pass'
          : entry.skipped
            ? 'skipped'
            : 'not-applied',
      })),
      overriddenBy: detailed.overriddenBy,
      unrestricted: false,
    };

  if (!fragments)
    throw internalError('policy fragments are missing for the resolution');

  const outcomeExpressions: string[] = [];
  const slots: ExplainSlot[] = [];
  let permIdx = 0;
  let restIdx = 0;

  for (const entry of detailed.entries) {
    const { policy } = entry;
    // No override fired, so every override evaluated to false.
    if (policy.kind === 'override') {
      slots.push({ entry, fixed: 'not-applied' });
      continue;
    }
    // Non-applying permissives are dropped by the resolver — never compiled.
    if (policy.kind === 'permissive' && !entry.applied) {
      slots.push({ entry, fixed: 'not-applied' });
      continue;
    }

    const compiled =
      policy.kind === 'permissive'
        ? fragments.permissives[permIdx++]
        : fragments.restrictives[restIdx++];
    if (!compiled || compiled.policy !== policy)
      throw internalError(
        `compiled fragments are misaligned with the resolution at policy "${entry.name}"`,
      );

    // Restrictives are compiled even when gated off (the compiler
    // re-checks `appliesWhen` and emits nothing). Parts here would mean
    // the two `appliesWhen` evaluations disagreed.
    if (!entry.applied) {
      if (compiled.parts.length > 0)
        throw new OGMError(
          `explainPolicies: appliesWhen of policy "${entry.name}" returned different results across evaluations for the same ctx. appliesWhen must be a pure function of ctx.`,
        );
      slots.push({ entry, fixed: 'not-applied' });
      continue;
    }

    const expr = policyValueExpression(policy.kind, compiled.parts);
    if (expr === null) {
      slots.push({ entry, fixed: 'abstain' });
      continue;
    }
    slots.push({ entry, projected: outcomeExpressions.length });
    outcomeExpressions.push(expr);
  }

  if (
    permIdx !== fragments.permissives.length ||
    restIdx !== fragments.restrictives.length
  )
    throw internalError(
      'compiled fragments are misaligned with the resolution (unconsumed fragments)',
    );

  return { outcomeExpressions, slots, overriddenBy: null, unrestricted: false };
}

function toOutcome(value: unknown, policyName: string): PolicyClauseOutcome {
  if (value === true) return 'pass';
  if (value === false) return 'fail';
  if (value === null || value === undefined) return 'null';
  throw new OGMError(
    `explainPolicies: policy "${policyName}" evaluated to a non-boolean value (${typeof value}). Policy predicates must be boolean expressions.`,
  );
}

/**
 * Turn one result row into its explanation and verify it. `rawVisible` is
 * the enforcement predicate's own value (`coalesce(<clause>, false)`); the
 * verdict recomputed from the per-policy outcomes MUST agree with it.
 * AND/OR are monotone in Cypher's three-valued logic, so reading NULL as
 * not-true at the leaves yields the same truth value as `coalesce` at the
 * root — any disagreement is an engine bug, never a valid explanation.
 */
export function interpretExplainRow(
  plan: ExplainPlan,
  rawOutcomes: unknown,
  rawVisible: unknown,
  typeName: string,
  row: number,
): Omit<PolicyExplanation<never>, 'node'> {
  if (
    !Array.isArray(rawOutcomes) ||
    rawOutcomes.length !== plan.outcomeExpressions.length
  )
    throw internalError(
      `row ${row} of type "${typeName}" returned ${Array.isArray(rawOutcomes) ? rawOutcomes.length : typeof rawOutcomes} policy outcomes, expected ${plan.outcomeExpressions.length}`,
    );

  const policies: PolicyClauseExplanation[] = plan.slots.map((slot) => ({
    name: slot.entry.name,
    named: slot.entry.named,
    kind: slot.entry.kind,
    source: slot.entry.source,
    applied: slot.entry.applied,
    outcome:
      'fixed' in slot
        ? slot.fixed
        : toOutcome(rawOutcomes[slot.projected], slot.entry.name),
  }));

  let visible: boolean;
  let permissiveGranted: boolean;
  if (plan.unrestricted || plan.overriddenBy !== null) {
    visible = true;
    permissiveGranted = true;
  } else {
    permissiveGranted = policies.some(
      (p) => p.kind === 'permissive' && p.outcome === 'pass',
    );
    const restrictivesHold = policies.every(
      (p) =>
        p.kind !== 'restrictive' ||
        !p.applied ||
        p.outcome === 'pass' ||
        p.outcome === 'abstain',
    );
    visible = permissiveGranted && restrictivesHold;
  }

  if (rawVisible !== visible)
    throw internalError(
      `consistency check failed for row ${row} of type "${typeName}": the enforcement predicate evaluated to ${String(rawVisible)} but the per-policy outcomes imply ${String(visible)}`,
    );

  return {
    visible,
    overriddenBy: plan.overriddenBy,
    permissiveGranted,
    failedRestrictives: policies
      .filter(
        (p) =>
          p.kind === 'restrictive' &&
          (p.outcome === 'fail' || p.outcome === 'null'),
      )
      .map((p) => p.name),
    policies,
  };
}
