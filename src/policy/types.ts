/**
 * Public types and constructors for the Node-Level Security (NLS) policy
 * layer introduced in v1.7.0. Policies are vocabulary-neutral building
 * blocks (`override`, `permissive`, `restrictive`); user codebases compose
 * role-aware sugar on top.
 */

import { OGMError } from '../errors';

/**
 * Generic policy context. Users extend this with their own typed shape
 * (e.g. `{ userId: string; capabilities: string[] }`). The OGM never
 * inspects ctx beyond passing it to policy callbacks.
 */
export type PolicyContext = Record<string, unknown>;

/**
 * Operations a policy can target. A query maps to exactly one operation.
 * The wildcard `'*'` matches every operation.
 */
export type Operation =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'aggregate'
  | 'count';

export type OperationOrWildcard = Operation | '*';

/**
 * Override — compile-time short-circuit. If `when(ctx)` returns true and
 * the operation matches, ALL other policies for this (type, operation)
 * are dropped. The compiled Cypher is byte-identical to a no-policy
 * query. Cannot reference node properties — only ctx.
 */
export interface OverridePolicy<C extends PolicyContext = PolicyContext> {
  readonly kind: 'override';
  readonly operations: ReadonlyArray<OperationOrWildcard>;
  readonly when: (ctx: C) => boolean;
  /** Optional debug name surfaced in audit metadata + logging. */
  readonly name?: string;
}

/**
 * Permissive — two-stage OR-grant. `appliesWhen(ctx)` is compile-time;
 * if false, the policy is dropped from this query (NOT compiled as
 * `false`). `when(ctx)` returns a `<Node>Where` partial that compiles
 * to a row predicate. Multiple permissives OR together — any match
 * grants access. The `cypher` escape hatch is for power users who
 * need raw fragments (with parameterized values).
 */
export interface PermissivePolicy<
  C extends PolicyContext = PolicyContext,
  W extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: 'permissive';
  readonly operations: ReadonlyArray<OperationOrWildcard>;
  readonly appliesWhen?: (ctx: C) => boolean;
  readonly when?: (ctx: C) => W;
  readonly cypher?: {
    fragment: (ctx: C, alias: { node: string }) => string;
    params: (ctx: C) => Record<string, unknown>;
  };
  readonly name?: string;
}

/**
 * Read-side operations a `ReadRestrictivePolicy` may target. These are
 * row-filter operations that compile to a `WHERE` clause; they have no
 * mutation input to validate.
 */
export type ReadOperation = 'read' | 'delete' | 'aggregate' | 'count';

/**
 * Write-side operations a `WriteRestrictivePolicy` may target. These run
 * at the application layer ("WITH CHECK" semantics) and inspect the
 * input bag the user is creating/updating.
 *
 * Note: `update` is a write-side op for restrictives because the
 * restrictive's purpose is to validate the new values. The WHERE-side
 * row filter for `update` queries is enforced via `ReadRestrictive`
 * policies registered on `'read'` (or via permissive policies).
 */
export type WriteOperation = 'create' | 'update';

/**
 * Read-side restrictive — AND-row predicate compiled into the `WHERE`
 * clause. `when(ctx)` returns a `<Node>Where` partial OR `false` for
 * a hard deny. Cannot reference mutation input (there is none on a
 * read).
 */
export interface ReadRestrictivePolicy<
  C extends PolicyContext = PolicyContext,
  W extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: 'restrictive';
  readonly operations: ReadonlyArray<ReadOperation>;
  /** Optional compile-time gate. Like `appliesWhen` on permissive. */
  readonly appliesWhen?: (ctx: C) => boolean;
  readonly when?: (ctx: C) => W | boolean;
  readonly cypher?: {
    fragment: (ctx: C, alias: { node: string }) => string;
    params: (ctx: C) => Record<string, unknown>;
  };
  readonly name?: string;
}

