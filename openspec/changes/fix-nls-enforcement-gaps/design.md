## Context

NLS (v1.7.0+) resolves policies per `(type, operation, ctx)` and compiles them into the WHERE clause (row filters) or evaluates them in application code (the `WITH CHECK` write restrictives, and create default-deny). **Root-type** enforcement is solid. **Target-type** enforcement, meaning the policies of *other* types reached through relationships, is patchy. A probe-verified audit during issue #6 (v2.2.0) produced this matrix:

| Path | Target policy enforced today |
|---|---|
| Nested selection, traversal filters (`_SOME`…, `Connection`) | `read`, but **none when the root type has no policies** (H1) |
| connect / disconnect in `update` | `read`, but **none when the root has no policies** (H1) |
| connect in `create` | **none**: `Model.create` never passes a policy context to `compileCreate` |
| Cascade delete (`Model.delete` → `compileDelete`) | **none**, and the per-relationship `where` is **ignored** (H4) |
| delete inside `update` | **none** (`where.node` honored; `edge` and nested `delete` ignored) |
| Nested `update` of related nodes | **none**: no row filter, no write restrictives on the nested input |
| Nested `create` (in `create` / `update`) | **none**: `evaluateCreatePolicies` checks only the root input against the root type |
| Traversals inside nested-write `where` | **none**: the mutation compiler's parallel where builder threads no policy context |

Two isolated defects complete the picture:
- **H3:** `compileConditions` handles `value === null` *before* parsing operator suffixes. So `{ field_NOT: null }` becomes `` n.`field_NOT` IS NULL ``, which is always true, and unknown fields with `null` bypass `strictWhere`.
- **H2:** `InterfaceModel.compileInterfacePolicyClause` emits `WHEN n:<Impl> THEN true` whenever the implementer's merged lists are empty. That conflates "no policies registered" with "registered, none apply", where the second should be default-deny.

Key code facts this design relies on (all verified):
- Every target-policy consumer (`WhereCompiler.buildTargetBundle`, `compileUnionRelationship`, `SelectionCompiler.compileNestedWhere`, `MutationCompiler.buildTargetPolicyPredicate`) goes through `bundle.resolveForType`, and **none of them reads `resolved.overridden`**.
- Every root-level consumer that sees `resolved.overridden === true` behaves exactly as it does for a `null` bundle: `assertNotDeniedAtCompile`, `evaluateCreatePolicies`, `evaluateWriteRestrictives`, the `upsert` create check, and `compileUserAndPolicy` (no root clause). `InterfaceModel.find` already uses a synthetic `overridden: true` bundle for exactly this purpose.
- `resolver.gatherSources(member)` already includes the member's interfaces' policies, so `resolveForType(member)` is the complete resolution for an implementer.
- The mutation compiler's builder (`buildConnectionWhereConditions` → `buildNodeWhereConditions` → `tryBuildRelationshipFilter`) duplicates `WhereCompiler`. Its history shows repeated missed-sibling fixes (v1.7.2, v1.8.1, v1.8.7).

## Goals / Non-Goals

**Goals:**
- **G1.** A policy-bound model enforces target-type policies on every path, whether or not the root type has policies.
- **G2.** A nested write enforces exactly what the equivalent direct write on the target type would.
- **G3.** `null` means one thing across every `where` compiler, and no input can silently compile into a filter that does nothing.
- **G4.** Each `InterfaceModel` branch equals the implementer's own `Model` policy clause.
- **G5.** Every hole is proven closed against a live Neo4j, not only by inspecting Cypher strings.
- **G6.** OGMs without policies, and reads that touch no policy-protected type, emit byte-identical Cypher.

**Non-Goals:**
- Multi-level cascade delete: a `delete` inside a delete spec throws, and becomes a follow-up feature.
- `edge` filters in mutation `where`: still unsupported, still throw.
- `SelectionCompiler.compileSimpleWhere`, which silently drops operators in selection connection-where. It is a correctness bug, not a policy bypass, and is tracked separately.
- `InterfaceModel.explainPolicies`, and explain for `count`/`aggregate`.
- New policy vocabulary. The per-operation semantics stay as they are: a type with no policies for an operation is unconstrained for that operation, on both direct and nested writes.

## Decisions

