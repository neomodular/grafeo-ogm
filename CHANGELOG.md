# Changelog

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
