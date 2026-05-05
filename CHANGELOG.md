# Changelog

## 1.7.2 (2026-05-05)

> Codegen/runtime parity bug fixes surfaced by an internal audit. Five
> blockers that previously produced silent wrong results (or threw with
> misleading messages). No behavioural change for code that wasn't hitting
> the buggy paths — Cypher emit is byte-identical for filters that
> avoided the affected key shapes.

### Fixed

- **Union/interface relationship `null` filter no longer matches every row.** Pre-1.7.2, `where: { someUnionRel: null }` (and the same on interface-typed relationships, including `_SOME` / `_NONE` / `_ALL` / `_SINGLE` quantifiers) emitted the literal abstract type name as a Neo4j label — which no concrete-typed implementer carries — so `NOT EXISTS` was true for every row. The compiler now passes `schema` to `buildRelPattern` and emits a labelless target so the relationship type is authoritative.
- **`<rel>_NOT` compiles as `NOT EXISTS`, not scalar `<>`.** Pre-1.7.2, `where: { drugs_NOT: { name: 'X' } }` fell through to the scalar branch and emitted `n.drugs <> $param0` against a Map value — producing NULL and silently dropping every row. `_NOT` is now recognised as a relationship suffix (semantically equivalent to `_NONE`). Scalar fields ending in `_NOT` still resolve to `<>` as before because the relationship branch falls through when the prefix isn't a real relationship name.
- **`<rel>Aggregate` filters throw clearly instead of producing wrong rows.** Pre-1.7.2, `where: { drugsAggregate: { count_GT: 5 } }` fell into the scalar compiler and emitted `n.drugsAggregate = $param0` against a non-existent property → empty result. The runtime now throws `OGMError: Relationship aggregate filter "<key>" is not yet supported at runtime. Use _SOME / _NONE / _ALL with a target Where clause instead.` Codegen still emits the type for forward compatibility; the throw makes the gap loud.
- **Connection `node_NOT` / `edge_NOT` / `AND` / `OR` / `NOT` are honoured** in `where: { fooConnection: { ... } }`. Pre-1.7.2 only `node` and `edge` keys were inspected; everything else was silently dropped. The new internal `compileConnectionWhereInput` recurses through these keys inside the same EXISTS body so the relationship-type-and-edge pair stays bound. The `select.where` connection path supports `node_NOT` / `edge_NOT` and rejects `AND` / `OR` / `NOT` with a clear `OGMError` (move to top-level `where:` for those — pattern-comprehension nesting limits prevent in-place support without a redesign).
- **Nested `update: { rel: { delete: { where: {...} } } }` honours operator suffixes.** Pre-1.7.2 the delete branch built inline `prop = $param` for every key, ignoring `_GT` / `_CONTAINS` / `_IN` / etc. — so `delete: { where: { node: { title_CONTAINS: 'Draft' } } }` either deleted nothing or targeted a non-existent literal property. The branch now uses the same `buildNodeWhereConditions` helper as `disconnect` / `connect`, so operators, `NOT`, and relationship sub-filters all work.

### How