### D1. A policy-bound model always carries a bundle (H1)
`Model.resolvePolicyContext(op)` returns a bundle whenever a non-bypassed binding exists. When `binding.resolve(root, op)` is `null`, the bundle's `resolved` is a shared frozen `NO_ROOT_POLICY = { overridden: true, permissives: [], restrictives: [], evaluated: [] }`.

`overridden: true` operationally means "emit no root clause", which is exactly the documented meaning in `ResolvedPolicies`. Every root consumer already treats it the same as `null`, and every target consumer ignores it. `InterfaceModel` switches to the same constant, replacing its inline copies. `explainPolicies` builds its bundle the same way when `resolveDetailed` returns `null`, so its nested selection is enforced too.

*Alternative rejected:* adding a new `unconstrained` flag to the public `PolicyContextBundle`. That changes an exported type for no behavioral gain.

**Found during implementation: operation fallbacks.** `Model.aggregate` (and so `count`) falls back from `aggregate` to `read` policies when no `aggregate` policy is registered, and it detects that as `resolvePolicyContext('aggregate') === null`. Returning `NO_ROOT_POLICY` unconditionally would silently disable that fallback, leaving `count`/`aggregate` unrestricted on every type that only defines `read` policies. That would be a new hole. The fallback must therefore test `bundle.resolved === NO_ROOT_POLICY` (an identity check on the shared constant) instead of bundle nullness. A real override resolution is a different object, so it still does not fall back. A regression test pins `count` against a read-only-policy type. `InterfaceModel.aggregate` is unaffected, because `resolveInterfacePolicy` already returns a bundle whenever one is bound.

### D2. One principle for nested writes, one helper per enforcement kind (G2)
*A nested write enforces exactly what the equivalent direct write on the target type would.* Direct writes enforce two kinds of rule, so nested writes get the same two:

1. **Row filters, compiled into the nested MATCH.** `MutationCompiler.buildTargetPolicyPredicate` gains an `op` parameter (`'read' | 'update' | 'delete'`) and resolves `resolveForType(target, op)`. It mirrors the direct path's `assertNotDeniedAtCompile`: if that operation has policies but no permissive applies and `onDeny` is `'throw'`, it throws `PolicyDeniedError` at compile time. Otherwise it emits the composed clause (`false` on default deny).
   - connect / disconnect → `'read'` (unchanged rule; now on every path, including connect-in-create)
   - nested update → `'update'`
   - cascade delete, and delete inside update → `'delete'`
2. **Application-layer checks on the nested input**, in a new `src/policy/nested-writes.ts`. It walks the create/update input with the schema:
   - for each nested `create.node` of type T: apply T's `create` permissive default-deny, then T's write restrictives (`WITH CHECK`) on that node input, then recurse;
   - for each nested `update.node` of type T: apply T's `update` write restrictives on it, then recurse.

   It reuses the exact predicate code of `evaluateCreatePolicies` / `evaluateWriteRestrictives`. Those are extracted to module-level functions so root and nested share one implementation. It runs before compile, alongside the root checks.

   It is called from `create`, `update` and `updateMany`. It is **not** called from `createMany` or `upsert`, because neither executes nested writes: `createMany` rejects relationship fields (and drops them from items after the first), and `compileMerge` ignores relationship keys. Both silent drops are tracked separately. The walk mirrors the compiler's input shapes: union targets are keyed by member, and interface targets are skipped because the compiler emits no nested create/update for them.

`Model.create`, `update`, `delete`, `updateMany`, `upsert` and `createMany` thread the bundle **and** one shared `paramCounter` into every mutation-compile call. `compileCreate` and `compileDelete` gain the optional parameters they lack today.

### D3. Cascade delete: honor `where`, gate by the target's `delete` policy, reject what's unsupported (H4)
A shared `MutationCompiler.buildNestedDelete(...)` serves both `Model.delete`'s cascade and delete-inside-`update`. It accepts a single spec or an array. Per item it emits a unit subquery:

```
CALL {
  WITH n
  MATCH (n)-[:`IN_CATEGORY`]->(del_0:`Category`)
  WHERE <item.where, compiled by WhereCompiler (D4)> AND <target 'delete' policy (D2)>
  DETACH DELETE del_0
}
```

