# Changelog

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
