/**
 * v2.10.1 — policies of the node types a RUNTIME label puts a node in.
 *
 * `create`, `createMany` and `upsert` take `labels`, and `setLabels` takes
 * `addLabels` / `removeLabels`: extra labels SET on (or REMOVEd from) the
 * node beside the model type's own. When such a label is one that a
 * declared node type carries, the node becomes — or stops being — a node
 * of THAT type, reachable through that type's model. Pre-2.10.1 only the
 * label string was validated (`assertSafeLabel`) and only the ROOT model's
 * policies ran, so a context that could not create a `Secret` minted one
 * through `Public.create({ labels: ['Secret'] })` or `createMany`,
 * converted its own `Public` row into one with `setLabels`, and exposed a
 * `Secret` it could update but not read by adding the unprotected `Public`
 * label to it.
 *
 * The rule follows the nested-write principle — a write enforces exactly
 * what the equivalent direct write on the target type would:
 *
 * - **Adding a declared type's label is a `create` on that type.** At
 *   least one of its `create` permissives must apply (default deny) and
 *   its `create` WITH CHECK restrictives must accept the input the call
 *   carries for the node: the create input (`create`, each `createMany`
 *   item, upsert's `create` — and its `update`, for the existing node a
 *   default-mode upsert relabels). `setLabels` carries no properties, so
 *   its WITH CHECK runs with `{}`; a restrictive that inspects the input
 *   therefore rejects the relabel, which must then go through `create`.
 * - **Relabelling an EXISTING node into a declared type also requires the
 *   root type's `read` row filter**, beside the `update` filter it already
 *   requires: the node becomes reachable through another type's model, so
 *   the context must be able to see it through this one. (Model side —
 *   `setLabels`, and the matched-node guard of a default-mode `upsert` /
 *   `createMany({ skipDuplicates })`.)
 * - **Removing a declared type's label is a `delete` on that type.** The
 *   node must pass that type's `delete` row filter (model side:
 *   `(NOT n:<type labels> OR <delete clause>)`, the root's clause as is).
 *
 * Labels that no declared type carries (ad-hoc multi-label tagging) are
 * unaffected. So is an OGM without policies, or a bypass: `bundle` is then
 * `null`, nothing here runs, and the Cypher stays byte-identical.
 */
import type { NodeDefinition, SchemaMetadata } from '../schema/types';
import { PolicyDeniedError } from './errors';
import { evaluateCreatePolicies, targetBundle } from './nested-writes';
import type { PolicyContextBundle } from './types';

/** The call a runtime label was passed to, for error details. */
export type LabelCall = 'create' | 'createMany' | 'upsert' | 'setLabels';

/**
 * Every label a type's nodes carry — the primary plus `@node(labels)` —
 * i.e. the set its `MATCH (n:…)` pattern binds (`getTargetLabelString`).
 */
function declaredLabels(def: NodeDefinition): string[] {
  return [...new Set([def.label, ...def.labels])];
}

/**
 * The declared node types, other than `rootDef`, that a node of the root
 * type belongs to once it also carries `labels`.
 *
 * Labels the root type itself carries are ignored (the node has them
 * already). A type counts when it declares one of the remaining labels.
 * For a node this call CREATES (`freshNode`) the final label set is known
 * — the root's plus `labels` — so the type must be fully covered by it; an
 * EXISTING node may carry further labels, so any shared label counts
 * (conservative — a type's policy is never skipped).
 */
export function addedLabelTypes(
  schema: SchemaMetadata,
  rootDef: NodeDefinition,
  labels: ReadonlyArray<string> | undefined,
  freshNode: boolean,
): NodeDefinition[] {
  if (!labels || labels.length === 0) return [];
  const own = declaredLabels(rootDef);
  const added = labels.filter((l) => !own.includes(l));
  if (added.length === 0) return [];
  const carried = new Set([...own, ...added]);
  const out: NodeDefinition[] = [];
  for (const def of schema.nodes.values()) {
    if (def.typeName === rootDef.typeName) continue;
    const typeLabels = declaredLabels(def);
    if (!typeLabels.some((l) => added.includes(l))) continue;
    if (freshNode && !typeLabels.every((l) => carried.has(l))) continue;
    out.push(def);
  }
  return out;
}

/**
 * The declared node types — the root included — that a node leaves when
 * `labels` are REMOVEd from it: every type that declares one of them.
 */
export function removedLabelTypes(
  schema: SchemaMetadata,
  labels: ReadonlyArray<string> | undefined,
): NodeDefinition[] {
  if (!labels || labels.length === 0) return [];
  const out: NodeDefinition[] = [];
  for (const def of schema.nodes.values())
    if (declaredLabels(def).some((l) => labels.includes(l))) out.push(def);
  return out;
}

/**
 * Enforce the `create` policies of every type in `targets` on `inputs`,
 * exactly as a direct `create` on that type does (`evaluateCreatePolicies`:
 * default deny, then WITH CHECK on each input). Runs BEFORE compile, so a
 * denied relabel never reaches the database. Returns the names of the
 * policies that applied, for the call's audit metadata. No-op without a
 * bundle (no policies bound, or a bypass).
 */
export function evaluateLabelCreatePolicies(
  bundle: PolicyContextBundle | null,
  rootDef: NodeDefinition,
  targets: ReadonlyArray<NodeDefinition>,
  inputs: ReadonlyArray<Record<string, unknown>>,
  call: LabelCall,
): string[] {
  if (!bundle || targets.length === 0) return [];
  const evaluated: string[] = [];
  for (const target of targets) {
    const targetContext = targetBundle(bundle, target.typeName, 'create');
    try {
      evaluateCreatePolicies(targetContext, target.typeName, inputs);
    } catch (e) {
      if (!(e instanceof PolicyDeniedError)) throw e;
      throw new PolicyDeniedError({
        typeName: e.typeName,
        operation: e.operation,
        reason: e.reason,
        policyName: e.policyName,
        detail:
          `a runtime label passed to ${rootDef.typeName}.${call} makes the node a ${target.typeName}, ` +
          `so its create policies apply` +
          (call === 'setLabels'
            ? '; setLabels carries no properties, so WITH CHECK ran with an empty input'
            : ''),
      });
    }
    evaluated.push(...targetContext.resolved.evaluated);
  }
  return evaluated;
}