- `{}` or no `where` deletes all related nodes that pass the target's `delete` policy. This preserves the tested `{}` semantics.
- A non-empty nested `delete` throws `OGMError`: multi-level cascade is not supported.
- Unknown spec keys throw instead of being ignored.
- The root node is deleted after the cascade subqueries, and the counters include cascaded nodes.

*Why subqueries instead of today's chained `OPTIONAL MATCH`:* chained optional matches multiply rows (a cartesian product across relationships), and they cannot carry per-item `WHERE`s cleanly.

### D4. Nested-write `where` is compiled by `WhereCompiler` (G3, traversal policies)
The mutation compiler's builder (`buildConnectionWhereConditions`, `buildNodeWhereConditions`, `tryBuildRelationshipFilter`) is **removed**. Mutation `where` never supports `edge`, so a mutation connection-where is exactly a node where on the target. A pure function `connectionWhereToNodeWhere(spec)` maps:
- `{ node: A }` → `A`
- `{ node_NOT: A }` and `{ NOT: C }` → `{ NOT: … }`
- `AND` / `OR` → mapped element-wise
- bare property objects → themselves, for backward compatibility with `{ id: 'x' }`
- `edge` / `edge_NOT` → throw (as today)

The mapped where is compiled by `WhereCompiler.compile(nodeWhere, targetVar, targetDef, sharedCounter, { policyContext: traversalBundle })`. `traversalBundle` has `resolved: NO_ROOT_POLICY` and the caller's `resolveForType`. That way traversals inside the filter enforce the traversed types' `read` policies, while the target's own operation policy is added separately by D2. This avoids the read-vs-delete mix-up that reusing `compileConnectionWhereInput` would cause, because it stitches the target's **read** policy only when a `node` key is present.

`@cypher` preludes in a nested-write `where` throw, as `buildTargetPolicyPredicate` already does, because mutation subqueries cannot host them.

*Consequence:* nested-write parameters move from `connect_<field>_<prop>`-style names to the shared `paramN` counter, so emitted Cypher changes. Tests switch from asserting parameter names to asserting semantics. The live suite (D7) is the backstop.

**Exception, found during implementation and confirmed by the user: the bulk-connect UNWIND fast path.**
- *Why it exists:* a top-level array `connect` compiles to a single `UNWIND $items AS connItem MATCH … WHERE target.x = connItem.where.node.x` statement. `WhereCompiler` cannot express those per-row references, because it binds constant `$paramN` values. Routing every item through it would produce O(n)-sized Cypher and lose plan caching for bulk connects.
- *What changes:* the fast path is kept, but **narrowed** to items whose `where` is `{ node: { … } }` (or bare properties) with only scalar keys (registered operators allowed), **non-null values**, and no `AND`/`OR`/`NOT`/`node_NOT`/relationship traversal.
- *Everything else* falls back to the per-item path, which compiles through `WhereCompiler`. Today the fast path mis-compiles `null` and logical keys (`target.AND = …`); those now fall back too.
- *What remains of the old builder:* the small row-reference builder (`extractConnectWhereConditions` + `parseOperatorSuffix`) is the only survivor. Every predicate it produces is a scalar comparison against a non-null row value, so it can only narrow matches and never fail open. The target's `read` policy is still appended.

### D5. Strict null semantics (H3)
In `compileConditions`, a `null` value is interpreted **after** splitting off the operator suffix:

| Input | Compiles to |
|---|---|
| `field: null` | `field IS NULL` (unchanged) |
| `field_NOT: null` | `field IS NOT NULL` |
| `rel: null` | `NOT EXISTS { MATCH … }` (unchanged) |
| `rel_NOT: null` | `EXISTS { MATCH … }` |
| any other operator with `null` (`_IN`, `_GT`, `_CONTAINS`, `_SOME`, …) | throws `OGMError` |
| unknown field (not a property, `@cypher` field, or relationship) with `null` | throws `OGMError`, **regardless of `strictWhere`** |

The asymmetry is deliberate. Only the `null` path fails *open* today. Unknown fields with non-null values fail closed (`n.typo = $p` matches nothing), and keep their current `strictWhere`-gated behavior. D4 makes this apply to nested-write `where` automatically.