- `where.compiler.ts`: every `buildRelPattern` call now passes `schema: this.schema` so abstract-target detection runs (#1). `RELATIONSHIP_SUFFIXES` adds `'_NOT'`, dispatched to the same `NOT EXISTS` body as `_NONE` (#3). New `compileConnectionWhereInput` helper recursively processes `node` / `edge` / `node_NOT` / `edge_NOT` / `AND` / `OR` / `NOT` (#4). Relationship `Aggregate` keys throw clearly before falling into the scalar branch (#2).
- `selection.compiler.ts`: `compileConnection` extends the `cw` split logic to handle `node_NOT` / `edge_NOT` (negated branches AND-merge with the main fragment) and throws on connection-level `AND` / `OR` / `NOT` until the pattern-comprehension limitation is lifted.
- `mutation.compiler.ts`: the `delete` branch under `buildUpdateRelationships` calls `this.buildNodeWhereConditions(...)` — the same builder that `disconnect` and `connect` already use.

### Test coverage

- `tests/where.compiler.spec.ts` — interface-target tests updated to assert the new (correct) labelless emit; new regression block `v1.7.2 codegen/runtime parity` covers `_NOT`, `Aggregate` throw, `node_NOT`, `edge_NOT`, connection `AND` / `OR` / `NOT`, and the union/interface null-filter regression.
- `tests/mutation.compiler.spec.ts` — new regression for `delete.where.node` operator suffixes.
- 1323 → 1332 tests, all passing.

### Out of scope (tracked for a follow-up)

- Connection-level `AND` / `OR` / `NOT` *inside* the typed `select.where` path. Currently throws with a helpful message pointing to the top-level `where:` argument (which fully supports it via `WhereCompiler`).
- Relationship aggregate filters (`<rel>Aggregate`). Surface area is bigger than a parity fix — needs a runtime aggregation predicate compiler.
- Same `delete.where` operator-parity fix for `mutation.compiler.ts:1438` (the deeper-nested cascade variant). The visible top-level path is fixed; the deeper variant uses a different helper and was not touched in this release.

## 1.7.1 (2026-05-04)

### Fixed

- **Connection `where: { edge: ... }` filters now compile** in Prisma-style selections (`select: { fooConnection: { where: { edge: {...} }, ... } }`). Pre-1.7.1, any non-empty `edge` branch threw `OGMError: Connection WHERE with "edge" filters is not supported. Only "node" filters are supported for connection "<field>".` even though the generated `<Parent><Field>ConnectionWhere` type already exposed `edge?: <RelProps>Where` — codegen and runtime were misaligned. The compiler now synthesizes a `NodeDefinition` from the relationship-properties type and delegates to `WhereCompiler.compile()`, picking up the full operator surface for free (scalar operators including `_GT` / `_LT` / `_CONTAINS` / `_IN` / etc., logical `AND` / `OR` / `NOT`, and `mode`).
- **Mixed `node` + `edge` filters AND-merge into a single `WHERE`** inside the pattern comprehension: `where: { node: { title_CONTAINS: 'aspirin' }, edge: { position_GT: 5 } }` compiles to `WHERE n0.\`title\` CONTAINS $param0 AND e0.\`position\` > $param1`.

### How

- `SelectionCompiler.compileConnection()` resolves both branches: node-side via the existing `compileNestedWhere` (with policy injection), edge-side via the new `compileEdgeWhere` helper. Both produce optional fragments that AND-merge in the comprehension's WHERE.
- The new `compileEdgeWhere` builds a synthetic `NodeDefinition` from the `RelationshipPropertiesDefinition` and calls `WhereCompiler.compile()` against `edgeVar`. No new operator code — every operator already supported on nodes works on edges.
- Bare-object `connectionWhere` (no `node` / `edge` keys) is still treated as the legacy node-where shorthand for backwards compatibility with pre-1.7.1 callers.

### Limits

- **`@cypher` fields on edges still throw** in connection `where`. Same constraint as nested `select.where`: pattern comprehensions cannot host `CALL { ... }` preludes. Refactor to filter on stored properties.
- **Edges have no policy enforcement.** Policies bind to node `typeName`; relationship-properties types are not addressable by `withContext()`. The edge branch never resolves a policy context.
- **Mutations still throw on connection `where: { edge: ... }`.** `mutation.compiler.ts` rejects `edge` keys in connection-WHERE inputs to `update` / `delete` / etc. — a separate code path with broader scope (left for a future release; track in a separate issue).

### Test coverage

- `tests/selection.compiler.spec.ts` — three new tests: edge-only filter with `_GT`, mixed node + edge filter, and edge-side `OR` logical composition.
- `tests/policy/nested-selection.spec.ts` — the previous regression-guard `connectionWhere "edge" filter still throws (no regression)` is now `compiles against the relationship-properties type (1.7.1+)` and asserts the positive Cypher emission. Test fixture extended with an `OwnsProps` relationship-properties type.

## 1.7.0 (2026-05-04)

> Stable release of the v1.7.0 beta line. Consolidates `1.7.0-beta.0` through `1.7.0-beta.4`. Stored-only callers see byte-identical Cypher to `1.6.0` — every new pipeline is opt-in.

### Headline feature — Node-Level Security (NLS)

- **Postgres-RLS-style policies on `OGMConfig`.** New optional `policies` map plus `OGM.withContext(ctx)` give you a per-context filter layer that compiles into the existing WHERE pipeline. Policies return `<Node>Where` partials — every operator, quantifier, connection filter, and nested traversal already supported by `WhereCompiler` is automatically available. Vocabulary-neutral: no hardcoded role strings, you compose your own.
- **Three policy kinds.**
  - `override` — compile-time short-circuit. The admin path emits Cypher byte-identical to a no-policy query.
  - `permissive` — OR'd grants with an optional `appliesWhen` compile-time gate so policies that don't apply to the current context are skipped before WHERE compilation.
  - `restrictive` — discriminated union over `operations`:
    - `ReadRestrictivePolicy` covers `read | delete | aggregate | count`. `when(ctx)` returns a `<Node>Where` partial or `false`. Compiles into the WHERE clause via `WhereCompiler`. Invoked exactly once per read-side query.
    - `WriteRestrictivePolicy` covers `create | update`. `when(ctx, input)` returns a boolean. Runs at the application layer ("WITH CHECK"). Invoked exactly once per write op. The `cypher` escape hatch is not supported on write restrictives.
    - Mixed-operation arrays (e.g. `['read', 'create']`) are rejected at construction time with `OGMError`. Split into two restrictives — one per kind.
  - The `restrictive()` constructor uses TypeScript overloads so authoring code gets the correct `when` signature inferred from the literal `operations` tuple. Runtime helpers `isReadRestrictive` / `isWriteRestrictive` are exported for inspection.
- **Nested-selection enforcement.** `SelectionCompiler` injects every target type's `'read'` policy into pattern comprehensions, connection edges, and union branches. Policies cannot be bypassed by traversal.
- **Default-deny baseline.** `policyDefaults.onDeny: 'empty'` (default) emits `WHERE false` when no permissive matches; `'throw'` raises `PolicyDeniedError` before the query runs.
- **Audit metadata.** Every OGM-emitted query attaches `tx.setMetaData({ ogmPolicySetVersion, ctxFingerprint, modelType, operation, policiesEvaluated, bypassed })`. `ctxFingerprint` is a SHA-256 of the SORTED ctx KEYS only — never values, never anything sensitive.
- **Interface-aware enforcement.** `InterfaceModel.find()` / `aggregate()` emit a CASE-per-label WHERE that AND-combines each implementer's `'read'` policy with the interface-level policy. Concrete-type policies are NOT bypassed when querying through the interface.
- **Escape hatches.** `ogm.unsafe.bypassPolicies()` returns a non-policy-aware OGM (logged via `logger.warn`); per-method `unsafe: { bypassPolicies: true }` skips policies for a single call (also logged).
- **`PolicyDeniedError`** — new public error class extending `OGMError`. Carries `typeName`, `operation`, `reason` (`'no-permissive-matched' | 'restrictive-rejected-input' | 'override-failed-validation'`), and optional `policyName`.

### Type-safety — fulltext index names

- **`ModelInterface` and `Model` gain a 12th generic `TFulltext`**, defaulting to the loose `FulltextInput`. The generated type file passes `<Node>FulltextInput` as that generic for every node with a fulltext index (direct or via a relationship-properties type). The previous `Omit<..., 'find' | ...> & { find(...) }` override pattern is gone — typed fulltext flows through `find`, `findFirst`, `findFirstOrThrow`, `count`, and `aggregate` purely via generic substitution. Same mechanism `<Node>Sort` already used.
- **`ModelMap` entries gain a `Fulltext` key** when the node has a fulltext index. The `OGM.model<K>(name)` overload reads `TModelMap[K]['Fulltext']` and passes it as the 12th generic to `Model`. Nodes without indexes omit the key and inherit the loose default. `OGMWithContext.model<K>` (returned from `withContext`) threads the same generic through — typed fulltext flows through the policy-bound surface too.
- **Result: typos in fulltext index names are now compile errors at every nesting level**, including inside `OR` / `AND` / `NOT` logical compositions. The recursive `<Node>FulltextInput` shape closes over the per-node leaf, so `{ OR: [{ WrongIndex: { phrase: 'x' } }] }` fails type-checking against `<Node>FulltextInput[]`.

### `@cypher` selection — nested related nodes

- **Selecting a `@cypher` scalar inside a relationship traversal now resolves at runtime.** Pre-1.7.0, `Model.find({ select: { hasStatus: { select: { formName: true } } } })` (where `formName` is a `@cypher` field on the related `Status` node) threw `OGMError: Selecting @cypher field "<field>" on a related node is not supported.` The compiler now falls back to an inline `head(COLLECT { WITH <var> AS this <statement> })` projection per row of the surrounding pattern comprehension.
- **Top-level `@cypher` selections are unchanged.** They continue to use the `CALL { ... } / WITH ... AS __sel_n_<field>` prelude pathway (one CALL per unique field, dedupes references). Only nested selections — where preludes have no anchor — use the inline fallback.
- `this` is rebound from the outer node variable inside the `COLLECT { ... }` (no text substitution), matching the convention used by the top-level CALL path. `COLLECT { ... }` is a Cypher 5.x subquery expression; the OGM already requires `neo4j-driver ^5.0.0`.

### Public API additions (additive only)

- New exports: `override`, `permissive`, `restrictive`, `isReadRestrictive`, `isWriteRestrictive`, `OGMWithContext`, `PolicyDeniedError`.
- New types: `Policy`, `OverridePolicy`, `PermissivePolicy`, `RestrictivePolicy`, `ReadRestrictivePolicy`, `WriteRestrictivePolicy`, `PolicyContext`, `PolicyContextBundle`, `Operation`, `OperationOrWildcard`, `ReadOperation`, `WriteOperation`, `PoliciesByModel`, `PolicyDefaults`, `ResolvedPolicies`, `UnsafeOptions`.
- `OGMConfig` gains optional `policies?` and `policyDefaults?`.
- `OGM` gains `withContext<C>(ctx: C)` and `unsafe.bypassPolicies()`.
- Every Model / InterfaceModel method's params bag gains optional `unsafe?: { bypassPolicies?: boolean }`.
- All existing call signatures remain valid. Calling code that doesn't pass policies compiles and runs identically.

### Unaffected paths (byte-identical to v1.6.0)

- An OGM constructed without `policies` emits identical Cypher to v1.6.0 for every covered operation. Verified in `tests/policy/byte-identical.spec.ts`.
- An OGM with `policies` but invoked via the bare `OGM.model()` path (no `withContext`) emits identical Cypher to v1.6.0.
- An override match emits identical Cypher to a no-policy query.
- `ogm.unsafe.bypassPolicies()` and per-call `unsafe: { bypassPolicies: true }` both emit identical Cypher to v1.6.0.
- Stored-field selections, sorts, and where filters are unchanged. Only operations that touch policies, `<Node>FulltextInput`, or a `@cypher` field on a nested related node use the new pipelines.

### Limits

- **`@cypher` scalar inside a policy `where`-partial** throws when the policy is injected into nested-selection enforcement. Refactor the policy to use stored properties or a relationship traversal. Top-level WHERE on the root model still supports `@cypher` filters.
- **`upsert` evaluates create- and update-side policies at the application layer.** MERGE has no WHERE we can stitch into; the WHERE-side enforcement only covers the matching path. Full MERGE-aware enforcement is deferred to v1.7.1.
- **InterfaceModel CASE-per-label fallback.** When an interface has policies registered but a concrete implementer does not, the implementer's branch falls back to interface-level enforcement only. The OGM emits a `logger.warn` at construction time so it never passes silently. Strict per-implementer default-deny is being evaluated for v1.7.1.
- **AsyncLocalStorage opt-in is deferred to v1.7.1.** This release is explicit `withContext()` only — create one wrapper per request and discard it.
- **`@cypher` selection on nested related nodes** requires the user's statement to return a single column (Cypher rejects multi-column `COLLECT { ... }` subqueries). If you used `columnName` to pick one of several returned columns at the top level, that pattern won't work in nested selections — trim the statement to return only the column you need. Rare in practice.
- **Where filters by `@cypher` fields on nested relations** (e.g. `connectionWhere: { node: { statusLowerName_CONTAINS: 'act' } }`) still throw — that path uses a different list-comprehension structure.
- **Index requirement declaration** (`requires.indexes`) is deferred to v1.8.0.
- **EXPLAIN-in-test mode** is deferred to v1.8.0.

### Generated types

- Existing `<Node>Where`, `<Node>CreateInput`, `<Node>UpdateInput` are sufficient for typing policy callbacks. The generator's `ModelMap` already exposed `Where`, `CreateInput`, and `UpdateInput` keys per model so `PoliciesByModel<M, C>` can index into them.
- **`ModelMap` now also includes a `Fulltext` key** for nodes with fulltext indexes — required for the `<Node>FulltextInput` typing to flow through `OGM.model<K>`. **Regenerate your types** to pick up this key (`npx grafeo-ogm generate-types ...` or your local script). Skipping regeneration is safe — `Model` falls back to the loose `FulltextInput` for any node whose `ModelMap` entry omits the `Fulltext` key.

### Migration

- v1.6.0 → v1.7.0 is purely additive at the runtime level. Stored-only callers and existing policies-free deployments require no changes.
- To opt into typed fulltext index names, regenerate types so `ModelMap` includes the `Fulltext` key.
- To opt into NLS, configure `policies` on `OGMConfig` and call `ogm.withContext(ctx)` at the request boundary.

### Test coverage at release

- 1319 specs across 59 suites pass against the mock driver. Live Neo4j integration coverage was a release blocker during the beta window and is now in place for `tests/policy/byte-identical.spec.ts` plus the C1 read/write contract proofs.

### Beta history

The v1.7.0 line shipped through five beta builds during the v1.7.0-beta.0..4 window:

- `1.7.0-beta.0` — initial NLS proposal.
- `1.7.0-beta.1` — CI publish workflow fix (no code changes; first beta artifact actually reachable on npm under the `beta` dist-tag).
- `1.7.0-beta.2` — typed fulltext via the `TFulltext` generic.
- `1.7.0-beta.3` — `OGM.model<K>(name)` overload threads `<Node>FulltextInput` through (was missing the 12th generic in the typed overload, defeating beta.2's intent).
- `1.7.0-beta.4` — `@cypher` scalar selection on a nested related node now resolves via inline `head(COLLECT { ... })` instead of throwing.

The `RestrictivePolicy` read/write split also landed during the beta window. Earlier beta builds invoked `RestrictivePolicy.when` twice on every write path — once at the application layer with `(ctx, input)` and once at WHERE-compile with `(ctx)` only. Side-effecting callbacks fired inconsistently and any predicate that legitimately depended on `input` returned `false` at compile time → `WHERE false` → reads silently blocked. The discriminated-union shape described above replaced the dual-invocation contract before this final release.

## 1.6.0 (2026-05-01)

### Features

- **`@cypher` scalar fields are now resolved at runtime in `WHERE`** — `find()`, `findFirst()`, `findUnique()`, `count()`, `aggregate()`, `update()`, `updateMany()`, `delete()`, `deleteMany()`, `upsert()`, `setLabels()`, `searchByVector()`, `searchByPhrase()`, and `InterfaceModel.find()` / `aggregate()` now resolve `@cypher` scalar fields when they appear as filter keys (with or without operator suffix — `_EQ`, `_CONTAINS`, `_GT`, `_LT`, `_GTE`, `_LTE`, `_IN`, `_NOT`, `_NOT_IN`, `_STARTS_WITH`, `_ENDS_WITH`, `_MATCHES`, `_NOT_CONTAINS`, etc.). Pre-1.6.0, the typed `<Node>Where` surface emitted these fields and the WHERE compiler would compile `n.<cypherField>` against a property that doesn't exist on the node — predicate always false → silent data omission. Each `@cypher` filter is now compiled into a `CALL { WITH n; WITH n AS this; <user statement> }` prelude before the `WHERE`, with the projected column renamed to a unique `__where_n_<fieldName>` alias the predicate references.
- **`@cypher` scalar fields are now resolved at runtime in `SELECT`** — both `selectionSet: '...'` (string SDL) and `select: { field: true }` (typed) paths now project `@cypher` scalar fields. Compiled into a `CALL { ... } WITH n, <col> AS __sel_n_<fieldName>` prelude before the `RETURN`, then projected into the map as `<fieldName>: __sel_n_<fieldName>`. Pre-1.6.0 these fields were silently emitted as `.\`<fieldName>\`` and returned NULL.
- **AND/OR/NOT composition de-dupes references** — a `@cypher` field referenced multiple times at the same scope (e.g. `OR: [{ field_GT: 1 }, { field_LT: 10 }]`) emits a single `CALL` prelude shared by all references.
- **Relationship-quantifier inner WHERE** — `@cypher` scalar fields on related nodes now work inside `_SOME` / `_NONE` / `_ALL` filters (e.g. `hasStatus_SOME: { statusLowerName_CONTAINS: 'act' }`). The inner `CALL` prelude is stitched directly inside the `EXISTS { MATCH pattern <prelude> WHERE <inner> }` body so each iteration projects the field for its own bound relationship variable.
- **Combined WHERE + SELECT + sort** — all three preludes can co-exist in the same query. Each uses a disjoint alias namespace (`__where_*`, `__sel_*`, `__sort_*`) and the carry chain is threaded so later `WITH` clauses preserve aliases from earlier preludes.
- **Mutation projections now project `@cypher` fields** — `update()`, `upsert()`, and `create()` honour `@cypher` fields in their `select` / `selectionSet` projections via the same SELECT prelude pipeline.

### Internal

- New helper `src/utils/cypher-field-projection.ts` exporting `buildCypherFieldCall()` and `CypherFieldScope`. `CypherFieldScope` is the central state holder used by both `WhereCompiler` and `SelectionCompiler`: it dedupes per-`(nodeVar, fieldName)` registrations, threads carried aliases through every emitted `WITH`, and accepts a `preserveVars` array so callers can keep surrounding pipeline vars (`__typename`, `score`) in scope.
- `WhereCompiler.compile()` now returns `WhereResult { cypher, params, preludes? }`. Top-level preludes are returned for the caller to stitch between MATCH and WHERE; inner-scope preludes (relationship quantifiers, union members) are stitched directly into the `EXISTS` body. A new `compile(...)` option `preserveVars` lets callers keep `score` (vector / fulltext) or `__typename` (interface) in scope across the prelude `WITH` chain.
- `MutationCompiler.compileUpdate()`, `compileDelete()`, and `compileSetLabels()` accept `whereResult.preludes` and emit them between MATCH and WHERE.
- `SelectionCompiler.compile()` accepts an optional `cypherScope` argument. When supplied, top-level `@cypher` scalar fields register there and the caller stitches the scope's emitted lines before the RETURN. When omitted (the default for nested recursive calls), `@cypher` scalar fields throw — pattern comprehensions cannot host CALL subqueries.
- `Model.compileOptions()` now accepts `preserveVars` so the sort prelude carries forward any aliases already projected by an earlier SELECT prelude.

### Notes & Limits

- **Scalar return types only.** Mirrors the v1.5.0 sort scope. `@cypher` fields whose declared return type is a node / interface / union are still projection-only (the `where-emitter` already excludes them, and the SELECT pipeline does not synthesize a sub-projection from a `@cypher` statement).
- **Aggregations are out of scope.** `aggregate()` continues to skip `@cypher` fields when emitting `min(n.<f>) / max / avg`. The aggregation emitters (`<Type>AggregationSelection`, `<Type>EdgeAggregateSelection`, etc.) already exclude `@cypher` from the typed surface.
- **`_SINGLE` quantifiers reject `@cypher` filters.** Both relationship `_SINGLE` and `Connection_SINGLE` use list comprehensions (`size([(pattern WHERE inner) | 1]) = 1`) which cannot host `CALL { ... }` subqueries. Using a `@cypher` field inside `_SINGLE` throws `OGMError` with a clear message — refactor to `_SOME` + `_NONE`.
- **Nested-relationship SELECT projection of `@cypher` fields is rejected.** `select: { hasStatus: { select: { statusLowerName: true } } }` (selecting a `@cypher` field on a related node inside a nested selection) throws `OGMError`. Nested relationships use list comprehensions for their pattern, and CALL subqueries cannot be embedded there. Top-level `@cypher` fields on the root model are fully supported. Workaround: query the related node directly via its own model.
- **Connection `where` does not accept `@cypher` filters.** `select: { hasStatusConnection: { where: { node: { statusLowerName_CONTAINS: 'x' } } } }` throws — same constraint as above.
- **`select.where` (Prisma-style relationship filtering) does not accept `@cypher` filters.** Same root cause; same error.
- **Stored-only queries are byte-identical to 1.5.0.** Only queries that reference at least one `@cypher` field gain the new prelude machinery. Every previous test passes without modification (1031 → 1092 tests after this release).
- **No new generic parameters or breaking type changes.** The `<Node>Where` and `<Node>Select` types are unchanged; if you regenerated against 1.4.x or 1.5.x, those types already exposed scalar `@cypher` fields and now they are correctly resolved at runtime.

## 1.5.0 (2026-04-30)

### Features

- **Sort by `@cypher` scalar fields** — `find()` / `findFirst()` / `findFirstOrThrow()` now resolve `@cypher` scalar fields at runtime when used in `options.sort`, instead of silently sorting against `NULL`. Each `@cypher` sort is compiled into a `CALL { WITH n; WITH n AS this; <user statement> }` subquery, with the projected column renamed to a unique `__sort_<field>` alias before the `RETURN`. Multi-field sort with mixed stored and `@cypher` fields works in any combination. Supports relationship-traversing statements (e.g. `MATCH (this)-[:HAS_STATUS]->(s) RETURN s.name`) — the rebound `this` variable scopes correctly inside the subquery without text substitution.

### Codegen

- **`<Type>Sort` now includes scalar-returning `@cypher` fields** — the per-node and per-interface `Sort` types emit a `<field>?: InputMaybe<SortDirection>` for any `@cypher` field whose declared return type is a sortable scalar (`ID`, `String`, `Int`, `Float`, `Boolean`, `BigInt`, `Date`, `Time`, `LocalTime`, `DateTime`, `LocalDateTime`, `Duration`, or an enum). Skips array returns, node/interface returns, and `Point` / `CartesianPoint`. Purely additive — every previous key still exists, no symbol renames, no removals.

### Schema parser

- **`@cypher(statement, columnName)` arguments are now captured.** `PropertyDefinition` gains two optional fields: `cypherStatement` (the verbatim subquery body) and `cypherColumnName` (the column to project). `cypherColumnName` defaults to the GraphQL field name at runtime when omitted, matching the `@neo4j/graphql` v4+ convention.

### Internal

- New helper `src/utils/cypher-sort-projection.ts` exporting `compileSortClause()` and `buildCypherSortProjection()`. `Model.compileOptions()` and `InterfaceModel.find()` both delegate sort compilation to it. The helper accepts a `preserveVars` array so callers can carry forward variables already in scope (e.g. `__typename` on `InterfaceModel`) across each successive `WITH`.
- `Model.compileOptions()` now returns `{ pre, post }` instead of a single string. `pre` (the CALL subqueries + `WITH` projections) is injected before the `RETURN`; `post` (`ORDER BY` / `SKIP` / `LIMIT`) goes after it.

### Notes & Limits

- **Sort-only.** This release implements `@cypher` resolution exclusively for `ORDER BY`. `select`, `selectionSet`, `where`, and `aggregate` continue to skip `@cypher` fields at runtime as in 1.4.0 — those use cases will be addressed in a separate release.
- **Pre-existing `where-emitter` footgun unchanged**: scalar `@cypher` fields are still emitted in `<Node>Where`, and the WHERE compiler still produces `n.<cypherField>` (which fails at Neo4j). This was already broken in 1.4.x and is out of scope for 1.5.0; track in a separate issue.
- **Statement convention.** `@cypher` statements must reference the bound node as `this` and end with `RETURN <expr> AS <columnName>` (or `RETURN <expr>` alone — the column name then defaults to the GraphQL field name). Example: `@cypher(statement: "RETURN toLower(this.title) AS insensitiveTitle")`. The OGM never modifies the user's statement — `this` is rebound by the wrapping `CALL` subquery.
- **Stored-field sorts produce byte-identical Cypher to 1.4.0.** Only sorts that resolve to a `@cypher` field gain the new CALL/WITH machinery; everything else is unchanged.
- **No new generic parameters or breaking type changes.** `TSort` keeps its 1.4.0 default (`Record<string, 'ASC' | 'DESC'>`) — un-regenerated consumers continue to compile against the older `<Node>Sort` shape.

## 1.4.0 (2026-04-30)

### Features

- **Type-safe `sort` options per model** — `find()`, `findFirst()`, and `findFirstOrThrow()` now type-check the `options.sort` array against the actual node (or interface) properties. Writing `sort: [{ nonExistentField: 'ASC' }]` produces a TypeScript error instead of silently compiling. Powered by the existing per-node `<Node>Sort` types (which were emitted by the generator since v1.0 but never wired into the runtime). Also covers `InterfaceModel` via newly emitted `<Iface>Sort` / `<Iface>Options` types.

### Improvements

- `ModelInterface` and `Model` now accept `TSort` as an 11th generic parameter (default `Record<string, 'ASC' | 'DESC'>`, preserving the previous untyped behavior for callers that don't pass generics).
- `InterfaceModelInterface` and `InterfaceModel` accept `TSort` as a 3rd generic parameter (same default).
- `ogm.model<K>()` and `ogm.interfaceModel<K>()` typed overloads now derive `TSort` from `TModelMap[K]` / `TInterfaceModelMap[K]` via a new `Sort` field on each map entry. The `model<K>` overload also wires `MutationSelectFields` through (was previously defaulting to `any` despite being available on the map).
- The generated `<Node>Model` aliases — including the fulltext-typed override variants — now reference `<Node>Sort` directly, so autocomplete and typo-checking work in IDEs without any extra setup.

### Generator

- `sort-options-emitter.ts` now also emits `<Iface>Sort` and `<Iface>Options` for every interface in the schema (previously nodes only). Each interface's sortable fields are derived from its own scalar property declarations, skipping `@cypher` computed fields.
- `model-map-emitter.ts` adds `Sort: <Type>Sort;` to every `ModelMap` and `InterfaceModelMap` entry.

### Notes & Limits

- **Type-only breaking change**: code that previously compiled with invalid sort field names (e.g. typos) will now produce TypeScript errors after upgrading. This is the intended behavior — runtime semantics are unchanged. If you need the loose typing temporarily during migration, cast at the call site: `sort: [{ field: 'ASC' } as Record<string, 'ASC' | 'DESC'>]`.
- No runtime changes: Cypher generation, parameter binding, and execution paths are byte-for-byte identical to v1.3.1.
- Backwards compatible at the JS level: callers using `ogm.model<T>(name)` (single-generic overload) or `Model` without explicit type args continue to receive the loose `Record<string, 'ASC' | 'DESC'>` shape via the default.

## 1.3.1 (2026-04-21)

### Bug Fixes

- **`$param0` collision in mutations with projected relationships** — `create()`, `update()`, and `upsert()` compiled the RETURN-clause projection with a fresh `paramCounter` starting at `0`. If the projection contained a relationship-`where` or a connection-`where` on a scalar filter, the selection compiler would allocate `$param0` and silently clobber the outer WHERE's `$param0` (already present in the mutation params). Symptom: `MATCH (n:Label) WHERE n.id = $param0` would run against the selection's value instead of the caller's — the match returned zero rows and the mutation appeared to succeed against nothing. The fix threads a single `paramCounter` through `applySelect*To*` / `applySelectionSet*To*` helpers so outer WHERE params and inner selection params share one namespace. No API change; behavior is purely additive for callers that were unaffected.

### Features

- **`@vector` directive** — spec-compatible vector index support on `@node` types. Mirrors the official `@neo4j/graphql` shape: `@vector(indexes: [{ indexName, queryName, embeddingProperty, provider? }])`. The directive is parsed into a `VectorIndex[]` on each `NodeDefinition` and powers two new typed query methods.
- **`Model.searchByVector()`** — top-k vector similarity search against a Neo4j vector index. Accepts a pre-computed `number[]` embedding, a user-supplied `where` filter, and any selection mode (`select` or `selectionSet`). Compiles to `CALL db.index.vector.queryNodes(...)` with `k` clamped to `[1, 1000]` and returns `Array<{ node, score }>`.
- **`Model.searchByPhrase()`** — phrase-based vector search via the Neo4j GenAI plugin. The matching `@vector` index must have `provider` set. Accepts a `phrase` plus a runtime `providerConfig` (e.g. `{ token: process.env.OPENAI_API_KEY }`) so API credentials stay out of the schema. Compiles to `CALL genai.vector.encode(...)` chained into `db.index.vector.queryNodes(...)`.
- **Typed vector result / input types** — the code generator emits `<Node>VectorResult`, `<Node>VectorSearchByVectorInput`, and (when at least one index has `provider` set) `<Node>VectorSearchByPhraseInput`. Index names become a literal-string union for autocomplete and typo-checking. The generated `<Node>Model` exposes typed `searchByVector` / `searchByPhrase` signatures.

### Improvements

- **F1 — typed `<Node>FulltextInput` per node** — the fulltext emitter now emits per-node `<Node>FulltextLeaf` and `<Node>FulltextInput` types with literal-keyed index names. Typos in index names surface as TypeScript errors and IDEs autocomplete valid indexes. The generated `<Node>Model.find()` signature threads the per-node fulltext type via an `Omit<..., 'find' | ...> & { ...typed find }` wrapper. Fully backward compatible — the global `FulltextInput`, `FulltextLeaf`, and `FulltextIndexEntry` exports are unchanged for users who write generic helpers across models.

### Internal

- `ModelCompilers` extended with an optional `vector?: VectorCompiler` field. `OGM` instantiates `VectorCompiler` alongside the other compilers and injects it into every `Model`.
- Exported `VectorCompiler`, `VectorResult`, and `VectorIndex` from the package root for advanced use cases (custom query composition, testing).
- New emitter `src/generator/type-emitters/vector-emitter.ts` wired into `generateTypes`.

### Requirements

- `@vector` requires **Neo4j 5.11+** (native vector index support).
- `Model.searchByPhrase()` additionally requires the **Neo4j GenAI plugin** installed on the database. Without it, phrase search will fail at query time.
- Users must create the vector index themselves via Cypher migration (grafeo-ogm does not create vector indexes automatically in this release):
  ```cypher
  CREATE VECTOR INDEX article_content_idx FOR (n:Article) ON n.embedding
  OPTIONS { indexConfig: { 'vector.dimensions': 1536, 'vector.similarity_function': 'cosine' } }
  ```

### Notes & Limits

- **`k` is silently clamped to `[1, 1000]`** in `searchByVector` and `searchByPhrase` to prevent unbounded result sets. Requests for `k > 1000` return at most 1000 results with no runtime warning. If your workload needs a larger top-k (bulk re-ranking, recommendation retrieval), track [a future release](https://github.com/neomodular/grafeo-ogm/issues) where this will be configurable.

## 1.2.0 (2026-04-16)

### Features

- **Connection edges `orderBy`** — `*Connection` selections now accept an `orderBy` clause with `node` and `edge` scopes. Sort edges by target-node scalars or `@relationshipProperties` scalars (or mix both with priority). Compiles to `apoc.coll.sortMulti` with synthetic sort keys stripped from the projection.
- **Automatic `__typename` for abstract targets** — `__typename` is now auto-emitted into the projection when the target is a union or interface. Eliminates a footgun where TypeScript type guards silently returned `false` because the discriminator was never projected. Explicit `__typename: true` is still supported and idempotent.

### Internal Refactors

- Extracted shared `buildRelPattern()` helper to `schema/utils.ts`, eliminating three near-identical implementations across the WHERE, SELECT, and MUTATION compilers. Supports `targetLabelRaw` for pre-escaped multi-label strings.
- Replaced the hardcoded operator switch in WHERE compiler with a declarative `OPERATOR_REGISTRY` map. Adding a new scalar operator is now a single line addition with `template` and `ciAware` fields.
- Split `ModelCompilers` into `QueryCompilers` + `MutationCompilers` (ISP fix). `InterfaceModelCompilers` is now an alias for `QueryCompilers`.
- Extracted `dispatchUnionUpdateOps()` from the long `buildUpdateRelationships` method.
- Added `mergeParams()` and `isPlainObject()` utilities; replaced 27 `Object.assign(params, ...)` call sites and unsafe `as Record<...>` casts.

### Removed

- `InterfaceModel.create()`, `InterfaceModel.update()`, `InterfaceModel.delete()` — these methods always threw an error and have been removed (LSP fix). Use `ogm.model('ConcreteType')` for mutations instead.

### Security

- WHERE filter errors no longer expose internal schema target type names. Generic messages reference the user-facing field name instead.
- Invalid union member keys in WHERE filters now throw with a descriptive error listing valid members, rather than silently skipping (prevents masking user typos).

## 1.0.0 (2026-03-14)

Initial open-source release.

### Features

- GraphQL SDL schema parsing with Neo4j directives (`@node`, `@relationship`, `@fulltext`, `@cypher`, `@id`, `@unique`, `@default`)
- Type-safe CRUD operations (`find`, `create`, `update`, `delete`, `count`, `aggregate`)
- Cypher query compilation (WHERE, SELECT, MUTATION, FULLTEXT compilers)
- Selection set support with nested relationship traversal
- Rich where filters: comparison, string, relationship existence, logical operators
- Fulltext search with scoring
- Nested mutations (create, connect, disconnect, delete related nodes)
- Transaction support (`$transaction`)
- Raw Cypher execution (`$queryRaw`, `$executeRaw`)
- Interface model support for polymorphic queries
- Union type support for relationships
- Multi-label node support
- TypeScript code generation from GraphQL schema (`generateTypes`)
- Configurable package name in generated imports
- Testing utilities (`CypherAssert`, `Neo4jRecordFactory`, `SelectionSetFactory`)