/**
 * Write-side restrictive — application-layer "WITH CHECK" predicate.
 * `when(ctx, input)` runs once per write op (create/update) with the
 * exact input bag the user submitted. Returning `false` rejects the
 * operation with `PolicyDeniedError`. The `cypher` escape hatch is NOT
 * supported for write restrictives because there is no compiled WHERE
 * clause to AND-stitch into.
 *
 * `when` MUST return a boolean; returning a where-partial would
 * conflate WITH CHECK semantics with row-filter semantics. Use a
 * `ReadRestrictive` if you need a row filter on update/delete query
 * targets.
 */
export interface WriteRestrictivePolicy<
  C extends PolicyContext = PolicyContext,
  I extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: 'restrictive';
  readonly operations: ReadonlyArray<WriteOperation>;
  /** Optional compile-time gate. Skips evaluation entirely when false. */
  readonly appliesWhen?: (ctx: C) => boolean;
  readonly when: (ctx: C, input: I) => boolean;
  readonly name?: string;
}

/**
 * Discriminated union over the two restrictive flavors. The `operations`
 * array is the discriminant: read-side ops (`read|delete|aggregate|count`)
 * select `ReadRestrictivePolicy`; write-side ops (`create|update`) select
 * `WriteRestrictivePolicy`. Mixed-operation arrays are rejected at
 * construction time — split them into two separate restrictives.
 *
 * The `restrictive()` constructor enforces the discriminant with
 * function overloads, so authoring code gets the correct `when`
 * signature inferred from the literal `operations` tuple.
 */
export type RestrictivePolicy<
  C extends PolicyContext = PolicyContext,
  W extends Record<string, unknown> = Record<string, unknown>,
  I extends Record<string, unknown> = Record<string, unknown>,
> = ReadRestrictivePolicy<C, W> | WriteRestrictivePolicy<C, I>;

export type Policy<C extends PolicyContext = PolicyContext> =
  | OverridePolicy<C>
  | PermissivePolicy<C>
  | RestrictivePolicy<C>;

/**
 * Map of typeName → policies. Validated against the schema at OGM init.
 *
 * The optional `M` parameter pulls per-model `Where`/`CreateInput`/
 * `UpdateInput` shapes from a generated `ModelMap` so the
 * `permissive`/`restrictive` callbacks are typed against the user's
 * schema rather than `Record<string, unknown>`. Falls back to the
 * generic shape when no model map is provided (purely additive).
 */
export type PoliciesByModel<
  M extends Record<string, unknown> = Record<string, unknown>,
  C extends PolicyContext = PolicyContext,
> = {
  [K in keyof M & string]?: ReadonlyArray<Policy<C>>;
} & {
  [typeName: string]: ReadonlyArray<Policy<C>> | undefined;
};

export interface PolicyDefaults {
  /** What to do when no permissive matches. Default `'empty'`. */
  onDeny?: 'empty' | 'throw';
  /** Inject audit metadata into tx? Default `true` when policies are set. */
  auditMetadata?: boolean;
}

// ---------------------------------------------------------------------------
// Constructors — vocabulary-neutral. Validate at construction time so a
// malformed policy is caught BEFORE it lands in an OGM config.
// ---------------------------------------------------------------------------

function freeze<T extends object>(obj: T): T {
  return Object.freeze(obj);
}

function assertOperationsValid(
  operations: ReadonlyArray<OperationOrWildcard>,
  kind: string,
): void {
  if (!Array.isArray(operations) || operations.length === 0)
    throw new OGMError(
      `${kind} policy: "operations" must be a non-empty array.`,
    );
}

const VALID_OPERATIONS: ReadonlySet<string> = new Set<string>([
  'read',
  'create',
  'update',
  'delete',
  'aggregate',
  'count',
  '*',
]);

function assertOperationTokens(
  operations: ReadonlyArray<OperationOrWildcard>,
  kind: string,
): void {
  for (const op of operations)
    if (!VALID_OPERATIONS.has(op))
      throw new OGMError(
        `${kind} policy: invalid operation "${op}". Allowed: read|create|update|delete|aggregate|count|*.`,
      );
}