### D6. Interface branches equal the implementer's own clause (H2)
For each implementer M, `memberPolicy = resolveForType(M, 'read')`, which already includes M's interface policies:
- `null` → `WHEN n:M THEN true` (M and its interfaces have no `read` policy)
- `overridden` → `THEN true` (consistent with `Model(M).find`; today the interface predicates still apply)
- otherwise → the branch is `compile(undefined, 'n', M, counter, { policyContext: bundleOf(memberPolicy) })`. That is byte-for-byte `Model(M).find`'s clause, so an implementer whose permissives are all gated off correctly gets `false`.

The interface-level `bundle.resolved` is no longer composed in, which removes the duplicated predicates. An override on the interface still short-circuits the whole query. If every branch is `true`, no clause is emitted.

**Invariant, tested directly:** for every implementer, the branch text equals the policy clause `Model(M).find` compiles for the same context. The `InterfaceModel` case of the 17-case golden changes deliberately and is re-pinned with the new expected text.

**Found during implementation: aggregate and `onDeny: 'throw'`.**
- `InterfaceModel.aggregate`/`count` branches always resolved members for `read`, ignoring a member's own `aggregate` policies. Each branch now matches `Model(M).aggregate`: the member's `aggregate` policies, falling back to `read` when it has none. This goes through the helper's optional `fallbackOp`.
- The interface's `onDeny: 'throw'` pre-check threw whenever no member had a permissive, even when a member had no policy at all (visible under `Model(M)`). It now applies `Model(M)`'s per-member test: no policy, a firing override, or an applicable permissive keeps the query alive.

Both are pinned by `tests/policy/interface-branch-invariant.spec.ts`.

### D6b. Abstract targets: one `CASE` helper for every consumer (H5, found during implementation)
A probe showed that interface- and union-typed relationship targets never apply implementer policies:
- nested selection (`res { id }`, union `items`): unfiltered
- traversal: `EXISTS { MATCH (n)-[:HAS_RES]->(r0) … }` with no member policy
- connect: `MATCH (target:Res)` with no member policy

Every consumer called `resolveForType(<abstract name>)`.

A single `WhereCompiler.compileTargetPolicyClause(typeName, var, op, bundle, counter)` returns the policy clause guarding a node of a possibly-abstract type:
- **concrete type:** its own composed clause for `op`. This is byte-identical to today, and `null` when it has no policy for `op`.
- **interface or union:** `CASE WHEN var:M1 THEN <M1 clause> WHEN var:M2 THEN … ELSE false END`, using `resolveForType(M, op)`. That call already includes M's interface policies.
  - a member with no policy, or whose override fires, gets `THEN true`
  - if **every** member is `true`, the result is `null` (unconstrained, like a concrete type without policies)
  - `ELSE false` covers a labelled node that isn't a known member (defense in depth)

Consumers:
- `MutationCompiler.buildTargetPolicyPredicate`: every nested-write target
- traversal filters on interface targets
- `SelectionCompiler` nested projection of interface and union targets
- `InterfaceModel`'s root clause. This **is** D6: the root is just an abstract target at depth 0, with the root-interface override short-circuit kept.

Preludes (`@cypher` fields in member policies) are returned to the caller. Nested contexts reject them, as they already do.

