/**
 * Application-layer policy checks for create / update input (v2.3.0),
 * shared by the ROOT write and every NESTED write reached through its
 * relationships. A nested write enforces exactly what the equivalent
 * direct write on the target type would:
 *
 * - nested `create` → the target's `create` permissives (default-deny)
 *   and write restrictives (WITH CHECK) on the node input, as
 *   `Model.create` does;
 * - nested `update` → the target's `update` write restrictives on the
 *   node input, as `Model.update` does. Its row filter (and
 *   `onDeny: 'throw'`) is enforced in the compiled MATCH by the
 *   mutation compiler.
 *
 * Pre-2.3.0 only the root type was checked, so a nested `create` / `update`
 * wrote into protected types with none of their write policies applied.
 *
 * Runs BEFORE compile, so a rejected nested write never reaches the
 * database. The walk mirrors the mutation compiler's input shapes:
 * relationship → `{ create, update, … }` (single item or array), union
 * targets keyed by member name, `create` items as `{ node, edge }` or a
 * bare node, `update` as `{ node, edge }` or a bare node. Interface
 * targets are skipped, as they are by the compiler (it emits no nested
 * create / update for them).
 */
import { OGMError } from '../errors';
import type {
  NodeDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../schema/types';
import { isPlainObject } from '../utils/validation';
import { PolicyDeniedError } from './errors';
import {
  isWriteRestrictive,
  NO_ROOT_POLICY,
  type Operation,
  type PolicyContextBundle,
} from './types';

/** Guards against pathological (e.g. cyclic) input objects. */
const MAX_NESTED_WRITE_DEPTH = 32;

/**
 * Evaluate `'create'` policies in JS for `inputs` of `typeName`.
 *
 * - Override → all input is allowed.
 * - Permissive → at least one (whose `appliesWhen` matches) must exist;
 *   create cannot fall back to default-deny silent-empty.
 * - Restrictive → `when(ctx, input)` must return exactly `true` for every
 *   input (v1.8.7 — explicit positive consent).
 *
 * A permissive's `when(ctx)` where-partial is a SHAPE hint only — it is
 * not compiled against the input. Restrictive `when(ctx, input)` is the
 * canonical "WITH CHECK" hook.
 */
export function evaluateCreatePolicies(
  bundle: PolicyContextBundle | null,
  typeName: string,
  inputs: ReadonlyArray<Record<string, unknown>>,
): void {
  if (!bundle || bundle.resolved.overridden) return;

  if (bundle.resolved.permissives.length === 0)
    throw new PolicyDeniedError({
      typeName,
      operation: 'create',
      reason: 'no-permissive-matched',
      ...(bundle.defaults.onDeny === 'throw'
        ? {}
        : {
            detail:
              'create operations cannot rely on default-deny silent-empty; at least one permissive must apply.',
          }),
    });

  for (const input of inputs)
    evaluateWriteRestrictives(bundle, typeName, 'create', input);
}

/**
 * Evaluate WRITE-side restrictives (create/update) at the application
 * layer. Each `WriteRestrictive` is invoked once with `(ctx, input)`;
 * anything but an explicit `true` rejects with `PolicyDeniedError`.
 * ReadRestrictives are not consumed here — they filter rows via the
 * compiled WHERE clause.
 */
export function evaluateWriteRestrictives(
  bundle: PolicyContextBundle | null,
  typeName: string,
  operation: Operation,
  input: Record<string, unknown> | undefined,
): void {
  if (!bundle || bundle.resolved.overridden) return;
  for (const r of bundle.resolved.restrictives) {
    if (!isWriteRestrictive(r)) continue;
    // Compile-time gate: `appliesWhen` returning false drops the policy.
    if (r.appliesWhen && !r.appliesWhen(bundle.ctx)) continue;
    if (r.when(bundle.ctx, input ?? {}) !== true)
      throw new PolicyDeniedError({
        typeName,
        operation,
        reason: 'restrictive-rejected-input',
        policyName: r.name,
      });
  }
}

/**
 * Check every nested `create` / `update` inside create inputs of
 * `nodeDef` (the root's own checks are the caller's).
 */
export function assertNestedCreatesAllowed(
  schema: SchemaMetadata,
  nodeDef: NodeDefinition,
  inputs: ReadonlyArray<Record<string, unknown>>,
  bundle: PolicyContextBundle | null,
): void {
  if (!bundle) return;
  for (const input of inputs)
    if (isPlainObject(input)) walkCreate(schema, nodeDef, input, bundle, 0);
}

/**
 * Check every nested `create` / `update` inside an update input of
 * `nodeDef` (the root's own checks are the caller's).
 */
export function assertNestedUpdatesAllowed(
  schema: SchemaMetadata,
  nodeDef: NodeDefinition,
  update: Record<string, unknown> | undefined,
  bundle: PolicyContextBundle | null,
): void {
  if (!bundle || !isPlainObject(update)) return;
  walkUpdate(schema, nodeDef, update, bundle, 0);
}

/** A create node spec: its relationship keys may carry nested creates. */
function walkCreate(
  schema: SchemaMetadata,
  nodeDef: NodeDefinition,
  nodeSpec: Record<string, unknown>,
  bundle: PolicyContextBundle,
  depth: number,
): void {
  assertDepth(depth);
  for (const [key, value] of Object.entries(nodeSpec)) {
    const relDef = nodeDef.relationships.get(key);
    if (!relDef || !isPlainObject(value)) continue;
    for (const [targetDef, relInput] of relationshipTargets(
      schema,
      relDef,
      value,
    ))
      if (isPlainObject(relInput))
        checkCreates(schema, targetDef, relInput.create, bundle, depth);
  }
}

/** An update spec: its relationship keys carry nested operation items. */
function walkUpdate(
  schema: SchemaMetadata,
  nodeDef: NodeDefinition,
  update: Record<string, unknown>,
  bundle: PolicyContextBundle,
  depth: number,
): void {
  assertDepth(depth);
  for (const [key, value] of Object.entries(update)) {
    const relDef = nodeDef.relationships.get(key);
    if (!relDef || value == null) continue;
    for (const [targetDef, items] of relationshipTargets(schema, relDef, value))
      for (const item of asArray(items)) {
        if (!isPlainObject(item)) continue;
        if (item.create)
          checkCreates(schema, targetDef, item.create, bundle, depth);
        if (isPlainObject(item.update)) {
          // Same node-spec resolution as the compiler's nested update.
          const spec = item.update;
          const nodeUpdate = (spec.node ?? (spec.edge ? {} : spec)) as Record<
            string,
            unknown
          >;
          evaluateWriteRestrictives(
            targetBundle(bundle, targetDef.typeName, 'update'),
            targetDef.typeName,
            'update',
            nodeUpdate,
          );
          if (isPlainObject(nodeUpdate))
            walkUpdate(schema, targetDef, nodeUpdate, bundle, depth + 1);
        }
      }
  }
}

function checkCreates(
  schema: SchemaMetadata,
  targetDef: NodeDefinition,
  creates: unknown,
  bundle: PolicyContextBundle,
  depth: number,
): void {
  for (const item of asArray(creates)) {
    if (!isPlainObject(item)) continue;
    // Same node-spec resolution as the compiler's nested create.
    const nodeSpec = (item.node ?? item) as Record<string, unknown>;
    evaluateCreatePolicies(
      targetBundle(bundle, targetDef.typeName, 'create'),
      targetDef.typeName,
      [nodeSpec],
    );
    if (isPlainObject(nodeSpec))
      walkCreate(schema, targetDef, nodeSpec, bundle, depth + 1);
  }
}

/**
 * Concrete targets of a relationship paired with their slice of the
 * input: the whole value for a node target, one entry per member key
 * for a union target, none for an interface target.
 */
function relationshipTargets(
  schema: SchemaMetadata,
  relDef: RelationshipDefinition,
  value: unknown,
): [NodeDefinition, unknown][] {
  const nodeDef = schema.nodes.get(relDef.target);
  if (nodeDef) return [[nodeDef, value]];
  const members = schema.unions?.get(relDef.target);
  if (!members || !isPlainObject(value)) return [];
  const targets: [NodeDefinition, unknown][] = [];
  for (const [memberKey, memberValue] of Object.entries(value)) {
    const memberDef = members.includes(memberKey)
      ? schema.nodes.get(memberKey)
      : undefined;
    if (memberDef && memberValue != null)
      targets.push([memberDef, memberValue]);
  }
  return targets;
}

/** The target type's bundle for `op`; a type without policies is open. */
function targetBundle(
  bundle: PolicyContextBundle,
  typeName: string,
  op: Operation,
): PolicyContextBundle {
  return {
    ...bundle,
    operation: op,
    resolved: bundle.resolveForType(typeName, op) ?? NO_ROOT_POLICY,
  };
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function assertDepth(depth: number): void {
  if (depth > MAX_NESTED_WRITE_DEPTH)
    throw new OGMError(
      `Nested write input exceeds the maximum depth of ${MAX_NESTED_WRITE_DEPTH}.`,
    );
}