export function override<C extends PolicyContext = PolicyContext>(
  spec: Omit<OverridePolicy<C>, 'kind'>,
): OverridePolicy<C> {
  assertOperationsValid(spec.operations, 'override');
  assertOperationTokens(spec.operations, 'override');
  if (typeof spec.when !== 'function')
    throw new OGMError(
      'override policy: "when" is required and must be a function (ctx) => boolean.',
    );
  return freeze({ kind: 'override', ...spec });
}

export function permissive<
  C extends PolicyContext = PolicyContext,
  W extends Record<string, unknown> = Record<string, unknown>,
>(spec: Omit<PermissivePolicy<C, W>, 'kind'>): PermissivePolicy<C, W> {
  assertOperationsValid(spec.operations, 'permissive');
  assertOperationTokens(spec.operations, 'permissive');
  if (!spec.when && !spec.cypher)
    throw new OGMError(
      'permissive policy: at least one of "when" or "cypher" must be provided.',
    );
  if (spec.cypher) {
    if (typeof spec.cypher.fragment !== 'function')
      throw new OGMError(
        'permissive policy: cypher.fragment must be a function.',
      );
    if (typeof spec.cypher.params !== 'function')
      throw new OGMError(
        'permissive policy: cypher.params must be a function.',
      );
  }
  return freeze({ kind: 'permissive', ...spec });
}

const READ_OPERATIONS: ReadonlySet<string> = new Set<string>([
  'read',
  'delete',
  'aggregate',
  'count',
]);

const WRITE_OPERATIONS: ReadonlySet<string> = new Set<string>([
  'create',
  'update',
]);

function classifyRestrictiveOps(
  operations: ReadonlyArray<OperationOrWildcard>,
): 'read' | 'write' {
  let sawRead = false;
  let sawWrite = false;
  let sawWildcard = false;
  for (const op of operations)
    if (op === '*') sawWildcard = true;
    else if (READ_OPERATIONS.has(op)) sawRead = true;
    else if (WRITE_OPERATIONS.has(op)) sawWrite = true;

  if (sawWildcard)
    throw new OGMError(
      'restrictive policy: wildcard "*" operations are not supported. Restrictives must be either read-side (read|delete|aggregate|count) or write-side (create|update). Split the policy into two restrictives — one per operation kind.',
    );
  if (sawRead && sawWrite)
    throw new OGMError(
      'restrictive policy: operations array mixes read-side (read|delete|aggregate|count) and write-side (create|update) ops. The "when" callback receives different arguments depending on the operation kind, so a single restrictive cannot serve both. Split it into two restrictives — one per operation kind.',
    );
  return sawWrite ? 'write' : 'read';
}

// Runtime constructor — overloads narrow the `when` signature based on
// the literal `operations` tuple so write-side restrictives type-check
// `(ctx, input) => boolean` and read-side restrictives type-check
// `(ctx) => W | boolean`.
export function restrictive<
  C extends PolicyContext = PolicyContext,
  I extends Record<string, unknown> = Record<string, unknown>,
>(
  spec: Omit<WriteRestrictivePolicy<C, I>, 'kind'>,
): WriteRestrictivePolicy<C, I>;
export function restrictive<
  C extends PolicyContext = PolicyContext,
  W extends Record<string, unknown> = Record<string, unknown>,
>(spec: Omit<ReadRestrictivePolicy<C, W>, 'kind'>): ReadRestrictivePolicy<C, W>;
export function restrictive<
  C extends PolicyContext = PolicyContext,
  W extends Record<string, unknown> = Record<string, unknown>,
  I extends Record<string, unknown> = Record<string, unknown>,