**Found during implementation: `@cypher` scopes don't chain.** Each `CypherFieldScope` emits `CALL {…} WITH <var>, <its own aliases>`, so emitting a second independent scope after a first drops the first's aliases. When more than one member policy (or an abstract target's user filter plus a member policy) projects `@cypher` fields, the helper throws an `OGMError` instead of emitting Cypher that fails at runtime. A connection's node filter and a concrete target's policy share one caller-owned scope (`compile(…, { scope })`) instead.

### D6c. Traversal filters compose the target policy outside every negation (found during implementation)
A probe of the v1.8.5 CRIT-3 fix showed that the target policy was compiled **into** the caller's filter (`compile(userFilter, …, targetBundle)`). That is right for `_SOME` but wrong wherever the quantifier negates the filter:

| Filter | Emitted before | Effect |
|---|---|---|
| `rel_ALL: { f }` | `NOT EXISTS { … WHERE NOT (f AND policy) }` | hidden related nodes **falsify** it |
| `rel_ALL: {}` | `NOT EXISTS { … WHERE NOT (policy) }` | true only when **no** related node exists at all (an existence oracle) |
| `relConnection: { node_NOT: { f } }` | `EXISTS { … WHERE NOT (f AND policy) }` | **satisfied** by hidden nodes |
| `relConnection: { edge: { … } }` | `EXISTS { … WHERE e.w = $p }` | no policy at all |
| `a_SOME: { b_SOME: { c_SOME } }` with policy-free `B` | `buildTargetBundle(B)` returned `undefined` | `C` unguarded at depth ≥ 2 |
| selection `…Connection(where: { node_NOT })` | compiled with `policyContext: null` | traversals inside the negation unguarded |

The fix is one structural change. `compileTargetBody` compiles the caller's filter (`user`) and the target's policy (`policy`) **separately**. Each quantifier then composes them with the policy outside every negation:
- `_SOME`: `EXISTS { … WHERE (user) AND policy }`. For concrete targets this is byte-identical to before.
- `_NONE` / `_NOT`: `NOT EXISTS { … WHERE (user) AND policy }`
- `_ALL`: `NOT EXISTS { … WHERE policy AND NOT (user) }`. With no caller filter it is vacuous (`''`).
- `_SINGLE`: `size([… WHERE (user) AND policy …]) = 1`
- connections: the policy is ANDed once over the whole body (`node`, `node_NOT`, `edge`, logical groups).

The user filter compiles under a traversal bundle (`NO_ROOT_POLICY` plus a live `resolveForType`), and `buildTargetBundle` never returns `undefined` for a bound context. Together these make enforcement cascade to any depth. The union path gets the same per-member treatment. Semantics: a quantifier ranges over the related nodes the caller may **see**. Hidden nodes neither satisfy nor falsify it.

### D7. Red-first, opt-in live Neo4j suite (G5)
`tests/integration/nls-enforcement.spec.ts` uses `describe.skip` unless `NEO4J_URI` is set (credentials come from `NEO4J_USER`/`NEO4J_USERNAME` and `NEO4J_PASSWORD`, as in `examples/`). It uses dedicated `It*` labels and a per-run id, and cleans up in `afterAll`.

One scenario per row of the Context matrix, plus H2 and H3. Each asserts real outcomes (rows returned, nodes remaining, relationships created, errors thrown). The tests are written and run **before** each fix to show the hole exists, then kept as regression tests. CI is unchanged. The release checklist requires a local run.

## Risks / Trade-offs

- **[Nested-write Cypher changes across many paths]** → Semantic unit tests, the live suite (D7), and the unchanged 17 read goldens (all but the deliberate `InterfaceModel` case) confine the change to write paths.
- **[Callers relying on the broken cascade (passing `where` but getting delete-all)]** → Documented as a behavior change. The new behavior is what the README and the generated types already promised.
- **[Callers using nested writes into protected types without matching policies for that operation]** → They start getting filtered or denied. This is the fix, called out in the CHANGELOG with a migration note: add the target-type policy for that operation, or perform the write directly.
- **[Strict nulls reject inputs that used to compile]** → Those inputs compiled into filters that did nothing or were wrong. Precedent: v2.0.0 rejected silently truncated inputs.
- **[`overridden: true` used for "no root policy"]** → The shared constant is named and documented, and it is the operational meaning already documented on `ResolvedPolicies`. A test asserts that nothing on a target-policy path reads `overridden`.
- **[Performance]** → `resolveForType` now also runs for unprotected roots at each relationship boundary. The resolver is an in-memory map walk, so the cost is negligible next to query time.
- **[Live suite not run in CI]** → It's opt-in by design, so CI is unchanged. The release checklist requires a local run, and the suite can be promoted to a CI service container later.

## Migration Plan

This is a security minor release (v2.3.0). The CHANGELOG gets a **Security** section per hole and a **Behavior changes** section with migration notes (cascade `where` semantics, multi-level cascade error, strict nulls, `field_NOT: null`, nested writes now policy-gated). There are no API signature changes to public methods. `compileCreate` and `compileDelete` gain optional trailing parameters. Rollback means pinning v2.2.0.

## Open Questions

- Whether to publish a GitHub Security Advisory for H1/H4 alongside the release. Decide at release time, and check how v1.14.0 was announced.
- Promoting the live suite to CI with a Neo4j service container is a follow-up.