>(
  spec:
    | Omit<ReadRestrictivePolicy<C, W>, 'kind'>
    | Omit<WriteRestrictivePolicy<C, I>, 'kind'>,
): RestrictivePolicy<C, W, I> {
  assertOperationsValid(spec.operations, 'restrictive');
  assertOperationTokens(spec.operations, 'restrictive');
  const flavor = classifyRestrictiveOps(spec.operations);

  if (flavor === 'write') {
    const writeSpec = spec as Omit<WriteRestrictivePolicy<C, I>, 'kind'>;
    if (typeof writeSpec.when !== 'function')
      throw new OGMError(
        'restrictive policy (write): "when" is required and must be (ctx, input) => boolean. The cypher escape hatch is not supported for write restrictives — there is no compiled WHERE clause to AND-stitch into.',
      );
    if ('cypher' in writeSpec && writeSpec.cypher !== undefined)
      throw new OGMError(
        'restrictive policy (write): the cypher escape hatch is not supported for create/update operations. Use "when" alone or split into a read-side restrictive on "delete"/"read".',
      );
    return freeze({ kind: 'restrictive', ...writeSpec });
  }

  // read-side
  const readSpec = spec as Omit<ReadRestrictivePolicy<C, W>, 'kind'>;
  if (!readSpec.when && !readSpec.cypher)
    throw new OGMError(
      'restrictive policy: at least one of "when" or "cypher" must be provided.',
    );
  if (readSpec.cypher) {
    if (typeof readSpec.cypher.fragment !== 'function')
      throw new OGMError(
        'restrictive policy: cypher.fragment must be a function.',
      );
    if (typeof readSpec.cypher.params !== 'function')
      throw new OGMError(
        'restrictive policy: cypher.params must be a function.',
      );
  }
  return freeze({ kind: 'restrictive', ...readSpec });
}

// ---------------------------------------------------------------------------
// Discriminant guards. The `RestrictivePolicy` union is discriminated by
// `operations` — read-side ops (read|delete|aggregate|count) → ReadRestrictive,
// write-side ops (create|update) → WriteRestrictive. The constructor rejects
// mixed arrays, so a policy that survives construction is always exactly one
// flavor; these guards just observe which.
// ---------------------------------------------------------------------------

export function isReadRestrictive<C extends PolicyContext>(
  p: RestrictivePolicy<C>,
): p is ReadRestrictivePolicy<C> {
  for (const op of p.operations)
    if (WRITE_OPERATIONS.has(op as string)) return false;
  return true;
}

export function isWriteRestrictive<C extends PolicyContext>(
  p: RestrictivePolicy<C>,
): p is WriteRestrictivePolicy<C> {
  for (const op of p.operations)
    if (WRITE_OPERATIONS.has(op as string)) return true;
  return false;
}

/**
 * Resolved policy set for a single (typeName, operation) pair after
 * override short-circuit and `appliesWhen` filtering. Consumed by the
 * compilers to AND-stitch into the WHERE clause.
 */
export interface ResolvedPolicies<C extends PolicyContext = PolicyContext> {
  /** True → emit nothing; query is byte-identical to a no-policy query. */
  overridden: boolean;
  permissives: ReadonlyArray<PermissivePolicy<C>>;
  restrictives: ReadonlyArray<RestrictivePolicy<C>>;
  /** Names of policies that fired (for audit logging). */
  evaluated: ReadonlyArray<string>;
}

/**
 * Carries policy state through one compile pass. Created per query in
 * `Model` / `InterfaceModel` and threaded into `WhereCompiler` /
 * `SelectionCompiler`.
 */
export interface PolicyContextBundle<C extends PolicyContext = PolicyContext> {
  ctx: C;
  resolved: ResolvedPolicies<C>;
  operation: Operation;
  /**
   * Resolver callback: given a target type's name and an operation,
   * return its `ResolvedPolicies` for use during nested-selection
   * enforcement. Returns `null` when no policies apply (no policy
   * registered for that type).
   */
  resolveForType: (
    typeName: string,
    op: Operation,
  ) => ResolvedPolicies<C> | null;
  /** Defaults snapshot — read by compilers for `onDeny`. */
  defaults: PolicyDefaults;
}
