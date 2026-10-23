# Changelog

## 2.12.4 (2026-10-23) — caches no longer shared between OGMs with different schemas

> **Patch release.** Two process-wide caches are now kept per schema. A single OGM compiles byte-identical Cypher and keeps its cache hit rate. Generated types are unchanged.

### Fixed

- **Two OGMs with different schemas in one process could read each other's cached definitions (since v1.0.0).** The resolved-definition cache for interface and union targets was keyed by type name only, so an interface resolved by one OGM was served to another OGM whose interface of the same name had different fields: a `String` field could be checked as the other schema's `Int` (`Expected an integer …`), and typed `select` could warn about (or, under `strict: true`, reject) a field that exists. It is now kept per parsed schema.
- **The `selectionSet` parse cache was shared by every OGM in the process (since v2.6.0).** A selection parsed against one OGM's schema was reused by another, so the duplicate-field conflict check and its warning (strict item 9) were decided by the first OGM's schema. It is now kept per parsed schema, with the same 500-entry cap per schema.

## 2.12.3 (2026-10-23) — `count` restrictives are enforced

> **Security patch.** A policy restrictive that lists `count` now applies to `count()`. Policy sets with no restrictive listing `count` compile to byte-identical Cypher, and OGMs without `policies` are unaffected. Generated types are unchanged.

### Security

- **Restrictives that listed only `count` were never enforced (medium).** `Model.count` and `InterfaceModel.count` run through the aggregate path, which resolves the `aggregate` policies and falls back to `read`, and never looked at `count`. So `restrictive({ operations: ['count'], … })` was ignored and `count()` returned the size of a set the restrictive was meant to narrow. `count()` now resolves exactly as before (`aggregate`, falling back to `read`: permissives, overrides, default deny and the `onDeny: 'throw'` pre-check are unchanged) and then ANDs in every restrictive that lists `count`. A restrictive already applied by that resolution (for example `['read', 'count']`) is not added twice. On `InterfaceModel`, this happens in each implementer's branch, and an interface-level `count` restrictive reaches every implementer. `aggregate({ aggregate: { count: true } })`, `<rel>Aggregate { count }` and connection `totalCount` keep following the `aggregate` / `read` policies. Present since policies shipped in 1.7.0; affects 1.7.0 through 2.12.2.

### Behavior change

- With a restrictive that lists `count`, `count()` returns only the rows that restrictive admits. On `Model.count`, the applied `count` restrictives are also listed in `policiesEvaluated`; `InterfaceModel.count` metadata is unchanged.

### Deprecations

- **`count-permissive-ignored`** (logged once per OGM and policy, in default mode): a permissive that lists `count` but not `read`, `aggregate` or `*` grants nothing to `count()`, which takes its permissives from `aggregate`, falling back to `read`, as it always has. 2.x keeps it that way, since honouring it could return rows that are denied today.

## 2.12.2 (2026-10-23) — `where` depth limit counts relationship and connection hops

> **Security patch.** The `where` nesting limit (10) now counts relationship and connection hops as well as `AND` / `OR` / `NOT` levels, on every path that compiles a filter. Every filter within the limit compiles to byte-identical Cypher. Generated types are unchanged.

### Security

- **Deeply nested relationship filters could crash the compiler or stall the database (medium, denial of service).** The `where` depth limit counted only `AND` / `OR` / `NOT` nesting, and every relationship or connection hop (`_SOME` / `_NONE` / `_ALL` / `_SINGLE`, `<rel>Connection_*`, union member keys) restarted it; filters inside a connection input had no limit at all. A filter about 1,000 hops deep threw a raw `RangeError: Maximum call stack size exceeded`, and much shallower ones were expensive for the server: on Neo4j 5.26 the planner alone takes ~50 ms at 10 hops, ~200 ms at 14 and ~9 s at 20, and execution grows with the fan-out at each hop. Node-Level Security adds a policy clause at every hop. Anyone who can pass a `where` to the OGM could send one.

  One limit now covers the whole filter: each `AND` / `OR` / `NOT` level and each relationship or connection hop counts one, up to 10. A connection's `node` / `node_NOT` / `edge` and a union or interface member key belong to the hop they are in and cost nothing extra; policy clauses count at the depth of the node they apply to. The check runs before each level is compiled, at every entry point: root reads and writes, nested selection, connection and `<rel>Aggregate` filters, fulltext / vector `where`, `InterfaceModel`, `explainPolicies`, policy `when` partials, and nested connect / disconnect / update / delete `where`. Past the limit the call throws `OGMError` before anything is sent to the database.

### Behavior change

- A `where` whose relationship / connection hops plus `AND` / `OR` / `NOT` levels exceed 10 now throws `OGMError` (`WHERE clause nesting depth exceeds maximum (10)`). Filters that use only `AND` / `OR` / `NOT` keep exactly their previous limit. Flatten the filter or split the query.

## 2.12.1 (2026-10-23) — policy `cypher:` params no longer collide across types

> **Security patch.** Policies that use the raw `cypher:` form now get statement-unique parameter names. OGMs without `policies` compile to byte-identical Cypher. Generated types are unchanged.

### Security

- **A policy's raw `cypher:` params could be overwritten by another type's policy in the same statement (medium).** A policy's `cypher: { fragment, params }` binds its params under `policy_p<N>_<key>`. `N` restarted at 0 in every compile frame (root where, nested selection, connection, `_SOME` / `_NONE` / `_ALL` / `_SINGLE` traversal, nested write target, relabel guard, `InterfaceModel` member), so two types whose policies used the same raw key (`$v`) both bound `$policy_p0_v`, and the value compiled last silently replaced the other in the shared params. With a nested selection over type B, root type A's restrictive was evaluated with B's value: rows A allows disappeared and rows A hides were returned. A `_SOME` filter admitted rows through related nodes the context cannot read (an existence oracle), and an `update … connect` filter admitted targets the context cannot read. The prefix index is now drawn from the statement-wide parameter counter (the one behind `param<N>` / `sel_param<N>`), so no two policy clauses in a statement share a name. Only applications whose policies use the raw `cypher:` form with the same param key in more than one type reached by one statement are affected; `when:` policies were never at risk. Present since policies shipped in 1.7.0; affects 1.7.0 through 2.12.0.

### Behavior change

- In statements with policies, the index in `policy_p<N>_<key>` parameter names now follows the statement's parameter counter, so it can differ from 2.12.0 when a user `where` or another policy clause precedes it (visible in `explainPolicies` output and in logged Cypher). Results change only where names collided before.

## 2.12.0 (2026-10-23) — union member where in selections and connection filters

> **Minor release.** A union member key in a `where` (`{ Doc: { rank: 2 } }`) now filters by that member everywhere, in default and strict mode alike. Before, it worked only in a root `<rel>_SOME` / `_NONE` / `_ALL` / `_SINGLE` filter and was compiled as a node property everywhere else. Every union where input that already worked compiles to byte-identical Cypher. Generated types are unchanged.

### Fixed

- **A union member key in a `where` was compiled as a node property (`n0.Doc = $param`, never true).** This hit the nested selection `where` (typed `select` and `selectionSet`), a connection `{ node | node_NOT: { Doc: … } }` in a selection (`edges`, `totalCount`) and in a root `<rel>Connection*` filter, and `<rel>Aggregate(where)`. Lists were always empty, `_SOME` / `_SINGLE` matched nothing, and `_NONE` / `_NOT` / `_ALL` matched every row. The `@neo4j/graphql` member-keyed connection shape `{ Doc: { node, node_NOT, edge, … } }` was ignored in a root filter (it matched every row with any related node) and compiled as a property in a selection. Each member key now compiles as `(v:Doc AND <Doc filter>)`, OR-combined across members as a root `<rel>_SOME` already did. Each member's `read` policy is applied outside any negation, so a node the context cannot read never satisfies or falsifies a filter. Interface targets are not affected.

### Behavior changes

These inputs could only ever return always-empty or always-everything results, so they now filter as documented (`items: [Post | Doc]`, filtering on `Doc`):

| Input | Before | Now |
|---|---|---|
| nested `items(where: { Doc: … })` (typed `select` or `selectionSet`) | always `[]` | the matching items |
| selection `itemsConnection(where: { node: { Doc: … } })`, or `{ Doc: { node: … } }` | `edges: []`, `totalCount: 0` | the matching edges and count |
| selection `itemsConnection(where: { node_NOT: { Doc: … } })` | `totalCount: 0` | the count of items that don't match |
| `itemsAggregate(where: { Doc: … })` | `count: 0` | the matching count |
| root `itemsConnection` / `_SOME` / `_SINGLE` with `{ node: { Doc: … } }` | matched no row | rows with a matching item |
| root `itemsConnection_NONE` / `_NOT` / `_ALL` with `{ node: { Doc: … } }` | matched every row | rows with no matching item / whose items all match |
| root `itemsConnection_SOME` / `_NONE` with `{ Doc: { node: … } }` | ignored (any item / no item) | filtered by the member's node filter |

Root `items_SOME` / `_NONE` / `_ALL` / `_SINGLE` member keys, shared union fields, non-union and interface targets are unchanged, pinned byte for byte in default and strict mode, with and without policies.

## 2.11.0 (2026-10-23) — `@node(labels)` as in `@neo4j/graphql`

> **Minor release.** A type whose `@node(labels: [...])` is not just its own name warns once by default and, under `strict: true` (strict item 23), uses the listed labels **instead of** the type name, as `@neo4j/graphql` does. Without `strict`, every input that worked in 2.10.1 compiles to byte-identical Cypher. Generated types are unchanged.

### Strict mode

- **`@node(labels: [...])` replaces the type name.** In `@neo4j/graphql` the listed labels are used instead of the type name: reads match all of them, creates write exactly them, and constraints and indexes go on the first one. 2.x matches the type name, creates the type name plus the listed labels, and puts constraints, fulltext and vector indexes on the type name, so nodes written by `@neo4j/graphql` (`:Human` for `type Person @node(labels: ["Human"])`) were invisible to grafeo-ogm. Strict follows upstream everywhere a node's label is used:
  - root reads and writes, `upsert`, `createMany`, `setLabels`, cascade delete;
  - relationship targets: selections, connections, `<rel>Aggregate`, filters, connect / disconnect, nested create;
  - interface and union members (`MATCH (n:((K9&Pet)|Cat))`, per-member policy predicates); `__typename` stays the GraphQL type name, told apart by label set in declaration order;
  - `db push` / `assertIndexesAndConstraints`: constraints and indexes on the first listed label.

  The runtime `labels` argument is still added on top. `$jwt` / `$context` placeholders in `labels` are not supported: strict throws `OGMError` when the OGM is built.
- **`db push --strict`** (or `strict: true` in `grafeo.config.*`) plans constraints and indexes the way `new OGM({ strict: true })` uses the labels. `db push` has no OGM to read `strict` from, so set it to the same value as your OGM. Without it, push keeps planning on the type name and warns for each affected type.

  **Switching is a data migration**: nodes grafeo-ogm created carry the extra type-name label, and `db push --strict` reports the old `Person_id_unique` as an orphan. The README (Strict mode, item 23) gives the uniqueness check to run before pushing and the optional relabel.

### Deprecations

- **`node-labels-upstream`** (logged once per OGM and type whose `@node(labels)` is not just its own name): the type name is matched and added on create, and constraints go on the type name. 3.0 uses the listed labels instead, as `strict: true` does today.

## 2.10.1 (2026-10-23) — runtime labels follow the policies of the type they name

> **Security patch.** A runtime label that names another declared node type now runs that type's policies. OGMs without `policies` (or under a bypass) compile to byte-identical Cypher, and labels that no declared type carries are unchanged. Generated types are unchanged.

### Security

- **Runtime labels bypassed the Node-Level Security policies of the type they named (high).** `create`, `createMany` and `upsert` take `labels`, and `setLabels` takes `addLabels` / `removeLabels`. These labels were only validated as identifiers, and only the root model's policies ran. A label that another declared type carries therefore put the node into that type without any of its policies:
  - `Public.create({ labels: ['Secret'], … })` forged a `Secret` owned by someone else, past `Secret`'s `create` policy and `WITH CHECK`;
  - `setLabels({ addLabels: ['Secret'] })` converted the caller's own row into a `Secret`;
  - a context that could update a `Secret` but not read it relabelled it into an unprotected type and read it there.

  A runtime label now follows the nested-write principle: the write enforces what the equivalent direct write on that type would.
  - **Adding** a declared type's label is a `create` on that type: default deny plus `WITH CHECK` on each input (for `upsert`, the create input and, in default mode, the update input; `setLabels` carries no properties, so it is checked as an empty input).
  - **Relabelling an existing node** (`setLabels`, and the matched-node path of a default-mode `upsert` / `createMany({ skipDuplicates: true })`) also requires the root type's `read` row filter beside its `update` filter, because the node becomes reachable through the other type's model.
  - **Removing** a declared type's label is a `delete` on that type: its `delete` row filter applies.

  The label-triggered policies are listed in `policiesEvaluated`. Present since policies shipped in 1.7.0 (confirmed on 1.7.0); affects 1.7.0 through 2.10.0.

### Behavior change

- With `policies` configured, a write whose runtime labels add or remove a declared type's label now needs that type's `create` / `delete` policy (and, for a relabel, the root type's `read` policy). Without a matching permissive the write is denied, exactly as the equivalent direct write on that type would be. Writes whose labels name no declared type behave exactly as in 2.10.0.

## 2.10.0 (2026-10-22) — unknown keys in nested write inputs

> **Minor release.** Unknown keys in nested write inputs warn by default and throw under `strict: true` (strict item 22). Without `strict`, every input that worked in 2.9.1 compiles to byte-identical Cypher. Generated types are unchanged.

### Strict mode

- **Unknown keys in nested write inputs throw `OGMError`** before anything runs. Before 2.10.0 these objects were compiled from a fixed set of keys and any other key was ignored, even under `strict: true`. A typo'd `wher` in a nested update item left the item's `update` unfiltered, so it renamed **every** related node. `updat`, `creat`, an `egde` next to `node`, and a node field next to `edge` in a nested `update` were dropped. Strict checks each shape, at any depth and per union / interface member, against the keys of its generated input type:
  - **nested update item:** `where`, `update`, `connect`, `disconnect`, `create`, `delete`
  - **relationship field in `create()` or in a nested create's `node`:** `create`, `connect`
  - **nested create item with `node`:** `node`, `edge`
  - **an item's `update` with `node` or `edge`:** `node`, `edge`

  Connect / disconnect items keep their item 1 check.

### Deprecations

- **`nested-write-unknown-key`** (logged once per OGM, input shape, field and key set): the unknown key is ignored. When a nested update item has `update` but no `where`, the warning says that the update reaches every related node. 3.0 throws, as `strict: true` does today.

## 2.9.1 (2026-10-22) — native Node ESM entry points

> **Patch release.** `import { OGM } from 'grafeo-ogm'` now works in native Node ESM. The CommonJS build and the public API are unchanged.

### Fixed

- **The ESM entry points could not be imported from native Node ESM (since v1.0.0).** The ESM build wrote extensionless relative imports (`export { OGM } from './ogm'`) into a `"type": "module"` tree, so `import … from 'grafeo-ogm'` and `'grafeo-ogm/testing'` threw `ERR_MODULE_NOT_FOUND` in `.mjs` files and `"type": "module"` apps, and a TypeScript `module: nodenext` consumer silently typed every export as `any`. `require()` and bundlers were not affected.
  - **Node:** the `import` condition now resolves to thin ESM wrappers over the CommonJS build (`dist/node/*.mjs`, under a `node` condition), so `import` and `require` load one copy of the library: `instanceof OGMError`, `Executor.debug` and the compiler caches are shared.
  - **Bundlers:** the `dist/esm` build keeps every relative import fully specified (`./ogm.js`, `./testing/index.js`), in the `.js` and `.d.ts` files, so webpack's `fullySpecified` mode and TypeScript `nodenext` resolve it. Bundlers that apply the `node` condition for server builds (esbuild `platform=node`, Vite SSR) now get the CommonJS build through the wrapper.
  - `tests/package-esm-entry.spec.ts` builds the package, installs it into a throwaway `"type": "module"` app and checks both entry points against `require()`, plus a `nodenext` type-check.

## 2.9.0 (2026-10-22) — update op order, union connections and record-factory time zones

> **Minor release.** Three behaviours that differed from `@neo4j/graphql` 5.x or from the Neo4j driver warn by default and are corrected under `strict: true`: the op order of `update()` (within a nested update item and at the root), a `<rel>Connection` selected under a union, and `Neo4jRecordFactory.dateTime` time-zone strings (its own `{ strict: true }` option). Without `strict`, every input that worked in 2.8.0 compiles to byte-identical Cypher. Generated types are unchanged.

### Fixed

- **`Neo4jRecordFactory.dateTime` reads the time-zone strings that threw before**, in both modes, as Neo4j 5.26 reads them: `[Z]` / `[z]` / `Z[Z]` are offset 0 with no zone id, and an hour without minutes (`2024-01-01T10+01:00`) is read. No input that worked in 2.8.0 returns a different value by default.

### Documentation

- **The nested update item op order was documented wrongly since v2.4.2.** The README said an item runs "as in `@neo4j/graphql`": `delete`, `disconnect`, `connect`, `create`, `update`. `@neo4j/graphql` 5.x runs `delete`, `disconnect`, `update`, `connect`, `create`, so in 2.x an item's `update` also matches the nodes its own `connect` / `create` just linked. At the root, 2.x runs the root `disconnect` after the `update` body; `@neo4j/graphql` runs it before. The README, `CLAUDE.md` and the test comment now state the real order and how to get the upstream one.

### Strict mode

- **Op order in `update()`** follows `@neo4j/graphql` 5.x at both levels. Within a nested update item: `delete`, `disconnect`, `update`, `connect`, `create`, so the item's `update` touches only the relationships that existed before it. At the root: the root `disconnect` runs first, then the `update` body, then the root `connect`, so a blanket root `disconnect` no longer removes what a nested `create` / `connect` just added, and a nested `delete` no longer reaches a node the root `disconnect` unlinked. Items still run in array order.
- **A `<rel>Connection` selected under a union is read per member.** Each member whose relationship differs from the first declaring member's (type, direction, target or edge-properties type) gets its own branch, compiled against its own relationship and AND-ed with its target's `read` policy, in `edges`, `totalCount` and `pageInfo`, through the typed `select` and `selectionSet` fragments alike. An argument a member's relationship cannot take throws `OGMError`. Unions whose members share one relationship are not affected.
- **`Neo4jRecordFactory.dateTime(iso, { strict: true })`** builds exactly what the driver returns for `datetime(iso)` on Neo4j 5.26. It throws where Neo4j rejects the string (an offset the zone does not have at that wall time, including any offset inside a DST gap; an offset outside ±18:00 or with minutes over 59; a zone id java.time lacks, such as `EST`, `GMT+0` or `[+05:00]`; a date with an offset or zone but no time) and spells zone ids as Neo4j does (`[us/eastern]` gives `US/Eastern`). `Neo4jRecordFactory` is a static helper with no OGM instance, so it takes its own option.

### Deprecations

Each of these warns in 2.x and becomes the default in 3.0, as the strict behaviour above does today:

- **`nested-update-op-order`** (logged for a nested update item with `update` together with `connect` or `create`): the item's `update` runs after its `connect` / `create`. 3.0 runs it before them.
- **`update-op-order`** (logged when the root `disconnect` names a relationship type that a nested `update`, `connect`, `create` or `delete` also writes): the root `disconnect` runs after the `update` body. 3.0 runs it first.
- **`select-union-connection`** (logged once per union field whose members' relationships differ): every member is read through the first declaring member's relationship. 3.0 reads each member through its own.
- **`Neo4jRecordFactory.dateTime` time-zone strings** keep their 2.8.0 value and emit one `DeprecationWarning` per kind through `process.emitWarning`, with code `GRAFEO_RECORD_FACTORY_ZONE_OFFSET_MISMATCH`, `GRAFEO_RECORD_FACTORY_OFFSET_RANGE`, `GRAFEO_RECORD_FACTORY_ZONE_ID_UNSUPPORTED`, `GRAFEO_RECORD_FACTORY_ZONE_ID_CASE` or `GRAFEO_RECORD_FACTORY_DATE_ONLY_ZONE`. 3.0 throws for a zone/offset mismatch, an offset out of range, an unsupported zone id and a date-only zone, and returns Neo4j's spelling for `_ZONE_ID_CASE`, as `{ strict: true }` does.

## 2.8.0 (2026-10-19) — connection pageInfo, nested-write and read-input fixes

> **Minor release.** Connections now return `pageInfo` and edge `cursor`. A nested `delete` that reaches the node being updated through a cycle no longer fails the call when the OGM owns the transaction. Five inputs that were accepted but ignored (`overwrite: false`, relationship-property `@default`, fields selected in the wrong shape, unknown `pageInfo` fields, typed `where` / `orderBy` under a union) warn by default and are honoured under `strict: true`. Without `strict`, every input that worked in 2.7.0 compiles to byte-identical Cypher.

### Added

- **Connection `pageInfo` and edge `cursor`**, in a `selectionSet` and in the typed `select` (`pageInfo: true | { select: { hasNextPage?, hasPreviousPage?, startCursor?, endCursor? } }`, `edges: { cursor: true }`). They follow `@neo4j/graphql` 5.x for a connection read without `first` / `after`:
  - **`cursor`:** `offsetToCursor(<offset>)`, base64 of `arrayconnection:<offset>` within the filtered, sorted list.
  - **`pageInfo`:** `hasNextPage` / `hasPreviousPage` are `false`; `startCursor` / `endCursor` are the first / last edge's cursors, `null` with no edge.
  - **Policies:** both count the same list as `edges` and `totalCount`, so the connection `where` and the target's `read` policy apply.
  - **Where it works:** root, nested and fragment connections, aliases, `__typename` and sorted connections.
- **Generated types:** the connection `SelectFields` gain the optional `pageInfo` and edge `cursor` members. Nothing is removed or made required.

### Fixed

- **A nested `delete` that removes a node the update still holds no longer fails the call** when the OGM owns the transaction (auto-commit, or a caller `session`). With a cycle such as chart → tags → charts, a later clause that read or wrote the deleted node (the `update` response, a nested `create` or `connect` from it) made the server reject the statement with `Neo.ClientError.Statement.EntityNotFound`. The OGM now re-runs that statement once with the deleted node's remaining writes skipped, so `update` returns the surviving roots. The first attempt still compiles to the 2.7.0 Cypher. In a caller `transaction` the server has already rolled back, so the error is still thrown, with a one-time warning.

### Behavior changes

- **`pageInfo` and edge `cursor` now return data.** They were left out of the result before.
- **A call that failed with `EntityNotFound`** (see Fixed) now succeeds when the OGM owns the transaction.

### Strict mode

- **`overwrite: false` on a connect item leaves an existing relationship unchanged.** The item's edge values go in `ON CREATE SET`, so a missing relationship is still created with them. It applies to every connect: top-level, nested in `create` / `update`, per union or interface member, and inside another connect. Before, `MERGE … SET` overwrote the edge properties.
- **Relationship-property `@default` is applied** whenever a relationship is created without the property: nested `create` (in `create` and `update`) and the create branch of every connect (`ON CREATE SET`). An explicit `null` is kept, an existing relationship reached by a connect is left as it is, and an edge `update` never applies defaults. The generated `<Props>CreateInput` keeps the field required.
- **A nested `delete` reached through a cycle is guarded at compile time** in every transaction, caller transactions included: after it, the row continues only while the held node exists. A deleted root leaves the response and `updateMany`'s count, and its remaining nested writes are skipped.
- **Known fields selected in the wrong shape throw `OGMError`:** a scalar with a sub-selection (`name { x }`, typed `name: { select }`), a relationship or connection without one (`posts`, typed `posts: 1`), and a typed relationship object with only unknown keys. The error names the type, the field and the expected shape. Nested selections, connection `node`, edge `properties` and inline fragments are checked.
- **A typed relationship selected as `{}`** (allowed by the generated types) selects every scalar field of the target, as `true` does. Before, it was left out of the result.
- **`pageInfo` fields are checked** against `PageInfo`; `pageInfo` without a sub-selection and `cursor` with one throw.
- **Typed `select` `where` / `orderBy` on a relationship under a union are applied** per member: the `where` is compiled against the member's target and AND-ed with its `read` policy, and `orderBy` sorts as for any relationship. Before, every related node came back, unsorted.

### Deprecations

Each of these logs one warning per OGM and shape in 2.x and becomes the default in 3.0, as `strict: true` does today:

- **`overwrite: false` with `edge` values** is ignored: an existing relationship's edge properties are overwritten.
- **A relationship-property `@default`** is not applied when the relationship is created without the property.
- **`updateMany` with a nested `delete` that can reach the root through a cycle** counts a deleted root; **the same statement in a caller transaction** fails with `EntityNotFound`.
- **A known field selected in the wrong shape** (`selectionSet` or `select`) is left out of the result, or returned as `null`.
- **A typed relationship selected as `{}`** is left out of the result.
- **An unknown `pageInfo` field, `pageInfo` without a sub-selection, or `cursor` with one** is left out of the result.
- **A typed `select` `where` / `orderBy` on a relationship under a union** is ignored.

### Known limitation

- **A nested `connect` / `create` on a field an enclosing nested `update` iterates** (chart → categories → charts → categories): each row of that nested update also sees the links and nodes the earlier rows added, so the work can grow geometrically with the matched rows, and the result depends on row order. This is the per-row semantics `@neo4j/graphql` also has, and `strict` does not change it. The OGM logs one notice per shape; split the write into separate calls or narrow the nested `where`.

### Tooling

- **The allow-all-equivalence property suite** compares nodes created with a duplicate input id as a multiset, so it no longer fails intermittently on plan order (not an OGM bug).

## 2.7.0 (2026-10-19) — relationship aggregate selections and connection sort

> **Minor release.** Two compatibility features for code carried over from `@neo4j/graphql`. First, `<rel>Aggregate` selections, as `@neo4j/graphql` 5.x generated them, now work at runtime. This closes the compatibility gap behind #23: a legacy `selectionSet` such as `{ id textFieldsAggregate { count } }` used to compile with the aggregate silently left out, so code reading `.textFieldsAggregate.count` got `undefined` (a pagination total stuck at 0). Second, connection fields in a `selectionSet` accept `sort` (#25). Selections that compiled before compile to byte-identical Cypher.

### Added

- **`<rel>Aggregate` selections** (closes #23), with upstream's shape: `postsAggregate(where: …, directed: …) { count node { <field> { … } } edge { <prop> { … } } }`.
  - **Aggregates per type:** ID and String `shortest` / `longest` (plus lexicographic `min` / `max`); Int, Float and BigInt `min` / `max` / `average` / `sum`; DateTime, LocalDateTime, LocalTime, Time and Duration `min` / `max`.
  - **Values:** `average` is a float, and BigInt aggregates are strings. On an empty set `count` and `sum` are 0 and the rest are `null`. `avg` and `sum` reproduce Neo4j's functions exactly.
  - **Where it works:** root, nested at any depth, connection `node` selections, inline fragments, `InterfaceModel` and mutation responses, for concrete, interface and union targets.
  - **Policies:** an aggregate measures exactly what the same relationship selected as a list returns. That means `where`, the target's `read` policy (per member for abstract targets), and under strict mode the abstract-target member restriction. A node the context cannot read never changes any aggregate.
  - **Cypher:** pure expressions (`COUNT { }`, `reduce` over a pattern comprehension), valid on Neo4j 5.x at any depth. No APOC.
- **Typed `select`:** `postsAggregate: true | { where?, directed?, select?: { count?, node?, edge? } }`.
- **Generated types:**
  - The optional `<rel>Aggregate?: Maybe<…AggregationSelection>` field is back on node types, and is new on interface types and in their `SelectFields`.
  - The relationship aggregation selection types are no longer `@deprecated`, and their names are unchanged.
  - New field types: `IdRelationshipAggregateSelection`, `StringRelationshipAggregateSelection`, `BigIntAggregateSelection`, `LocalDateTimeAggregateSelection`, `LocalTimeAggregateSelection`, `TimeAggregateSelection`, `DurationAggregateSelection`. Interface relationships get aggregation selection types too.
- **Connection `sort` in a `selectionSet`** (closes #25), e.g. `chaptersConnection(sort: [{ edge: { position: ASC } }, { node: { title: DESC } }])`.
  - **Entries:** the same `{ node }` / `{ edge }` entries as the typed connection `orderBy`.
  - **Cypher:** the same as the typed form (`apoc.coll.sortMulti`, so it needs APOC). One implementation backs both.
  - **Where it works:** with `where`, `totalCount`, aliases, mutation responses, the `model.selectionSet` setter and `strict: true`.
  - **Invalid input throws `OGMError`:** unknown node or edge fields, an `edge` sort on a relationship without `@relationshipProperties`, a bad direction, `$variables`.
- **Clearer argument errors:** an unsupported connection argument (`first`, `after`, …) now names the typed `select` alternative, and says the argument was ignored before 2.5.0.

### Behavior changes

- **A `<rel>Aggregate { … }` field of a relationship now returns data.** It was absent before.
- **Connection `sort` in a `selectionSet` now sorts.** From 2.5.0 through 2.6.x it threw `Unsupported argument "sort"`, at assignment time when set through the `model.selectionSet` setter. Before 2.5.0 it was silently ignored. Remove the argument to keep the unsorted order.
- **It is a known field for the 2.6.3 field-name check.** It no longer warns, and no longer throws under `strict: true`. A bare `ownersAggregate` with no aggregates selected, and `<x>Aggregate` where `x` is not a relationship, are still unknown. The hint for the bare form now reads `"ownersAggregate" needs a selection of aggregates, e.g. "ownersAggregate { count }"`.
- **Generated `<…>NodeAggregateSelection` / `<…>EdgeAggregateSelection` types gain members, and none are removed.**
  - ID and String fields use the new `…RelationshipAggregateSelection` types. These are supersets of the old member types, so `min` / `max` still compile.
  - BigInt and the other temporal fields are added. Interface targets now list the interface's fields.
- **The `<rel>Aggregate` where filters stay unsupported.** Their input types stay `@deprecated`.

### Deprecations

- **The list-field members of `<…>NodeAggregateSelection` / `<…>EdgeAggregateSelection`** (e.g. `tags: StringAggregateSelection` for `tags: [String!]`) keep their v2.6.3 names and types but are `@deprecated`, and they will be removed in 3.0. List fields are not aggregated: upstream never aggregated them, and selecting one in a `<rel>Aggregate` throws `OGMError: Field "tags" ([String]) on postsAggregate.node has no aggregates: list fields are not aggregated.`

## 2.6.3 (2026-10-19) — generated types fix and selection field checks

> **Patch release.** Fixes #22 (a 2.4.8 regression) and adds the field-name check from #23 as a strict-mode item. No behaviour changes without `strict`: inputs that work today return the same results and compile to the same Cypher.

### Generated types

- **Generated types compile again when an interface's `@declareRelationship` resolves to a relationship with `properties`** (#22). Since 2.4.8 the interface's connection selection referenced `<Interface><Field>EdgeSelectFields` without emitting it (TS2552). It is now emitted, also for union targets, single relationships and interfaces that implement interfaces. Schemas without that shape generate byte-identical output.

### Strict mode

- **Selected field names are checked against the schema** (#23). An unknown field in a `selectionSet` used to be projected as a raw node property (a typo came back `null`), or silently left out when it had a sub-selection (e.g. a legacy `ownersAggregate { count }`), even with `strict: true`. The typed `select` API had the same gap. The check covers root, nested and connection `node` selections, edge `properties`, inline fragments (per type condition; interface-level fields must be on the interface), `InterfaceModel`, and create / update / upsert responses (`info { … }` is allowed). In default mode the results and Cypher are unchanged, and the OGM warns once per type and field. With `strict: true` it throws `OGMError: Unknown field "<field>" in selectionSet on type "<Type>".` A `<rel>Aggregate` field adds a pointer to `<rel>Connection { totalCount }` and `Model.aggregate()`.

### Deprecations

- **Selecting a field the type doesn't declare** (in `selectionSet` or `select`) becomes an error in 3.0, as `strict: true` does today. 2.x keeps the 2.6.2 result and Cypher and logs one warning per OGM, type and field. `<rel>Aggregate` selections are not supported in 2.6.x; use `<rel>Connection { totalCount }` or `Model.aggregate()` on the related type.

## 2.6.2 (2026-10-19) — fixes from the property suites

> **Patch release.** Fixes found by the new property-based live suites. No behaviour changes without `strict`: inputs that work today return the same results and compile to the same Cypher. Only inputs that used to be rejected now work, and one new strict-mode correction is added.

### Writes

- **Interface nested updates keyed per member were rejected.** The generated `…UpdateInput` for an interface relationship offers `{ update: { node: { Member: { … } } } }`, but the runtime threw `Unknown field "Member"`; only the flat shape worked. The per-member shape now works, with each member's own policies and nested writes. Flat inputs are unchanged.
- **Union cascade deletes keyed per member were rejected.** `delete({ delete: { items: { Member: [ … ] } } })`, as typed, threw `Unknown key "Member" in a nested delete`. It now deletes per member, with each member's `delete` policy. Flat inputs are unchanged.

### Strict mode

- **Interface / union reads now stay inside their member types under `strict: true`.** When an interface or union relationship field shares its relationship type and direction with another field (e.g. `resources: [Resource!]!` and `vaults: [Vault!]!` both on `HAS_RES`), reads through it also returned, counted and matched the other field's non-member nodes, with a `null` `__typename`. In strict mode every read path restricts the field to its members: selections, connections and `totalCount`, `_SOME` / `_NONE` / `_ALL` / `_SINGLE`, connection filters, `count` and `aggregate`. In default mode the results and Cypher are unchanged, and the OGM warns once per affected field at construction.

### Deprecations

- **Reads through an interface / union field that shares its relationship type with another field** will return only member nodes in 3.0 (`strict` behaviour). The construction-time warning reads: `Type.field (interface Target) shares relationship type "TYPE" (DIRECTION) with Type.other: reads through it also return, count and match the non-member nodes linked that way. Enable \`strict: true\` (default in 3.0) to restrict every read of an interface / union field to its member types.`

### Tooling

- **CI checks that every live suite ran, including subdirectories.** The skip guard now finds suites under `tests/integration/**`, so the property suites are covered.
- **Every property-suite case has a client-side deadline** on top of the server-side transaction timeout, so a stuck case fails instead of hanging the run.

## 2.6.1 (2026-10-18) — security fixes

> **Security patch.** Fixes two authorization bypasses in node-level security, both present since policies were introduced: `upsert` ignored the `update` row filter on an existing node, and mutation responses returned nodes the context cannot read. Both affect **1.7.0–2.6.0**. OGMs without `policies` compile the same policy-free Cypher as before. Upgrade if you use `policies`.

### Security

- **`upsert` rewrote existing nodes the context could not update (high).** The MERGE put the `update` input in `ON MATCH SET` with no policy predicate. Only the update `WITH CHECK` restrictives ran, at the application layer. So a context for which a direct `update` matched 0 rows could still rewrite the node through `upsert`, including the owner field that the `update` policy keys on, and so take ownership of it. With `policies: { Chart: [permissive({ operations: ['update'], when: (c) => ({ ownerId: c.uid }) })] }`, user `u1` could run `Chart.upsert({ where: { id: 'c2' }, create: {…}, update: { ownerId: 'u1' } })` on a chart owned by `u2` and become its owner. The MERGE now applies the type's `update` row filter to the node it matches. That is the same clause a direct `update` puts in its `WHERE`: the applicable `update` permissives OR-ed (inherited interface policies included), and `false` when none applies. The update `WITH CHECK` still runs on the input. `createMany({ skipDuplicates: true, labels })` had the same gap in default mode: the runtime `labels` were `SET` on every existing node the MERGE matched. A matched node is now relabelled only when it passes the `update` row filter (a label change is an update, as `setLabels` enforces). Introduced with policies in 1.7.0 (`90ef75e`, v1.7.0-beta.0), where the upsert MERGE carried no row predicate.
- **Mutation responses returned nodes the context cannot read (medium).** `create`, `update` and `upsert` returned every node they wrote. Nested selections were filtered by their target types' `read` policies, but the root node was not. A context that could update a node, but whose `read` policy hid it, got the whole node back, including the fields `find` withholds. `update({ where: { id }, update: {} })` was enough to read it. A context that could create a node its read policy hides got it back the same way. The response projection now applies the root type's `read` policy to each node in its post-write state, just as `find` would filter it. Writes are unchanged: an `update` still needs only the `update` policy, as documented for nested writes. Present since 1.7.0, whose mutation projections passed the `read` bundle to nested selections only.

### Behavior change

- **`upsert` on an existing node** is now updated only when the node passes the type's `update` row filter. If it fails the filter, nothing is written (no update and no create) and `upsert` returns `null`, as a direct `update` that matches 0 rows returns no row. The create path (no node matches) is unchanged, and the matched node does not need to be readable, as with `update`. Under `policyDefaults: { onDeny: 'throw' }`, `upsert` still throws `PolicyDeniedError` before compile when no `update` permissive applies, as `update` does. **`createMany({ skipDuplicates: true, labels })`** in default mode no longer relabels existing nodes that fail the `update` row filter. It never throws for this, because the call is a create. Types without an `update` policy, overrides and bypasses compile the MERGE exactly as before.
- **Mutation responses** leave out every node the context cannot read after the write. It is missing from `create` / `update`'s `<plural>` array, and `upsert` returns `null`. The write still lands, and `info` counters still count it. Types without a `read` policy, overrides and bypasses compile exactly as before.

## 2.6.0 (2026-10-18) — strict mode

> **Minor release.** It adds an opt-in `strict` mode with the corrected behaviour for input shapes that 2.x compiles in surprising ways. **There are no behaviour changes without `strict`.** With `strict` unset or `false`, every input compiles to the same Cypher as in 2.5.4 and returns the same results. The one exception is the aggregate fix under Fixes, where a query that used to crash now returns `null` for the affected keys. Apart from that, the only difference is the deprecation warnings described below. Generated types are unchanged.

### Added

- **`new OGM({ …, strict: true })`.** A new optional `OGMConfig.strict` field. It defaults to `false` and **becomes the default in 3.0**. Strict mode switches on the corrected behaviour for every item under Deprecations: the shape either throws `OGMError` or compiles to what the input means. See the README "Strict mode" section.
- **Deprecation warnings.** With `strict` off, the OGM logs one `warn` through its `logger` the first time an instance meets each shape. Each is logged once per OGM instance and message key, so hot paths don't spam. Every warning has the form `[OGM] <problem> Enable \`strict: true\` (default in 3.0) to <fix>.`

### Notes

- **Default mode now logs one-time deprecation warnings** through the configured `logger` (`logger.warn`). This includes the construction-time warning for relationship fields that share a type and direction (Deprecations item 4), which fires in `new OGM(...)` without any query. Tests that assert `logger.warn` is never called may now see these warnings. Fix the flagged shape, or turn on `strict: true`. An OGM without a `logger`, or whose logger has no `warn`, logs nothing.

### Fixes

- **`aggregate` on a list field (`[Int]`, `[Float]`) failed the whole query.** It emitted `avg` / `sum` over a list, and the server rejected that (`AVG(...) can only handle numerical values, duration, or null`). In both modes, those keys now come back `null` and the rest of the aggregate works. The same applies to `InterfaceModel.aggregate`. Generated types are unchanged.

### Deprecations (the behaviour 3.0 flips; `strict: true` gives it now)

Each entry lists the 2.x behaviour, the warning you will see, and what `strict: true` does instead.

1. **Unknown keys in a connect / disconnect item are ignored.** A typo such as `{ wehre: … }` leaves the item with no filter: a connect links every target node, and a disconnect unlinks every related node.
   - Warning: `Unknown key(s) "wehre" in a connect item on "pets" is ignored; with no "where", the item connects EVERY "Pet" node. Allowed: "where", "edge", "overwrite", "connect".` A disconnect gets the same warning, ending in `unlinks EVERY related "Pet" node` with allowed keys `"where", "disconnect"`.
   - Strict: throws `OGMError`.
   - Connect-all `[{}]` and the blanket disconnect `null` / `{}` are not affected.
2. **Unknown `edge` keys are stored as stray relationship properties.** This covers connect, nested create and nested update.
   - Warning: `Unknown field "rolee" in the edge input of "posts" is not a property of the relationship properties type "Wrote"; it is written to the relationship as a stray property.`
   - Strict: throws `Unknown field "rolee" in the edge input (…) of "posts" …`.
3. **`upsert` with several unique keys in `where` can create a duplicate.** MERGE matches all the keys together.
   - Warning: `upsert on User with several unique keys in "where" ("id", "email") MERGEs on all of them together: a node that has one but not the others is not matched and a duplicate is created.`
   - Strict: throws unless exactly one `@id` / `@unique` key is given.
4. **A blanket disconnect on a shared relationship type over-reaches.** With `pets: [Pet]` and `toys: [Toy]` both on `HAS`, `disconnect: { pets: null }` also unlinks the toys.
   - Warning, logged once per field pair when the OGM is constructed: `User.pets (Pet) and User.toys (Toy) share relationship type "HAS" (OUT): a blanket disconnect (null / {}) on either also unlinks the other's nodes.`
   - Strict: the blanket disconnect binds the field's own target label. For interface / union targets it binds the member labels.
5. **`labels` on `upsert` / `createMany({ skipDuplicates })` relabel matched existing nodes.**
   - Warning: `"labels" on upsert (User) are added to every node the MERGE returns, so an existing node it matched is relabelled too.` The same warning is logged for `createMany with skipDuplicates`.
   - Strict: the labels go in `ON CREATE SET`, so only newly created nodes get them.
6. **A fulltext `score` inside `OR` / `AND` / `NOT` is ignored.**
   - Warning: `A fulltext \`score\` inside OR / AND / NOT (on Book) is ignored in 2.x: only a top-level fulltext entry's score filters results.`
   - Strict: the threshold applies to its own branch.
7. **`@include` / `@skip` in a `selectionSet` are ignored.**
   - Warning: `@include / @skip on "title" in a selectionSet is ignored in 2.x: the selection is always kept.`
   - Strict: honoured for a literal `if: true | false`. A `$variable` or a missing or non-boolean `if` throws.
8. **`mode: 'insensitive'` does not apply to `_IN` / `_NOT_IN`.**
   - Warning: `` `mode: 'insensitive'` does not apply to `title_IN`: _IN / _NOT_IN compare case-sensitively in 2.x. ``
   - Strict: both sides are compared lowercased. This applies to String fields only.
9. **The same response key selected twice with different arguments keeps the first selection.**
   - Warning: `The selectionSet selects "reviews" twice with different arguments; 2.x keeps the first selection and drops the second.`
   - Strict: throws `Fields "reviews" conflict because they have differing arguments. Use different aliases on the fields to fetch both.`
   - Only selections that can apply to the same object conflict. That is the case when either one is outside any fragment, or when their fragment types share a concrete type; interface and union conditions expand to their members. Fragments on disjoint types (`... on Dog { pals(where: A) }` and `... on Cat { pals(where: B) }`) are valid GraphQL: they never warn and never throw. In strict mode each type gets its own arguments; by default the first selection is used for both, as before.
10. **Differently aliased `edges`, `node` or `properties` in one connection keep only the first key.**
    - Warning: `"reviewsConnection" selects \`edges\` under two response keys ("a", "b"); 2.x returns only "a", with both selections merged into it.` Inside one `edges`, the warning reads `"reviewsConnection" selects \`node\` under two response keys ("a", "b") in its edges; …` (likewise for `properties`).
    - Strict: each key is returned with its own selection.

## 2.5.4 (2026-10-18) — security fix

> **Security patch.** Fixes an authorization bypass in node-level security for nodes that carry the labels of two or more implementers of the same interface or union. Affects **1.7.0–2.5.3** for `InterfaceModel` reads (`find`, `findFirst`, `findUnique`, `count`, `aggregate`) and **2.3.0–2.5.3** for interface / union relationship targets (nested selections, traversal filters, `connect` / `disconnect` and nested writes). OGMs without `policies` compile the same policy-free Cypher as before. Upgrade if you use `policies`.

### Security

- **A node carrying two implementer labels was admitted under the laxer member's policy.** The policy for an abstract (interface / union) type was a first-match `CASE WHEN n:A THEN <A's policy> WHEN n:B THEN <B's policy> ELSE false END`. A node labelled `:A:B` only had to pass A's policy, and B's policy (including its default deny) was never evaluated. So `interfaceModel('Resource').find({ labels: ['Drug'] })` returned a node that `model('Drug').find()` hides. Through a relationship, fragment `@cypher` fields (`... on B { whisper }`) and B's stored fields were also returned for that node. Nodes get several implementer labels through overlapping `@node(labels: [...])`, `create({ labels })`, `setLabels`, or data written outside the OGM. The clause is now `((n:A OR n:B) AND (NOT n:A OR <A's policy>) AND (NOT n:B OR <B's policy>))`: a node must pass the policy of every member label it carries. This applies to `InterfaceModel` reads, nested selections, traversal and connection filters, `connect` / `disconnect`, and nested update / delete targets. Each fragment `@cypher` branch is now also guarded by its member's `read` policy.

### Behavior change

- A node that carries the labels of several implementers is now returned, matched or linked only when **every** one of those members' policies admits it. Results for nodes with a single implementer label are unchanged.

## 2.5.3 (2026-10-18) — non-breaking fixes from bug scan 4

> **Patch release.** Fixes from the fourth bug scan that don't change results callers can rely on. No API changes. Only queries that errored or silently returned wrong data behave differently.

### Reads

- **The same alias on different fields in sibling fragments returned the first field for every type.** `{ ... on A { x: title } ... on B { x: body } }` (valid GraphQL) gave B rows A's `title`. Each type now projects its own field.
- **Aliases inside a connection were ignored.** `t: totalCount`, `e: edges`, `nd: node`, `pr: properties` and aliased edge properties came back under their field names. They now name the output keys.
- **A key selected twice kept only one selection's sub-fields.** `{ posts { id } posts { title } }`, its aliased form, the same field inside a fragment, and a repeated `edges { node { … } }` dropped fields. Sub-selections are now merged. Selections with different arguments keep the first one, as before.
- **Relationship fields inside an interface fragment were dropped.** `... on D { owners(where: …) { id } }` (and connection fields) silently disappeared with their arguments, on `InterfaceModel` and on nested interface relationships. They are now projected per implementer, with their arguments and the target's `read` policy.
- **List-field `_IN` / `_NOT_IN` silently matched nothing for BigInt strings and `Date`s.** The inner lists were not coerced. They now are.
- **A `@cypher` `columnName` equal to a variable in scope failed the query.** `columnName: "n"`, `"score"` (with fulltext) or `"__typename"` gave "Variable already declared". The column is now returned under a private alias.
- **`InterfaceModel.find` on an interface with no implementers was a Cypher syntax error.** It now returns its rows with a `null` `__typename`.
- **`mode: 'insensitive'` failed on non-String fields.** An Int, BigInt, Float, Boolean, Point or temporal field (scalar or list) in the same `where` was wrapped in `toLower()`. Those fields now compare as-is.
- **Nested `@cypher` fields were refused over a literal `'count('`, a comment, or `apoc.coll.max(`.** Only real aggregating calls are refused now.
- **A huge selectionSet `options.limit` / `offset` failed** with "long overflow" or a 32-bit slice error. The bounds are now clamped, and the page is unchanged.
- **Connection `select` `true` forms returned empty edges.** `xConnection: true`, `edges: true`, `node: true` and `properties: true` now select all scalars, as the generated types promise.

### Writes

- **`createMany` threw on a `null` relationship field.** It now skips it, as `upsert` does.

### Schema and codegen

- **A scalar `@default` on a list field was stored as a scalar.** It is now wrapped into a one-element list.
- **Node names that shadow an imported identifier produced a file that didn't compile.** `DocumentNode`, `ExecutionContext`, `ModelInterface`, `InterfaceModelInterface` and `SelectionSetNode` caused this. The import is now aliased in that case only, so other schemas generate byte-identical output.

### Transactions

- **The "metadata not attached" warning fired on every model call inside `$transaction`.** It now fires once per transaction, and the message says the metadata given when the transaction began is unaffected.

### Testing helpers

- **`Neo4jRecordFactory.dateTime` now matches the driver** for `-00:00`, DST gaps and overlaps, years 0–99 and BC with a zone id, and the basic format (`20240101T100000Z`).
- **`CypherAssert.assertContainsClause` cut a clause at `|`.** Label expressions (`n:A|B`) and `||` no longer end a clause; only a comprehension's `|` does.

### Examples

- Examples 09 and 12 no longer call `InterfaceModel.create`, which was removed in 1.2.0.

## 2.5.2 (2026-10-18) — security fix

> **Security patch.** Fixes an authorization bypass in nested `connect` / `disconnect` under node-level security. Affects **2.4.8–2.5.1** (the releases that support a connect nested in a connect item and a disconnect nested in a disconnect item). OGMs without `policies` are unaffected and compile byte-identical Cypher. Upgrade if you use `policies`.

### Security

- **A nested connect / disconnect could write a node the context could only read.** A `connect` nested in a connect item (`connect: { charts: [{ where, connect: { categories: [...] } }] }`) and a `disconnect` nested in a disconnect item link and unlink the *intermediate* node's own relationships. The intermediate was gated only by its `read` policy, never its `update` policy. So a context that could read a chart, but not update it, could link or unlink that chart's categories through any root it could update, while the direct `Chart.update({ connect | disconnect })` correctly did nothing. This affected `create`, `update` and `updateMany`, nested connects inside an update body item, per-member union / interface shapes, deeper chains, and blanket nested disconnects (`disconnect: { categories: null }`). The intermediate now has to pass its `update` policy before any nested connect or disconnect runs on it. The outer link or unlink still needs `read` only.

### Behavior change

- A nested connect / disconnect through a node the context can only read now links / unlinks nothing on that node. The outer link or unlink to it still happens. Under `policyDefaults: { onDeny: 'throw' }`, when no `update` permissive applies to the intermediate's type, the write throws `PolicyDeniedError` (operation `update`) before it reaches the database, as the direct update does.

## 2.5.1 (2026-10-18) — regression fixes

> **Patch release.** Fixes regressions introduced in **2.4.8** (writes) and a `db push --force-drop` bug. No API changes.

### Writes

- **`connect: { rel: null }` linked every target node.** Since 2.4.8 a `null` connect value compiled to an unfiltered `MATCH`, so `update({ connect: { tags: null } })` linked the node to **every** `Tag`. A `null` value is now a no-op, and a `null` item inside a connect list (`tags: [null]`) throws `OGMError`.
- **Sibling nested connects shared variable and parameter names.** Two connect items that each carried a nested `connect` (two siblings, or two members of a union) reused the same prefix, so a link could go to the wrong node and edge properties were overwritten by the last sibling. Each item now gets its own prefix. Nested disconnects get the same fix.
- **Nested writes through an interface relationship touched non-member nodes.** When an interface relationship (`pets: [Pet!]!`) shares its relationship type with another field (`toys`), a nested `update`, nested `delete` or cascade `delete` on `pets` also matched the `Toy` nodes on that type, renaming or **deleting** them. These now match implementor labels only, as connect and disconnect already did.

### CLI

- **`db push --force-drop` no longer drops an index it cannot recreate.** When another fulltext or vector index already held the SDL definition under a different name, push dropped the SDL-named index, the `CREATE … IF NOT EXISTS` was a silent no-op, and push still printed `✓ recreated`. Fulltext queries address the index by its SDL name, so they broke. The planner now reports the index as blocked by the equivalent one, and never drops it. A recreate that Neo4j reports as a no-op is now reported as an error rather than `✓ recreated`.

## 2.5.0 (2026-10-18) — breaking fixes from the bug scan

> **Minor release. Every item below changes behaviour that callers may depend on.** Each change fixes a confirmed bug, and the old behaviour was wrong (see each entry). The non-breaking fixes from the same scan shipped in **2.4.8**.

### Upgrade checklist

Use this to check whether you're affected. If none of these apply, 2.5.0 is a drop-in upgrade.

| If you… | Then… |
|---|---|
| use `InterfaceModel` | it now finds implementor nodes **without** the interface label, so result counts can grow (see below) |
| put arguments or aliases in `selectionSet` strings (`posts(where: …)`, `r: rank`) | they now take effect, and unsupported ones throw |
| pass non-`@id`/`@unique` keys in `upsert` `where` | they now throw |
| rely on `createMany({ skipDuplicates: true })` counting the skipped duplicates | it now returns the created count |
| write keys that aren't in the schema | they now throw `Unknown field …` |
| pass relationship fields in a later `createMany` item | they now throw |
| filter list fields with element-typed operators (`tags: 'x'`, `tags_CONTAINS`) | those no longer compile (they never matched) |
| use `CypherAssert` or `Neo4jRecordFactory.dateTime` in tests | stricter assertions may expose tests that passed by accident |
| use `cloneSubgraph` / `deleteSubgraph` | traversal is now outgoing-only by default, and the root is matched by label |

### Reads

- **`InterfaceModel` matches implementors, not the interface label.** `find`, `count` and `aggregate` used to `MATCH (n:<Interface>)`. Nodes created with `Model.create` never carry that label, so these methods found nothing for nodes the OGM itself wrote. They now `MATCH (n:(A|B|…))` over the implementors, as `@neo4j/graphql` does. Per-member policies, `__typename` and the `labels` filter work as before.
  - **What to do:** nodes carrying *only* the interface label, with no implementor label, are no longer returned; give them their concrete label. Recheck counts and pagination that depended on the old, smaller result. Listing the interface in `@node(labels: [...])` still works but is no longer needed.
- **`selectionSet` arguments and aliases take effect.** They were silently ignored, so `posts(where: …)` and `posts(options: { sort, limit, offset })` returned every related node, `r: rank` came back as `rank`, and two aliases of one field collapsed into one key. Now relationship fields honour `where` (with the target `read` policy applied) and `options` (`sort` needs APOC; `limit` and `offset` are bound parameters). Connection fields honour `where`, and aliases name the output keys.
  - **Now throw `OGMError`:** any other argument, an unknown option or sort field, `options` on a singular relationship, GraphQL `$variables`, and arguments on a field reached through a union-typed parent.
  - **What to do:** search for `selectionSet` strings with arguments or aliases. Their results now match what they ask for: filtered, paged and re-keyed.

### Writes

- **`upsert` `where` accepts only `@id` / `@unique` fields.** A plain key used to join the `MERGE` pattern, so `where: { email, name: 'Bob' }` against an existing `{ email, name: 'Alice' }` created a **duplicate** with the same email. An operator key (`name_CONTAINS`) was silently dropped, which widened the match so the **wrong row** could be updated. These now throw `OGMError`: a plain, operator, logical or unknown key, and a `null` value. At least one unique key is required.
  - **What to do:** keep only unique keys in `where` and move the other fields into `create` / `update`. For a non-unique match, use `findFirst()` followed by `create()` / `update()`.
- **Unknown keys in write input throw.** A key that is neither a property nor a relationship of the type (a typo like `nmae`) was written as a stray property, and the intended field was left unchanged. It now throws `Unknown field …`, in `create`, `update`, `updateMany`, `createMany`, `upsert`, and nested creates and updates at any depth.
  - **What to do:** declare every property you write in the schema.
- **`createMany({ skipDuplicates: true })` returns the number of nodes created.** It used to include the duplicates it skipped. It now matches Prisma. Calls without `skipDuplicates` are unchanged.
- **`createMany` rejects relationship fields in every item.** Only `data[0]` used to be checked; later items were created without their relationship input. The error names the item, e.g. `"tags" in data[1]`. Use `create()` for nested relationship writes.

### Generated types

- **List-scalar where operators are typed as lists (compile-time only).** For `tags: [String!]`, equality and `_NOT` take `Array<T>`, and `_IN` / `_NOT_IN` take `Array<Array<T>>`. String and comparison operators are no longer generated for list fields. The old element-typed forms (`{ tags: 'x' }`, `tags_CONTAINS`) compiled but **never matched**, while the working form `{ tags: ['x', 'y'] }` didn't compile. Runtime behaviour is unchanged.

### Testing helpers

- **`CypherAssert.assertContainsClause` looks for the pattern inside the clause.** The clause and the pattern were checked independently, so `assertContainsClause(q, 'WHERE', 'n { .name }')` passed when the pattern was in the `RETURN`. `'SET'` also matched `$offset`. Keywords now match whole words, outside strings, names and comments, and the pattern must sit within that clause.
- **`CypherAssert.normalize` and `assertStructurallyEqual` keep string literals and backticked names verbatim.** `'a  b'` used to equal `'a b'`, and a `$name` inside a string was renamed as a parameter.
- **`Neo4jRecordFactory.dateTime` reads an offset-less string as UTC**, as Neo4j does. It used to use the machine's local zone, so results differed between a laptop and CI. A string that isn't a date now throws a `TypeError`.

Assertions that only passed by accident will now fail.

### Subgraph operations (APOC)

- **Owned relationships are followed outgoing by default.** A bare type was expanded in **both** directions. With two books sharing a chapter, `deleteSubgraph(bookA)` climbed back up the shared chapter and **deleted book B**, `deleteSubgraph(chapter)` deleted its parent book, and `cloneSubgraph` pulled in the other parents. Now a bare `'TYPE'` is outgoing, `'<TYPE'` is incoming, and `'<TYPE>'` is both directions (the old behaviour).
  - **What to do:** mark relationships you traverse backwards as `'<TYPE'` or `'<TYPE>'`.
- **The root is matched by label, and owned nodes without an `id` are refused.** The root was matched by `id` alone, so any node with that id became a root, found by scanning every node. It's now `(:rootLabel {id})`. The new optional `SubgraphConfig.rootLabel` defaults to `ownedLabels[0]`. `cloneSubgraph` now aborts before writing anything if an owned node has no `id` or shares one with another owned node; previously those nodes collapsed onto one mapping entry.
  - **What to do:** set `rootLabel` if your root isn't of the first owned label.

Every entry above has a regression test, live wherever behaviour depends on the server. The subgraph changes are verified against Neo4j 5.26 with APOC 5.26.

## 2.4.8 (2026-10-18) — bug-scan fixes across reads, writes, codegen, CLI and testing helpers

> **A large patch release. Upgrading is safe, with no breaking changes.** Most of these bugs were found by a third, multi-area bug scan. Each fix was reproduced on Neo4j 5.26 before it was fixed, and is pinned by a regression test, live wherever behaviour depends on the server. The breaking fixes from the same scan ship separately in **2.5.0**. Cypher for queries the fixes don't touch is unchanged; the policy byte-identical suite pins this.

### Reads

- **`_SINGLE` and `Connection_SINGLE` filters work.** Every `_SINGLE` form failed on Neo4j with `Invalid input 'WHERE'`, because of an extra parenthesis around the pattern comprehension. That covered relationship, interface, union and connection filters. They now compile to `size([pattern WHERE … | x]) = 1`. The target type's `read` policy stays inside the comprehension, so `_SINGLE` counts only nodes the caller can see.
- **Relationship-index fulltext returns each node once.** A search on a relationship index returned a node once per matching relationship, which inflated `count` and made `limit` pages come up short. Results are now grouped per node with the best score. This also works inside `AND`, `OR` and `NOT`.
- **Connection `totalCount` is returned.** It was declared on connection types but always came back `undefined`. It is now the size of the same filtered comprehension `edges` uses, so it honours the connection `where` and the target `read` policy. Selecting only `totalCount` returns `{ totalCount }`, and the generated connection `SelectFields` now offer it.
- **Implementer `@cypher` fields resolve in inline fragments.** `InterfaceModel.find({ selectionSet: '{ id ... on Doc { dcount } }' })` used to return `dcount: null`. Fragment fields now project per type: `CASE WHEN n:Doc THEN … END`.
- **Typed `select` keeps scalars whose names end in `Connection`.** A scalar such as `internetConnection: String` was silently dropped. A `*Connection` key is now treated as a connection only when its base name is a relationship.
- **BigInt, DateTime and list where filters match.** These used to silently match nothing:
  - a BigInt filter given a string (its generated input type) or a `bigint`
  - a DateTime filter given a JS `Date`
  - equality, `_NOT` or `_IN` on a temporal **list** field

  Values are now bound in the stored representation. Case-insensitive mode on a list field used to emit `toLower(list)`, a Cypher type error. It now lowercases element-wise for equality and `_NOT`, and leaves `_IN` case-sensitive.
- **Nested relationship `orderBy` sorts.** `select: { friends: { select: { id: true }, orderBy: { rank: 'DESC' } } }` sorted maps that didn't contain the sort key. It now sorts on injected keys, as connection `orderBy` does. This needs APOC and is verified by the emitted Cypher's shape.
- **Point `srid` is a number** on the driver's default lossless integers. It used to come back as `{ low, high }`.
- **Clear errors instead of wrong results:**
  - Selecting an **aggregating** `@cypher` field (e.g. `RETURN count(p)`) **through a relationship** now throws an `OGMError` naming the field. Neo4j 5 rejects aggregation inside a projection, and no rewrite parses. Top-level selection still works.
  - `aggregate` on a `@cypher` field now throws instead of returning null min/max/average and a sum of 0.

### Writes

- **Nested writes on interface relationships run.** A nested `connect`, `create`, `update`, `disconnect` or `delete` on an interface-typed relationship was skipped without an error. It now runs, keyed by implementer (`pets: { Dog: { create: [...] } }`) or flat. A flat nested create names its implementer: `node: { Dog: {...} }`. Each implementer's policies apply. Inputs that can't be resolved now throw `OGMError` instead of being ignored.
- **Top-level `connect` and `disconnect` work on interface and union relationships.** They matched the abstract type's label, which no node carries, so nothing changed. Per-member union input was also never unwrapped. Both now match the members' own labels and apply each member's `read` policy. A blanket disconnect keyed by one union member now unlinks only that member, not every member.
- **Array `connect` with a bare-property `where` links.** `connect: { posts: [{ where: { title: 'a' } }] }`, with no `node:` wrapper, used to link nothing.
- **A connect nested in a connect item, and a disconnect nested in a disconnect item, run.** They used to be dropped, at the top level, inside `create` and inside nested `update`. Every level applies its target type's `read` policy. Nesting is capped at 5 levels.
- **`upsert` rejects relationship fields** in `create` / `update` with an `OGMError`. They used to be ignored, so their nested ops never ran.

### Schema and generated types

- **`@relationship(direction:)` is validated.** A direction other than exactly `IN` or `OUT`, such as `"out"`, was accepted. Reads treated it as OUT and writes as IN, so edges were written reversed and couldn't be read back. It's now a schema error that names the field.
- **List `@default` values work.** `@default(value: [RED, GREEN])` used to be ignored. They're now stored with native element types. A list default on a non-list field is a schema error.
- **`@declareRelationship` interface relationships work.** They parsed with an empty relationship type, so every operator on them threw `Invalid identifier ""`. The type, direction and properties now come from the implementors, and implementors that disagree are a schema error.
- **Generated types match the runtime:**
  - scalar `@cypher` fields are selectable in `<T>SelectFields`
  - required fields with `@default` are optional in `CreateInput`
  - `IdAggregateSelection` and `StringAggregateSelection` are `{ min, max }`, not `{ shortest, longest }`
  - interfaces are no longer in `ModelMap`, where `ogm.model('<Interface>')` type-checked but always threw
  - unsupported `<rel>Aggregate` fields and where keys are no longer generated; the old aggregation types remain, deprecated
- **Colliding generated type names fail at generation time.** For example, `User.postComments` and `UserPost.comments` both produce `UserPostCommentsConnectionWhere`, which used to make the generated file fail to compile. Generation now fails with an error that lists each duplicate and its sources.

### CLI and execution

- **`grafeo db push` reports changed index definitions.** Changing a fulltext index's fields, or a vector index's dimensions or similarity, used to print "No changes". Push now reports a **changed** bucket saying the schema is NOT in sync. It recreates those indexes only under `--force-drop`, with the usual consent rules.
- **`grafeo db push` output is accurate:**
  - It no longer claims "created X" when an equivalent constraint already exists under another name; that one is reported as `X covered by <name>`.
  - A conflicting RANGE index is reported instead of crashing the push.
  - In-sync constraints are no longer listed as "Unmanaged".
- **`grafeo db seed` honours `--database`, `database.database` and `NEO4J_DATABASE`.** It used to seed the default database regardless. The new optional **`OGMConfig.database`** sends every session the OGM opens to that database. Without it, nothing changes.
- **Transaction audit metadata is no longer dropped silently.** Driver 5.x transactions have no `setMetaData`, so policy audit metadata for calls inside a transaction, including `unsafe.bypassPolicies` audits, never reached the server. Per-call metadata still can't be attached to an open transaction, but each such call now logs a `warn`. The new `ogm.$transaction(fn, { metadata })` attaches metadata when the transaction begins, and its `TransactionOptions` type is exported.
- **`Executor.debug = true` no longer breaks queries with `bigint` params.** This includes `$queryRaw` and `$executeRaw`.

### Testing helpers

- **`Neo4jRecordFactory.dateTime` keeps the offset, nanoseconds and zone id.** It converted values to UTC and cut the fraction to milliseconds. It now matches what the real driver returns.
- **`CypherAssert.assertParams` ignores key order and compares bigints.** A bigint param used to throw.
- **`Neo4jRecordFactory.node` takes `{ identity?, elementId? }`**, so mock nodes can have distinct ids.

### Docs

- `@id` does **not** create a unique constraint; only `@unique` does. Use `@id @unique` to have the database enforce uniqueness.
- The README Interfaces example is now valid GraphQL (directives go after `implements`).
- The Testing Utilities section documents the real API.
- The directive table covers `@declareRelationship`, the `IN`/`OUT` rule and list defaults.

## 2.4.7 (2026-10-18) — `db push --force-drop` only drops constraints grafeo created

### 🐛 `--force-drop` could drop constraints on labels grafeo doesn't manage

`db push` decided whether a live constraint was grafeo's from its **name alone**: any name that started with a known label and ended in `_unique` qualified. With `type Book` in the SDL, a DBA's `Book_Archive_code_unique` constraint on the **unrelated** label `Book_Archive` looked like "label `Book`, property `Archive_code`". `db push --force-drop --yes` then dropped it. A NODE KEY or existence constraint that happened to share the naming shape qualified too.

A constraint is now treated as a droppable orphan only when its **definition** proves grafeo would have created it:

- the type is `UNIQUENESS`
- it covers exactly one label, and that label is in the schema
- it covers exactly one property
- its name is exactly `{Label}_{prop}_unique` for that label and property

`db push` now reads `labelsOrTypes` and `properties` from `SHOW CONSTRAINTS` to check this. If a server doesn't report those columns, nothing is treated as droppable: a missed orphan only means "kept", while a wrong drop can lose a constraint. The set of constraints `--force-drop` can drop only ever shrinks.

## 2.4.6 (2026-10-18) — `createMany` writes every item's fields

### 🐛 `createMany` took its columns from the first item only

The column list came from `data[0]`'s keys, so with mixed items:

- **Fields only later items supplied were silently dropped.** `createMany({ data: [{ email: 'a' }, { email: 'b', name: 'B', age: 4 }] })` stored `b` without `name` or `age`.
- **An `@id` supplied by some items left the others with a null id.**
- **A `@default` column overwrote values that later items supplied** (`status: 'banned'` was stored as the default `'active'`).

The column set is now the union of every item's keys. An item that omits a field gets what `create()` would give it, which is what the README documents for `@default`:

- a generated `@id`, if the field is an `@id`
- the `@default` value, if the field has one
- nothing, otherwise

An explicit `null` stays `null`. With `skipDuplicates`, the `MERGE` key is now the `@id`/`@unique` fields that **every** item supplies, so no item ever merges on a null. Batches where every item has the same keys emit the same Cypher as before.

**Unchanged on purpose:** a relationship field is still rejected only in the **first** item. In later items it is still skipped without being written. Rejecting it in every item would make calls that succeed today throw, so that is tracked as a separate change.

A new opt-in live suite, `tests/integration/create-many.spec.ts`, covers each case. Against Neo4j 5.26.32, the 4 bug cases fail without the fix.

## 2.4.5 (2026-10-18) — nested creates inside `update` store edge properties

### 🐛 `edge` was silently dropped on a nested `create` inside `update`

`update({ update: { posts: [{ create: [{ node, edge: { role: 'author', weight: 3 } }] }] } })` created the node and the relationship, but the relationship got **no properties**. The `edge` input was never read on this path. The generated `CreateFieldInput` type offers `edge` here, and `create()` already honours the same input. The relationship is now bound in the `CREATE` and its properties are `SET` with the same coercion `create()` uses, so an `Int` edge value is stored as an `INTEGER`. A nested create without `edge` emits the same Cypher as before.

**Data written by earlier versions:** relationships created this way exist but have no properties.

A new opt-in live suite, `tests/integration/edge-properties.spec.ts`, covers single and multiple nested creates and checks parity with `create()`.

## 2.4.4 (2026-10-18) — 🛡️ Security: a blanket `disconnect` honours the target's `read` policy

> **Security release. Upgrade if you use `policies`.** OGMs without `policies` emit byte-identical Cypher and are unaffected.

### 🛡️ `disconnect: [{}]` severed links to nodes the context's `read` policy hides

v2.3.0 established that a policy-bound context must be able to **see** a node to unlink it. A `where`-scoped disconnect enforces this. But a disconnect item of `{}` or `null` (the "disconnect all" form) took a separate branch that bound an anonymous target and applied **no** policy, both top-level and nested:

```ts
// policy hides charts with secret: true
await Tag.update({ where: { id: 't' }, disconnect: { charts: [{}] } });
// pre-2.4.4: removed the link to the hidden chart too
//            (and counted it in info.relationshipsDeleted)
```

So a context with `update` rights on the source node could remove relationships to nodes it isn't allowed to read, and use the deleted count to learn how many hidden related nodes exist. Both blanket branches now apply the same target `read` predicate as the `where`-scoped branch.

### Behavior change, for policy-bound callers only

`disconnect: [{}]` now removes only the relationships to targets the context can **read**. Links to hidden nodes are kept. The "replace all" idiom (`[{ disconnect: [{}] }, { connect: [...] }]`) therefore leaves hidden links in place. If a trusted path truly has to detach everything regardless of visibility, run it with `unsafe: { bypassPolicies: true }`, which stays audited, or with an OGM that has no policies.

This ships as a patch because it is a security fix. Contexts that can read every related node, and OGMs without policies, see no change. The NLS live suite (`tests/integration/nls-enforcement.spec.ts`) adds top-level, nested and no-policy cases. Against Neo4j 5.26.32, the two bypass cases fail without the fix.

## 2.4.3 (2026-10-18) — sorting on a field you don't select works

### 🐛 `options.sort` was silently ignored for fields not in the selection

`ORDER BY / SKIP / LIMIT` were emitted **after** `RETURN n { … }`. Once that `RETURN` runs, the column `n` is the projected **map**, not the node. So `ORDER BY n.age` read a key the projection didn't include, and every row sorted as `null`. Any sort on a field you didn't also select returned rows in arbitrary order, and **`offset`/`limit` then returned the wrong page**. This affected `find`, `findFirst`, `findFirstOrThrow`, fulltext `find`, `InterfaceModel.find` and `explainPolicies`:

```ts
// returned a, b, c, d (arbitrary), not the rank order b, d, a, c
await Person.find({ selectionSet: '{ id }', options: { sort: [{ rank: 'DESC' }], limit: 2 } });
```

The options now apply on a pass-through `WITH *` **before** the projection:

```cypher
WITH *
ORDER BY n.`rank` DESC
SKIP $options_offset
LIMIT $options_limit
RETURN n { .`id` }
```

Sorts on fields that are also selected, and on `@cypher` fields, return exactly what they did before. Paging now happens before the projection runs, so a `limit`ed query also does less work. Queries with no `options` emit the same Cypher as before.

A new opt-in live suite, `tests/integration/sort-pagination.spec.ts`, covers stored, paged, `findFirst`, `@cypher`, `InterfaceModel` and fulltext sorts. Against Neo4j 5.26.32, the 5 unselected-field cases fail without the fix.

## 2.4.2 (2026-10-18) — a same-item disconnect-all no longer orphans the node it creates

### 🐛 `create` ran before `disconnect` inside one nested update item

Inside one nested update item, the operations ran in this order: delete, **create**, disconnect, connect, update. So `update: { posts: [{ disconnect: [{}], create: [{ node }] }] }`, the "replace everything with this new one" idiom, first linked the new node and then the disconnect-all removed that link too. The new node was left **orphaned**, and the parent had no related nodes. The same input to `updateMany` did this to every matched node.

`create` now runs after `disconnect` and `connect`. The order is delete, disconnect, connect, create, update, which matches `@neo4j/graphql`. `create` still runs before `update`, so nothing else changes. Putting the two ops in separate items (`[{ disconnect: [{}] }, { create: [...] }]`) already worked and is unchanged.

**Data written by earlier versions:** nodes created through this idiom exist but are unlinked. Look for nodes of the target type with no incoming relationship of that type.

## 2.4.1 (2026-10-18) — `upsert` generates the `@id` when it creates

### 🐛 A node created by `upsert` was stored without its `@id`

When `upsert` took the `ON CREATE` branch, it set the `create` input and the `@default` values, but never generated `@id` properties. So the node was stored with no id, and the response carried `id: null` for an `ID!` field. `create` and `createMany` always generate it. The `ON CREATE` branch now emits `n.<id> = randomUUID()` for each `@id` property, unless the caller supplied it in `create` or it is part of the `MERGE` key. The `ON MATCH` branch never touches the id.

**Data written by earlier versions:** nodes that `upsert` created before 2.4.1 have no `@id`. To backfill them:

```cypher
MATCH (n:YourType) WHERE n.id IS NULL SET n.id = randomUUID()
```

A new opt-in live suite, `tests/integration/upsert.spec.ts`, covers the `ON CREATE`, `ON MATCH` and caller-supplied-id cases.

## 2.4.0 (2026-10-18) — `@cypher` fields keep every node exactly once

> **Minor release with a behavior change.** Reads that select, filter or sort a `@cypher` field can return a **different number of rows** than in 2.3.x. Nodes that were silently dropped now appear, with `null` for the field, and duplicated nodes now appear once. See *Behavior changes*.

### 🐛 A `@cypher` statement with zero or several rows dropped or duplicated the node ([#9](https://github.com/neomodular/grafeo-ogm/issues/9))

A top-level `@cypher` field was computed with a plain `CALL { <statement> }`, and a CALL that yields zero rows removes the outer row, while one that yields several multiplies it. The same prelude backs the select, `where` and `options.sort` scopes, so with a statement like `MATCH (this)-[:HAS_STATUS]->(s) RETURN s.name AS status`:

| Operation | 2.3.x | 2.4.0 |
|---|---|---|
| `find`, selecting `status` | node without a status **dropped**; node with 2 statuses **returned twice** | each node once: `null` / first status |
| `where: { status: null }` | **never matched** | matches nodes without a status |
| `where: { status_NOT: x }` | duplicates | each node once |
| `options.sort: [{ status }]` | nodes without a status **missing**, others duplicated | every node once; `null` sorts per Neo4j (last on `ASC`) |
| `count({ where })` on `status` | undercounted / overcounted | agrees with `find` |
| `create` / `update` / `upsert` selecting `status` | **`[]` (or `null`) even though the write committed** | the written node |

Each prelude now runs the statement in an inner `CALL` and reduces its `columnName` column with `head(collect(…))`. A grouping-free aggregation always yields exactly one row, so every node is kept once. That matches how nested selections already projected `@cypher` fields (`head(COLLECT { … })`). The shape works on every Neo4j 5.x, unlike `OPTIONAL CALL` (5.24+), and statements may still return extra columns.

### Behavior changes

- **Row counts can change** for any read that selects, filters or sorts a top-level `@cypher` field. Code that relied on such nodes being absent, for example as an implicit "has a status" filter, should filter explicitly: `where: { status_NOT: null }`.
- **With several statement rows, the first one wins.** Add an `ORDER BY` to the `@cypher` statement if it matters which value is picked.
- **Generated Cypher changes** for queries that use `@cypher` fields. If you pin compiled Cypher in tests, expect the new prelude shape. Queries without `@cypher` fields are byte-identical.

A new opt-in live suite, `tests/integration/cypher-field-row-semantics.spec.ts`, pins each row above as a database outcome. Against Neo4j 5.26.32, all 7 cases fail on 2.3.6.

## 2.3.6 (2026-10-18) — `searchByPhrase` works

### 🐛 `searchByPhrase` called a function as a procedure ([#13](https://github.com/neomodular/grafeo-ogm/issues/13))

`searchByPhrase` emitted `CALL genai.vector.encode(…) YIELD vector`. In the GenAI plugin, `genai.vector.encode` is a **function**: the plugin's procedures are only `genai.vector.encodeBatch` and `genai.vector.listEncodingProviders`. So every call failed with `There is no procedure with the name 'genai.vector.encode' registered`. The embedding is now computed in a `WITH genai.vector.encode(…) AS __v_encoded_N` ahead of the `db.index.vector.queryNodes` call. `searchByVector` is unchanged.

A new opt-in live suite, `tests/integration/vector-phrase.spec.ts`, runs when `NEO4J_GENAI_URI` points at a server with the GenAI plugin, for example `neo4j:5.26` with `NEO4J_PLUGINS=["genai"]`. It never contacts an embedding provider: an empty provider config makes the plugin fail locally, and the test asserts that this config error is what comes back, not the missing-procedure error.

## 2.3.5 (2026-10-18) — `create` with several inputs returns every node

### 🐛 Only the first created node was returned ([#12](https://github.com/neomodular/grafeo-ogm/issues/12))

`create({ input: [a, b, c] })` created all three nodes, but returned only the first. Each input binds its own Cypher variable (`n`, `n_1`, `n_2`, …), and the statement ended in a bare `RETURN n`. The response's entity array (`{ <plural>: [...] }`) now holds every created node, in input order. That covers `select`, `selectionSet`, `@cypher` projections and nested relationship selections. The `info` counters were always correct. A single-input `create` emits the same Cypher as before.

The live suites now include multi-input creates, with nested creates and with `@cypher` projection. Against Neo4j 5.26.32, all three cases fail without the fix.

## 2.3.4 (2026-10-18) — Fulltext `AND` and `NOT` work

### 🐛 Fulltext `AND` failed for every input ([#11](https://github.com/neomodular/grafeo-ogm/issues/11))

`AND` compiled each later branch into the outer scope as `CALL { WITH n <branch with m> WHERE m = n RETURN score }`. Neo4j rejected every shape:

| Later branch | Error |
|---|---|
| index leaf | `Variable 'score' already declared in outer scope` |
| `OR` | its `max(score)` aggregation dropped `n` |
| relationship index | `WITH startNode(rel) AS m, score` dropped `n` |
| `NOT` | see below |
| nested `AND` | `Variable 'm' already declared` |

Each later branch now runs in an **uncorrelated** inner `CALL` under its own variable, so none of its names can collide with or drop the outer scope. The result is joined back on `n`. A node with no match is dropped, and a node matched several times (for example through two relationships) is kept once. The result `score` is still the first branch's score.

### 🐛 Fulltext `NOT` failed for every input

Found while fixing #11. `NOT` compiled to `WHERE NOT EXISTS { CALL db.index.fulltext… YIELD … WHERE excluded = n }`, which Neo4j rejects with `Cannot use standalone call with WHERE`. With an `OR` inside, the aggregation dropped `n` as well. `NOT` now counts the inner expression's hits per node through the same isolated join, and keeps the nodes with zero hits. Score is still `0`.

A new opt-in live suite, `tests/integration/fulltext-logical.spec.ts`, runs `AND` with leaf, `OR`, `NOT`, relationship-index and nested-`AND` branches, an `AND` whose first branch is an `OR`, and standalone `OR`/`NOT`. Against Neo4j 5.26.32, all 8 cases fail without the fix.

## 2.3.3 (2026-10-18) — `connect` no longer drops or duplicates the updated node

### 🐛 A top-level `connect` changed how many rows the update returned ([#10](https://github.com/neomodular/grafeo-ogm/issues/10))

A top-level `update({ connect })` compiled to an inline `MATCH (target …) MERGE …`, so the number of rows the update returned depended on how many targets matched:

- **No target matched:** the node was dropped. The scalar `SET` **committed**, but the call returned `[]`, and any later connect or disconnect in the same call was skipped.
- **Several targets matched** (an array connect, or a `where` matching more than one node): the updated node was returned once per target.

Each top-level connect (the UNWIND fast path and the single-connect path) now runs inside `CALL { … RETURN count(*) }`, like disconnects since 2.3.2. **Connecting to a target that doesn't exist is now a no-op:** the update succeeds and returns the node, which matches `@neo4j/graphql`. Nested connects were already isolated this way.

If you relied on an empty result to detect a missing connect target, check the relationship explicitly instead. The empty result was never a reliable signal, because the rest of the write had already committed.

## 2.3.2 (2026-10-18) — Disconnects no longer multiply the rest of the mutation

### 🐛 A disconnect ran later nested writes once per removed relationship ([#8](https://github.com/neomodular/grafeo-ogm/issues/8))

A disconnect compiles to `OPTIONAL MATCH … DELETE`, which yields one row per matched relationship. It was emitted inline, so that fan-out carried into every later clause of the same `update`:

- **Wrong data:** a nested `create` after a disconnect-all (`update: { chapters: [{ disconnect: [{}] }, { create: [...] }] }`) created one node **per previously connected node**. On a book with 3 chapters, it created 3 chapters instead of 1.
- **Duplicate results:** the updated node was returned once per removed relationship, for nested disconnects and for top-level `disconnect` alike.

Each disconnect, top-level and nested, now runs inside `CALL { … RETURN count(*) }`. That always yields exactly one row, so a disconnect can't multiply the rows of the rest of the statement, and it can't drop them either (a node with nothing to disconnect is still returned). The other nested ops (create, connect) already used this isolation.

A new opt-in live suite, `tests/integration/mutation-row-cardinality.spec.ts`, asserts the database outcome: nodes created, links left, rows returned. Against Neo4j 5.26.32, its four fan-out cases fail without the fix.

## 2.3.1 (2026-10-18) — Mutations projecting `@cypher` fields work on Neo4j 5.x

### 🐛 `WITH` between the write clause and `@cypher` projection preludes ([#7](https://github.com/neomodular/grafeo-ogm/issues/7))

When a `create`, `update` or `upsert` projected a `@cypher` field (through `select`, `selectionSet`, or a model-level `selectionSet` default), the `CALL { … }` that computes the field was emitted directly after the `SET` / `CREATE` / `MERGE … ON CREATE SET`. Neo4j 5.x (including 5.26 LTS and Aura 5.27) rejects that at parse time with `WITH is required between SET and CALL` (or `… between CREATE and CALL`). Neo4j 2025.x and later accept it, which is why recent-server and mock-driver test suites didn't catch it.

The projection now emits `WITH n` before the preludes. The generated Cypher is unchanged for mutations that select only stored fields. Find and other read paths were never affected.

A new opt-in live suite (`tests/integration/mutation-cypher-projection.spec.ts`, run when `NEO4J_URI` is set) covers create, update and upsert (both the `ON CREATE` and `ON MATCH` branches) and the model-level default. Against Neo4j 5.26.32, every case fails without the fix and passes with it.

## 2.3.0 (2026-09-23) — 🛡️ Security release: NLS enforcement through relationships, nested writes and cascade delete

> **Security release. Upgrade if you use `policies`.** Node-level-security (NLS) enforcement of the **root** type was sound, but enforcement of **other types reached through relationships** had several gaps. Together they let a bound `withContext(ctx)` read, link, update, create and delete nodes that the target type's policies forbid. One of them (cascade delete) deleted unrelated data with no policy involved at all. Every gap was reproduced before the fix and is pinned by a red-first regression test, both in the mock suite and in a new opt-in live-Neo4j suite.
>
> **Reads on OGMs without `policies` emit byte-identical Cypher.** Three changes apply to everyone: the cascade-delete fix, strict `null` filters, and nested-write `where` now being compiled by `WhereCompiler` (see *Behavior changes*).

### 🛡️ Types without policies no longer bypass their neighbours' policies (critical)

When the root type of a query had no policies of its own, the policy context was dropped entirely. Every related type's policies were then skipped in nested selection, in relationship filters (`_SOME`/`_NONE`/`_ALL`/`_SINGLE`/`…Connection`), on `connect`/`disconnect`, and in `explainPolicies`. A policy-free type (a tag, a join node) was a gateway around its neighbours. The same happened one level down: a policy-free type in the **middle** of a traversal (`a_SOME: { b_SOME: { c_SOME } }`) switched enforcement off for everything beyond it.

A policy-bound model now always carries its policy context. A type without policies contributes no clause of its own, and every type it reaches still enforces its own. `count`/`aggregate` keep their fallback from `aggregate` to `read` policies.

### 🛡️ Cascade delete honours its `where` and the target's `delete` policy (critical)

`Model.delete({ delete: { rel: [{ where }] } })` ignored the per-relationship `where`: the documented README example deleted **every** related node, including nodes shared with other records, and never checked the target type's policies. Each cascade item now deletes only the related nodes matching its `where` (`{}` still means all), and each cascaded node must pass its own type's `delete` policy. A `delete` nested inside a cascade item (multi-level cascade, previously ignored) and unknown item keys now throw `OGMError` before anything runs.

### 🛡️ Nested writes enforce the target type's policies

A nested write now enforces exactly what the equivalent direct write on the target type would. Before, most nested writes enforced no target-type policy at all:

| Nested operation | Now enforces on the target type |
|---|---|
| `connect` / `disconnect`, including `connect` inside `create` (previously unchecked) | `read` |
| nested `update` | `update` row filter, plus its write restrictives (`WITH CHECK`) on the nested input |
| nested `create`, in `create` or `update` | `create`: default deny, plus its write restrictives on the nested input |
| `delete` inside `update` | `delete` row filter |

Write restrictives and create default-deny are checked, at any depth, before the query runs. A rejected nested write throws `PolicyDeniedError` and nothing is written. The mutation compiler's separate `where` builder, which had drifted from `WhereCompiler` (it threaded no policy context into traversals and misparsed `null`), is removed. Nested-write `where` is now compiled by `WhereCompiler`, so traversals inside it enforce the traversed types' `read` policies too.

### 🛡️ Interface and union relationship targets apply each member's policy (critical)

When a relationship pointed at an **interface** or **union**, enforcement looked up the abstract type's name. That name carries only interface-level policies (none for a union), so the concrete members' own policies were never applied through the relationship: not in nested selection, not in relationship filters, not in nested writes. Each related node is now checked against its concrete type's policy: `CASE WHEN n:Chart THEN <Chart policy> WHEN n:Drug THEN <Drug policy> … ELSE false END`. One shared helper builds this clause for every consumer, including `InterfaceModel` (below).

### 🛡️ Relationship filters no longer leak hidden nodes

The target type's policy was compiled **inside** the caller's filter, which is only correct for `_SOME`. Wherever the quantifier negates the filter, hidden nodes leaked into the result:

- `rel_ALL: { … }` was falsified by hidden related nodes.
- `rel_ALL: {}` held only when no related node existed at all, which revealed whether hidden nodes exist.
- A connection `node_NOT` filter was satisfied by hidden nodes.
- An edge-only connection filter (`relConnection: { edge: { … } }`) applied no target policy at all.

The filter and the policy are now composed separately, with the policy outside every negation. Quantifiers range over the related nodes the caller may see: a hidden node neither satisfies nor falsifies them. `_SOME` emits the same Cypher as before.

### 🛡️ `null` filters no longer fail open (high)

`{ field_NOT: null }` compiled to `` n.`field_NOT` IS NULL ``, which is always true, so a restrictive policy such as `{ approvedAt_NOT: null }` matched every row. `null` is now interpreted after the operator suffix is split off:

- `field_NOT: null` → `IS NOT NULL`
- `rel_NOT: null` → `EXISTS`
- any other operator with `null`, or an unknown field with `null` (even without `strictWhere`), throws `OGMError`

This applies to every `where`, including policy partials and nested-write `where`.

### 🛡️ `InterfaceModel` branches match each implementer's own model (medium)

An implementer whose `read` permissives were all gated off by `appliesWhen` got `THEN true` in `InterfaceModel`'s per-label `CASE`, while `Model(<Impl>).find` denies it. Each branch is now exactly the clause that the implementer's own model enforces, which also removes the interface predicates that previously appeared twice per branch. `aggregate`/`count` branches now use each implementer's own `aggregate` policies (falling back to `read`), as `Model.aggregate` does. The `onDeny: 'throw'` pre-check no longer throws when an implementer has no policies (it is visible under its own model).

### ⚠️ Behavior changes

- **Cascade delete honours `where`.** If you relied on the old delete-everything behavior while passing a `where`, pass `{}` instead. Multi-level cascade and unknown cascade keys throw.
- **Nested writes into protected types can now be filtered or denied.** Add the matching policy for that operation on the target type, or perform the write directly on its model.
- **Relationship filters over protected types** now range over visible related nodes only (`_ALL` in particular).
- **Strict `null`:** `field_NOT: null` flips from always-true to `IS NOT NULL`; unsupported or unknown `null` filters throw.
- **Emitted Cypher changes** for: reads that reach protected types through policy-free types; every nested write with a `where` or a protected target (parameters now come from the shared `paramN` counter); `InterfaceModel` reads with policies; and cascade deletes (one `CALL { … }` per item).
- Two edge cases now throw `OGMError` instead of emitting Cypher that fails at runtime: `@cypher`-projecting policies on more than one member of an interface/union target, and `@cypher` fields in both an abstract target's filter and a member policy.

### 🔧 Internal

- New `NO_ROOT_POLICY` resolution ("bound, but no root clause"). New `src/policy/nested-writes.ts`, where the root and nested create/update checks share one implementation.
- `WhereCompiler.compileTargetPolicyClause()` (concrete or abstract, optional operation fallback) and `compileTargetBody()` are the single construction behind every target-policy consumer. `compile()` accepts a caller-owned `@cypher` scope.
- `MutationCompiler.compileCreate` / `compileDelete` gain optional trailing `policyContext` / `paramCounter` parameters. The bulk-connect `UNWIND` fast path is kept for scalar, non-null, non-logical items; everything else compiles through `WhereCompiler`.

### Tests

- Mock red/green tests for every gap (`tests/policy/enforcement-gaps.spec.ts`).
- A 25-case invariant suite: each `InterfaceModel` branch equals its implementer's own `find`/`aggregate`/`count` clause, in text and parameter values.
- Against v2.2.0, 56 of these 75 new tests fail. The other 19 are byte-identity guards, positive controls, and invariant cases where the old construction already agreed.
- An opt-in live-Neo4j suite (`tests/integration/`, skipped unless `NEO4J_URI` is set) asserting database outcomes per gap.
- The 17-case policy golden suite is unchanged except for the deliberately re-pinned `InterfaceModel` case (deduplicated predicates).

---

## 2.2.0 (2026-09-23) — 🔎 Explain policy decisions

> **Policy-bound reads can now explain themselves.** When a policy hides a node, `find` could only show *that* it disappeared, never *which* named clause removed it, because every clause is compiled into a single `WHERE` predicate. The new `Model.explainPolicies()` evaluates each `read` policy separately for every candidate node, covering both the declarative `when:` form and the raw `cypher:` form, and returns the hidden nodes too ([#6](https://github.com/neomodular/grafeo-ogm/issues/6)).
>
> **Additive minor release.** No existing signature changes, and every existing query emits byte-identical Cypher (pinned by a new 17-case golden suite). The one observable change is a correction to `policiesEvaluated` in the audit metadata (see below).

### ✨ `Model.explainPolicies()`

```typescript
const report = await ogm
  .withContext(ctx)
  .model('Chart')
  .explainPolicies({ where: { id_IN: candidateIds }, select: { id: true } });
// → [{ node, visible, overriddenBy, permissiveGranted, failedRestrictives,
//      policies: [{ name, named, kind, source, applied, outcome }] }]
```

- **Matches enforcement exactly.** Explain reuses the fragments `find` compiles, and `visible` is computed from the same composed predicate `find` puts in its `WHERE`. The verdict recomputed from the per-policy outcomes is checked against it, and a mismatch throws rather than returning a wrong explanation.
- **Outcomes:** `pass`, `fail`, `null` (NULL is reported separately from `false`), `abstain` (the policy emitted no predicate), `not-applied` (`appliesWhen` returned false), `skipped` (an override fired).
- **Candidates** are selected by `where` / `labels` exactly as in `find`. Full `select` / `selectionSet` is supported, and nested relationships are still filtered by their own policies.
- **Read-only:** when grafeo opens the session itself, it uses `READ` access mode. Candidates default to 100 per call; more than 1,000 is rejected.
- **An explicit bypass:** every call logs a `warn`, is tagged `explain: true` in the transaction metadata (even with `auditMetadata: false`), and throws on models without a policy binding and on policy-bypassed OGMs. `onDeny: 'throw'` is reported as `visible: false` instead of being thrown.
- Scope: `Model` and the `read` operation only. `InterfaceModel`, `count`, `aggregate`, and `delete` are not supported yet.
- New exported types: `PolicyExplanation`, `PolicyClauseExplanation`, `PolicyClauseOutcome`, and `ExecuteOptions`.

### 🐛 `policiesEvaluated` lists only policies that applied

The audit metadata field is documented as "names of policies that fired", but it also listed restrictives whose `appliesWhen(ctx)` returned `false`, even though those contributed nothing to the query. They are no longer listed. Emitted Cypher is unchanged.

To produce this list, the resolver now evaluates restrictive `appliesWhen` itself, and the compiler (or `evaluateWriteRestrictives`) still evaluates it too. As a result, **restrictive `appliesWhen` callbacks run twice per query**. They are documented as pure compile-time gates, so this only matters if yours have side effects (counters, logging).

### 🔧 Internal

- `WhereCompiler`'s policy clause is now built in two steps: `compilePolicyFragments()` (the per-policy parts) and `composePolicyClause()` (the combination). Output is byte-identical to 2.1.1. The new `compileForExplain()` returns the fragments without folding them into the `WHERE`.
- `PolicyResolver.resolveDetailed()` returns every operation-matching policy with its `applied` / `skipped` state, source, and registration index. `resolve()` is now a projection of it via `projectResolution()`.
- `Executor.execute()` accepts an optional 4th argument, `{ accessMode }`. It only affects sessions the executor opens itself; calls without it behave as before.

### Tests

- `tests/policy/explain-refactor-golden.spec.ts`: 17 goldens captured from the 2.1.1 compiler, covering every fragment shape, interface inheritance, `@cypher` preludes, traversal, nested selection, count, aggregate, delete, override, and `InterfaceModel`.
- `tests/policy/explain.spec.ts`: 27 tests covering guards, clause forms, no short-circuiting, applicability, the outcome vocabulary, fidelity with `find` (including a forced mismatch), identity, selection and prelude scoping, and security signalling.
- 10 new resolver tests, 2 new audit-metadata tests, and `tests/executor-access-mode.spec.ts` (5 tests).

## 2.1.1 (2026-08-13) — 📍 Point fields round-trip

> **The last member of the 2.1.0 type-faithfulness family.** Reads flatten a native Point into a plain `{ x, y[, z], srid }` object — but writing that object back bound it as a map property value, which Neo4j rejects at runtime ("Property values can only be of primitive types or arrays thereof"). A `Point` read through the OGM could not be written back through the OGM.
>
> **Pure patch:** nothing that previously worked changes behavior. Plain point writes previously failed loudly at the database; they now succeed as the README's scalar table always promised.

### 🐛 Plain point objects are wrapped in `point()`

`Point` / `CartesianPoint` writes now wrap the parameter in Cypher's `point()` constructor whenever the value is a plain point-shaped object — cartesian (`x`/`y`) or geographic (`longitude`/`latitude`). `point()` accepts the read shape back verbatim, `srid` included, so the read → write round-trip is exact:

```cypher
CREATE (n:`Event` { `location`: point($create0_location) })
// list fields wrap element-wise:
`route`: [wc_t IN $create0_route | point(wc_t)]
```

WHERE equality and `_IN`/`_NOT_IN` params wrap the same way, so filters match natively-stored points instead of silently comparing a map against a POINT (`NULL` → row dropped). Driver `Point` instances still bind raw.

Unlike the temporal constructors, `point()` rejects an already-native POINT argument — so a list or batch column mixing plain maps with driver `Point` instances throws a clear `OGMError` at compile time, where it previously died as an opaque database error.

### 🔧 Internal

The write-constructor helpers are no longer temporal-specific and were renamed accordingly (`wrapWriteExpr`, `wrapListItemExpr`, `wrapWhereParam`); each constructor family now carries an explicit list rule (`arrayMode: 'any'` for temporals — `datetime(datetime)` is legal Cypher — vs `'all'` for points). 2.1.0 temporal behavior is byte-identical.

### Tests

- 7 new tests in `tests/type-faithful-writes.spec.ts` covering create/update wrapping, geographic + `CartesianPoint` input, driver-instance passthrough, list + mixed-list handling, WHERE `=`/`_IN`, and `createMany` columns.

## 2.1.0 (2026-08-13) — 🧭 Writes now store what the schema declares

> **Every write path now binds values as the Neo4j type the schema promises.** Until now the compilers bound raw JS values and left the rest to the driver — and the driver packs every JS `number` as a Bolt FLOAT64 and every string as a String. So `Int`/`BigInt` fields landed as **Doubles** ([#5](https://github.com/neomodular/grafeo-ogm/issues/5)), the six temporal types landed as **Strings**, and `BigInt`'s documented string input landed as a **String** — while reads converted every native value back to a JS primitive, so the corruption was invisible until something type-sensitive touched the property. `@default` rode along: parsed, documented in the README, and applied nowhere.
>
> **This is a minor version because behavior changes on inputs that previously "worked":** `position: 1.5` and `plays: 'abc'` now throw instead of silently storing the wrong type, schemas that declare `@default` now actually receive defaults on create, and the generated `BigInt` scalar changes shape. If your inputs already match the documented contract you can upgrade and regenerate directly — but read the **migration note** below if you have data written through the OGM before 2.1.0.

### 🐛 `Int` / `BigInt` writes are bound as Neo4j Integer ([#5](https://github.com/neomodular/grafeo-ogm/issues/5))

The driver packs every JS `number` as FLOAT64 — `disableLosslessIntegers` only affects reads — so every OGM-written `Int` property landed as a Double. Once a field held a mixed Long/Double population (OGM writes vs seed/raw-Cypher writes), Long-typed consumers crashed:

```
Failed to invoke function `apoc.coll.sortMulti`:
java.lang.ClassCastException: class java.lang.Double cannot be cast to class java.lang.Long
```

Every mutation binding site — create, update, upsert (MERGE key, `ON CREATE SET`, `ON MATCH SET`), `createMany` items, and all edge-property paths through connect and nested updates (**14 sites** in total; the report named 5) — now binds `Int`/`BigInt` values through `neo4j.int()`. Numbers, bigints, integer strings, and pre-built `Integer` instances are all accepted; `null` clears as before.

**Rejected, not truncated:** a non-integral number (`1.5`) or a non-integer string (`'abc'`) for an integer field now throws `OGMError`. Coercing would silently truncate; binding raw would silently store the wrong type — both are the defect class 2.0.0 exists to reject.

### 🐛 Temporal writes are stored as native temporal types

`DateTime`, `Date`, `Time`, `LocalTime`, `LocalDateTime`, and `Duration` fields were stored as **String** properties — the write path had no temporal conversion at all, while the README's scalar table promised native storage and reads converted native temporals to ISO strings. Against natively-typed rows (seed, APOC, raw Cypher), `WHERE n.createdAt > $param` with a string param is a cross-type comparison: Neo4j evaluates it to `NULL` and **silently drops the row**.

ISO-string writes are now wrapped in the field's Cypher constructor — the parameter stays a string and Neo4j does the parsing, which preserves nanosecond precision and bracket timezones (`2024-01-15T10:30:00[America/New_York]`) that a JS `Date` round-trip would destroy:

```cypher
CREATE (n:`Event` { `startsAt`: datetime($create0_startsAt) })
SET n.`day` = date($update_day)
// list fields wrap element-wise:
`slots`: [wc_t IN $create0_slots | datetime(wc_t)]
```

The same wrapping applies to WHERE params for comparison-shaped operators (`=`, `_NOT`, `_GT`/`_GTE`/`_LT`/`_LTE`, `_IN`/`_NOT_IN`) across the main where compiler and the connect/disconnect where paths, so filters keep matching the natively-stored values. String operators (`_CONTAINS`, `_MATCHES`, …) are untouched. Driver temporal objects still bind raw — only strings are wrapped. Batched paths (`createMany`, array connect) share one Cypher expression per field, so a column mixing ISO strings with driver objects throws instead of guessing.

### 🐛 `BigInt` honours its generated contract in both directions

The generated scalar declared `BigInt: { input: string; output: string }` — but a string input sailed through to a **String property**, and reads returned `number` (or `bigint` above 2⁵³), never `string`. Integer strings now coerce through `neo4j.int()` (for `Int` fields too), and the scalar tells the truth:

```typescript
BigInt: { input: string | number | bigint; output: number | bigint };
```

Regenerate your types to pick this up. If you annotated variables with the old `string` output type, those annotations were already wrong at runtime — the regen turns them into compile errors you can fix.

### 🐛 `@default` is now applied on create

`@default` was parsed into schema metadata and consumed by **nothing** — a documented silent no-op. It now applies wherever a node is created:

- `create` (nested relationship creates included)
- `upsert` — `ON CREATE SET` branch only, never `ON MATCH`, and never for MERGE-key fields
- `createMany` — as a whole-column default when **no** item supplies the field (per-item gaps inside a provided column stay `null`: every batch shares one Cypher text, and `coalesce()` would also override explicit nulls)

Defaults convert by declared type — `@default(value: "5")` on an `Int` binds an Integer, `Boolean` binds `true`/`false`, temporal defaults get their constructor wrapper. **A provided value always wins, and an explicit `null` stays `null`** — the user asked for null; a default overriding it would betray intent.

### ⚠️ Migrating data written before 2.1.0

Properties written through the OGM before this release carry the old storage types. New writes and filters use native types, so mixed populations should be migrated once, per affected field:

```cypher
// String-stored temporals → native (repeat per temporal field/label)
MATCH (n:Event) WHERE valueType(n.startsAt) STARTS WITH 'STRING'
SET n.startsAt = datetime(n.startsAt);

// Double-stored Ints → Long (only needed for Long-sensitive consumers,
// e.g. apoc.coll.sortMulti — Cypher numeric comparisons already match)
MATCH (n:ShelfRow) WHERE valueType(n.position) = 'FLOAT'
SET n.position = toInteger(n.position);
```

Until the temporal migration runs, WHERE filters on temporal fields will not match old String-stored rows (they compare as cross-type → `NULL`).

### Tests

- `tests/int-write-coercion.spec.ts` — 14 tests pinning Integer coercion across every mutation path.
- `tests/type-faithful-writes.spec.ts` — 24 tests pinning temporal wrapping (writes + WHERE), integer-string coercion, and `@default` semantics.
- 12 existing assertions that pinned the old behavior (raw-number edge params, unwrapped temporal comparisons, `DateTime` strings passed verbatim) updated to the corrected contract.

## 2.0.0 (2026-08-04) — 💥 Inputs that were silently truncated are now rejected

> **A major release with one theme: grafeo used to read the first key of certain input objects and throw the rest away without a word.** `sort` entries, fulltext leaves, and fulltext logical operators all did it. Every one produced a *successful* query answering a different question than the caller asked — no exception, no log, nothing in the Cypher to suggest anything was missing.
>
> **This is a major version because the fix is a behavior change on inputs that previously "worked."** Code that relied on the truncated shapes now throws at runtime, and regenerating types turns most of those shapes into compile errors. If your `sort` arrays and `fulltext` inputs already carry one key per object — the documented form throughout — **you are unaffected and can upgrade directly**.

### 💥 Breaking changes at a glance

| Shape | Before | Now |
| --- | --- | --- |
| `sort: [{ a: 'ASC', b: 'DESC' }]` | `ORDER BY n.a ASC` — `b` dropped | throws; compile error after regen |
| `fulltext: { IdxA: {…}, IdxB: {…} }` | searched `IdxA` only | throws; compile error after regen |
| `fulltext: { OR: […], AND: […] }` | `OR` only | throws; compile error after regen |
| `fulltext: { NOT: {…}, AND: […] }` | **`AND` only — exclusion lost** | throws; compile error after regen |
| `fulltext: { OR: […], IdxA: {…} }` | `OR` only | throws at runtime |
| `sort: [null]`, `fulltext: null` | bare `TypeError` | `OGMError` |
| `const s: XSort = {}; s.a = 'ASC'` | compiled | compile error — push array entries |

Migration for each is mechanical and shown in the sections below. The short version: **one key per object; use the array (`sort`) or the `AND`/`OR` operators (`fulltext`) to express more than one.**

> **Origin.** Reported by the community ([#4](https://github.com/neomodular/grafeo-ogm/issues/4)) against `sort`, found in production where an admin-curated `position` column had been silently ignored for every client. Auditing for the same defect class turned up three more sites in `FulltextCompiler`, and reviewing *that* fix turned up a fourth at the operator dispatch.

### 🐛 A sort entry must now carry exactly one ordering key

`ORDER BY` precedence comes from an entry's **position in the array**, never from key order inside an object. The documented form was always correct and is unchanged:

```typescript
// ✅ ORDER BY n.isUrgent DESC, n.position ASC
sort: [{ isUrgent: 'DESC' }, { position: 'ASC' }];

// ❌ compile error, and throws at runtime
sort: [{ isUrgent: 'DESC', position: 'ASC' }];
```

**Why reject rather than honour every key?** Because object key order is not a reliable carrier for precedence at a transport boundary. `graphql-js` `coerceInputValue` rebuilds input objects by iterating the **schema's** field definitions, not the order the client wrote them — so a client sending `{ position: ASC, isUrgent: DESC }` hands the resolver `{ isUrgent, position }` in SDL declaration order. Honouring both keys would have traded one silent wrong-order bug for another that only reproduces behind a GraphQL layer, and would have looked correct in direct TypeScript use. Array position survives that trip; key order does not.

### 🐛 A fulltext leaf must now reference exactly one index

The same defect lived at three sites in `FulltextCompiler` — `compileLeaf`, `compileRelationshipIndex`, and `compileRelationship` — each guarding the empty case and then reading `Object.keys(input)[0]`:

```typescript
// ❌ before: searched CategoryNameIndex only, dropped CategoryBlurbIndex
//    → CALL db.index.fulltext.queryNodes('CategoryNameIndex', $ft_phrase)
//    → params: { ft_phrase: 'graph' }        // 'neo4j' gone entirely
fulltext: {
  CategoryNameIndex: { phrase: 'graph' },
  CategoryBlurbIndex: { phrase: 'neo4j' },
}

// ✅ AND / OR already existed for this, and compile correctly
fulltext: {
  AND: [
    { CategoryNameIndex: { phrase: 'graph' } },
    { CategoryBlurbIndex: { phrase: 'neo4j' } },
  ],
}
```

**This one is more serious than the sort defect.** A dropped sort key returns the right rows in the wrong order; a dropped *search term* returns the **wrong rows** — a strictly wider result set, because one index was searched instead of two. A filter that silently stops filtering.

Phrase values are never echoed into the error message: they are user data and may carry control characters or sensitive content. Only index names — already identifier-validated — appear.

> **Note:** a characterization test, `should only use the first index when multiple are provided`, previously pinned the dropping behaviour. It described the defect rather than defending it (no rationale, while the sibling `SelectNormalizer` throws for the identical situation), and has been replaced with specs asserting rejection.

### 🐛 `AND` / `OR` / `NOT` must each be the only key in their object

Reviewing the leaf fix surfaced the same defect one level up, in the operator dispatch. `compileNode` tests `OR`, then `AND`, then `NOT`, and returns at the first hit — so anything else in the object was discarded without a word:

| Input | Compiled | Effect |
| --- | --- | --- |
| `{ OR: […], AND: […] }` | `OR` only | a filter disappears |
| `{ OR: […], SomeIndex: {…} }` | `OR` only | a filter disappears |
| `{ NOT: {…}, AND: […] }` | **`AND` only** | **the exclusion disappears** |

The third row is the dangerous one. `AND` is tested before `NOT`, so a `NOT` written alongside it vanished completely — the caller asked to *exclude* something and got no exclusion at all. That inverts intent rather than merely widening the result set.

Operators nest; they do not stack:

```typescript
// ✅ correct
fulltext: { AND: [{ OR: [ /* … */ ] }, { CategoryBlurbIndex: { phrase: 'x' } }] }

// ❌ rejected
fulltext: { OR: [ /* … */ ], AND: [ /* … */ ] }
```

Sibling keys are **counted, never echoed** — unlike leaf index names they have not been identifier-validated at dispatch time, so interpolating them could forge log lines.

### 💥 BREAKING — generated `<Type>Sort` and `<Type>FulltextLeaf` types are now single-key

Both are wrapped in a new `ExactlyOneKey<T>` utility type, so a two-key entry is a **compile error** rather than a silent truncation. Unknown fields and invalid directions are rejected as before.

```typescript
export type SafedoseCategorySort = ExactlyOneKey<{
  isUrgent?: InputMaybe<SortDirection>;
  position?: InputMaybe<SortDirection>;
}>;

export type SafedoseCategoryFulltextLeaf = ExactlyOneKey<{
  CategoryNameIndex?: FulltextIndexEntry;
  CategoryBlurbIndex?: FulltextIndexEntry;
}>;
```

Nested relationship index objects are wrapped too, since `compileRelationshipIndex` reads a single key as well.

`<Node>FulltextInput` keeps its `leaf | OR | AND | NOT` shape, but each operator member now marks the other two `?: never`:

```typescript
export type SafedoseCategoryFulltextInput =
  | SafedoseCategoryFulltextLeaf
  | { OR: SafedoseCategoryFulltextInput[]; AND?: never; NOT?: never }
  | { AND: SafedoseCategoryFulltextInput[]; OR?: never; NOT?: never }
  | { NOT: SafedoseCategoryFulltextInput; OR?: never; AND?: never };
```

This closes operator-vs-operator stacking at compile time. It deliberately does **not** close an operator mixed with a bare index key (`{ OR: [...], SomeIndex: {...} }`) — TypeScript permits a literal property that exists on any member of a union, so that shape stays a runtime rejection.

This lands when you **regenerate types**, and it breaks conditional sort building from an empty object literal. Push entries instead:

```typescript
// before — no longer compiles
const s: BookSort = {};
if (byTitle) s.title = 'ASC';

// after
const sort: BookSort[] = [];
if (byTitle) sort.push({ title: 'ASC' });
```

Types with no sortable fields emit `Record<string, never>` rather than collapsing to `never`. `<Type>Options` is unchanged.

### 🛡️ Runtime guards for the paths types cannot reach

Types alone are not sufficient, so every surface validates arity at compile time too — `compileSortClause` via `assertSingleSortKey`, the three `FulltextCompiler` leaf sites via `assertSingleFulltextKey`, and the operator dispatch via `assertSingleFulltextOperator` — alongside the `assertSafeIdentifier` checks already in those loops. This matters because `FindOptions<TSort>` defaults to `Record<string, 'ASC' | 'DESC'>` — an index signature — so the untyped `ogm.model('X')` path admits multi-key entries regardless, and "exactly one arbitrary key" is not expressible over an open record. The GraphQL-resolver path erases the types too, and operator-plus-index-key is not expressible in the union at all. The errors name the offending keys and show the correct form:

```
Sort entry has 2 keys (isUrgent, position); each sort entry must carry exactly
one ordering key, because ORDER BY precedence comes from array position and not
object key order. Use one entry per key: [{ isUrgent: 'DESC' }, { position: 'ASC' }].

Fulltext leaf has 2 keys (CategoryNameIndex, CategoryBlurbIndex); a fulltext entry
must reference exactly one index. Combine indexes with the AND / OR operators
instead: { AND: [{ CategoryNameIndex: … }, { CategoryBlurbIndex: … }] }.

Fulltext input carries AND + NOT; AND / OR / NOT must each be the only key in
their object, because the compiler reads the first one and ignores the rest.
Nest them instead: { AND: [{ OR: [...] }, { ... }] }.
```

Every key is identifier-validated (not just the first), so an unsafe identifier in a non-surviving key is now caught too. Only recognised sort directions are echoed into the error string, and fulltext phrases never are. **Zero-key sort entries (`{}`) keep their existing runtime skip** — they contribute no ordering rather than a wrong one, so there is no silent-wrong-answer to close, though the new types do reject the literal. Empty fulltext inputs still throw, unchanged.

### 🛡️ Malformed inputs now throw `OGMError` instead of a bare `TypeError`

`sort: [null]` surfaced as `TypeError: Cannot convert undefined or null to object` thrown from inside `Object.entries`, and fulltext inputs failed the same way on `Object.keys(input)` / `'OR' in input`. Both escaped `catch (e) { if (e instanceof OGMError) … }`, even though every other malformed input on those paths was already an `OGMError`.

A new `assertPlainObject` guards each enumeration point: sort entries, fulltext inputs (in `compileNode`, so operator recursion such as `{ OR: [null] }` is covered too), index entry values (`{ BookSearch: null }`), and the standalone relationship fulltext entry. Only the value's **kind** is reported — never the value:

```
Sort entry must be an object, got null.
Fulltext entry "BookTitleSearch" must be an object, got null.
```

### Tests

Nine compiler specs covering multi-key rejection, the error's key list and suggested form, three-key arity, a multi-key entry in a non-first position, multi-key `@cypher` entries failing before any `CALL` is emitted, unsafe identifiers in non-surviving keys, refusal to echo unrecognised directions, the documented form still compiling to both `ORDER BY` terms, and zero-key entries still skipped.

Eight **integration** specs (`tests/sort-entry-arity.spec.ts`) drive the public API rather than the compiler, proving the guard is actually reached from `Model.find` / `Model.findFirst` / `InterfaceModel.find` — and that it fires **before any query reaches the driver**, so there is no round-trip returning wrongly-ordered rows. Verified as genuine regression coverage: with the guard disabled, exactly the 11 arity specs fail and every pre-existing sort spec still passes.

Eight non-object specs guard the `OGMError` contract — five sort-entry kinds (`null`, `undefined`, array, string, number), a bad entry in a non-first position, and refusal to echo the offending value; plus four on the fulltext side covering a non-object top level, one nested inside an `OR` branch, a non-object index entry value, and kind-without-value reporting.

Fourteen fulltext compiler specs: four on leaf arity (rejection, the AND/OR remedy appearing while phrases never do, both indexes compiling under `AND`, single-index leaves unchanged) and six on operator arity (two stacked operators, `NOT` alongside `AND`, an operator mixed with a bare index key, sibling keys counted rather than echoed, a single operator unchanged, and properly nested operators). Disabling either guard fails exactly its own specs and no others.

Seven emitter specs cover the `ExactlyOneKey` wrapper for node and interface `Sort` types, the no-sortable-fields fallback, `<Type>Options` referencing `<Type>Sort` unchanged, the fulltext leaf wrapper, the nested relationship index wrapper, and the mutually-exclusive operator members on `<Node>FulltextInput`.

Generated output was additionally verified end-to-end under `tsc --strict` against a schema carrying an interface, a `@cypher` sort field, two fulltext indexes, and a relationship-only type. Failing to compile: the reported sort shape, multi-key `@cypher` entries, three-key entries, multi-key interface entries, unknown sort fields, invalid directions, empty entries, sorting an unsortable type, two-index fulltext leaves, unknown index names, `OR` + `AND`, and `NOT` + `AND`. Compiling cleanly: the documented sort form, `@cypher` and interface sorts, incremental array building, single-index leaves, scores, `AND` / `OR` / `NOT` composition — and, as documented above, operator-plus-index-key, which the runtime rejects instead. Full suite green (1673); lint and format clean.

---

## 1.14.0 (2026-07-24) — 🛡️ Security release: NLS enforcement on interface reads & relationship writes, and a `_MATCHES` ReDoS guard

> **Three security fixes.** Two are object-level authorization gaps: grafeo's node-level-security (NLS) policies were threaded correctly through the concrete-model read and write paths, but two paths silently skipped the **target type's** policy — nested relationship projections on **interface** reads, and **connect/disconnect** relationship writes — so a caller whose own access was correctly scoped could still read, or link/unlink, related nodes their policy forbids. The third hardens the `_MATCHES` filter operator against server-side ReDoS. If you use `policies` with interface models or nested `connect`/`disconnect`, or expose `_MATCHES` to untrusted input, upgrade.

### 🛡️ Interface reads now apply the target type's `read` policy to nested projections

`InterfaceModel.find` (and its `findFirst` / `findUnique` / `*OrThrow` siblings, which all route through it) applied the interface's source-side policy and the WHERE-side traversal policy — but compiled the **RETURN projection** without the read `policyContext` that `Model.find` passes. Every nested relationship pattern comprehension was therefore emitted with **no target-type policy**, so an interface query could project fields of related, policy-protected node types (e.g. another tenant's `author { email }`) that the target type's `read` policy is meant to filter out. The leak was silent and spanned every row the interface query returned.

The fix threads the resolved read `policyContext` into the interface selection compile, exactly as the concrete-model path already does, so every nested projection AND-stitches the target type's read policy — including union and connection branches. **When no policy layer is configured the emitted Cypher is byte-identical** to before; the guard engages only when a policy actually resolves for the projected type.

### 🛡️ Nested `connect` / `disconnect` now enforce the target type's `read` policy

`MutationCompiler` was policy-unaware: the target `MATCH` emitted for a nested `connect` (MERGE) or `disconnect` selected the target node by the caller's `where` alone, with no policy. A caller operating under a bound `withContext(ctx)` — whose *source* node was correctly policy-filtered — could therefore link or unlink relationships to arbitrary target nodes their policy should forbid (cross-tenant / cross-owner relationship writes):

```typescript
// `Book` has a read policy scoped to the owner. Previously this linked a
// foreign Book anyway — the target MATCH carried no Book policy. Now it
// AND-stitches the Book read policy, so an unreadable target fails to
// match and the MERGE is a no-op.
ogm.withContext({ uid }).model('User').update({
  where: { id: myId },
  connect: { ownedBooks: { where: { id: someBookId } } },
});
```

The fix threads the resolved policy context into `MutationCompiler` and AND-stitches the target type's `read` policy into every connect/disconnect target `MATCH` — all seven sites (single / array / `UNWIND` connect, specific disconnect, nested-in-update connect and disconnect, union targets), reached from both `update` and `updateMany`. `read` is the correct gate: row-level target visibility is expressed as the `read` policy, while `create`/`update` restrictives are WITH-CHECK predicates over a mutation-input bag that a referenced existing node has none of. **No-policy, bypass (`unsafe.bypassPolicies`), and no-target-policy paths stay byte-identical**; `create` and `upsert` (which never emits a relationship `MATCH`) are untouched. Policy predicates use the mutation's shared, monotonic parameter counter, so they never collide with the caller's `connect`/`disconnect` `where` params.

### 🛡️ `_MATCHES` is now guarded against catastrophic-backtracking regexes (ReDoS)

The `_MATCHES` filter operator forwards its value into a Neo4j `=~` predicate, which the server evaluates with Java's **backtracking** regex engine. An attacker able to influence a `where` filter could supply a catastrophic pattern (e.g. `(a+)+$`, `([a-z]+)+$`, `(a?)+$`) and pin shared Neo4j CPU — a server-side ReDoS ([CWE-1333](https://cwe.mitre.org/data/definitions/1333.html)). Parameterization stops injection but not this: the payload *is* the regex.

Every `_MATCHES` value is now validated at compile time by a **sound-by-construction** guard. Rather than blocklisting known-bad shapes (always incomplete), it accepts a pattern **only when it can prove the pattern is linear**, and refuses everything it cannot model — alternation, quantified groups, lookaround, backreferences, unsupported escapes. The check is single-pass and bounded, so it cannot itself become a DoS vector, and Java-flavor divergences are modeled soundly (`\v` is the vertical-whitespace class; `\0`/octal escapes are refused; only inline flags that don't change the analysis — `i`/`m`/`s`/`d` — are honored, so `(?x)` COMMENTS mode and `(?u)`/`(?U)` Unicode widening are refused).

- **Precision cost (intended, fail-closed).** Some linear-but-unprovable patterns are refused — notably **all alternation** (`(cat|dog)`) and **contains-style** `.*x.*` shapes. Reach for the dedicated, always-safe operators (`_CONTAINS` / `_STARTS_WITH` / `_ENDS_WITH` / `_IN`), simplify the pattern, or disable `_MATCHES` entirely via `features.filters.String.MATCHES` if you must run arbitrary regexes and accept the risk. The refusal error names these options.
- **Common patterns keep working** — anchors, character classes, single wildcards (`^foo.*bar$`, `[A-Za-z0-9_]+`, `\d{3}-\d{4}`), fenced quantifiers (`[a-z]+@[a-z]+\.[a-z]+`), and inline-flag prefixes (`(?i)…`).

### Tests

Interface-read policy: two specs asserting the nested projection now carries the target `read` predicate for interface reads, and that the no-policy path stays byte-identical. Connect/disconnect policy: six specs covering connect and disconnect target MATCHes carrying the target `read` policy, the update-op-not-stitched case, byte-identical no-policy/bypass Cypher, and non-colliding parameter numbering. ReDoS guard: a 100+-case battery covering every known catastrophic family (nested quantifiers, nullable/overlapping alternation under repeat, custom-class and nested-group bases, unrolled adjacent optionals), fail-closed refusal of unmodeled constructs, acceptance of provably-linear patterns, and the three Java-flavor soundness regressions found and closed during adversarial review (`(?x)`, `\v`, `\0`). Full suite green (1629); lint and format clean.

---

## 1.13.0 (2026-07-14) — ✨ `$cloneSubgraph` returns `nodesByLabel`

> **First community-requested feature** ([#1](https://github.com/neomodular/grafeo-ogm/issues/1)). After deep-cloning a content subgraph, a caller often needs to post-process only the nodes of a **specific label** (re-normalize, re-stamp, re-index). Until now `nodeMapping` held every cloned id across all labels, forcing a broad-`IN`-plus-label-filter dance on the caller. The clone already visits every node with its labels in hand — so now it just tells you.

### ✨ `nodesByLabel: Map<label, newId[]>` on the clone result

- **Additive and backwards-compatible** — `clonedRootId` and `nodeMapping` are unchanged; existing callers are unaffected.
- **Zero extra round-trips** — `labels(output)` is folded into the existing Step-1 `RETURN` of the APOC clone query.
- **Multi-label nodes appear under each of their labels**, so `nodesByLabel.get('DoseValue')` is exactly the set you post-process.
- **Consistent by construction** — `nodesByLabel` is built in the same pass as the final `nodeMapping`, so a node dropped during UUID re-assignment is absent from *both* maps: every id in `nodesByLabel` is also a `nodeMapping` value.

```typescript
const result = await ogm.$cloneSubgraph(rootId, config, tx);
const doseValueIds = result.nodesByLabel.get('DoseValue') ?? [];
// target exactly one label — no over-broad IN list
```

### 🛡️ CLI display hardening — `db push` sanitizes live-DB names

Names introspected from the live database that fail identifier validation are correctly routed to `unmanaged` and never executed as Cypher — but they were printed **raw**. Neo4j allows arbitrary characters in backtick-quoted identifiers, so a hostile constraint/index name could smuggle ANSI/C0 escape sequences into the developer's terminal (title changes, output spoofing). All live-DB names rendered by `db push` (unmanaged, orphan listings, drop confirmations) now pass through a `safeDisplay()` helper that replaces C0/C1 control characters with a visible `�` placeholder. Cypher execution was never affected — this closes the display path.

### 📝 Docs

- Fixed the `cloneSubgraph` README snippet: the result field is `nodeMapping`, not the stale `idMapping`, and the config examples now include the required `maxLevel`.

### Tests

Four new subgraph specs (label grouping, root-label → `clonedRootId` linkage, multi-label fan-out, UUID-failure consistency across both maps) plus a CLI spec proving a hostile constraint name lands in `unmanaged`, prints sanitized, and never reaches a `DROP`. Full suite green (1514); lint, format, and type-check clean.

---

## 1.12.0 (2026-07-01) — 🛡️ `OR: []` now matches nothing (Prisma semantics)

> **Safety fix, and the one deliberate compat break with `@neo4j/graphql-ogm`.** An empty logical `OR` array used to vanish from the compiled WHERE clause, so `deleteMany({ where: { OR: [] } })` compiled **byte-identical to no `where` at all**: `MATCH (n:Label) DETACH DELETE n` — a full-label wipe. The realistic trigger is a dynamically built filter (`OR: ids.map((id) => ({ id }))`) receiving an empty list. The deprecated `@neo4j/graphql-ogm` (verified against its final release, 5.11.4) has the same behavior, so grafeo was bug-for-bug compatible. We now diverge on purpose.

### 🛡️ Empty `OR` compiles to `false` — everywhere

Per Prisma's documented operator semantics (`OR` with 0 filters → empty result; `AND` with 0 filters → all items), an `OR` with **zero effective disjuncts** now compiles to the literal Cypher clause `false`:

- **Top-level where** — `find` / `findFirst` / `count` / `aggregate` return nothing; `updateMany` / `deleteMany` touch nothing.
- **All-no-op disjuncts count as empty** — `OR: [{}]` and `OR: [{ name: undefined }]` also compile to `false`, matching Prisma's "effective filter" counting. Mixed arrays keep the effective disjuncts: `OR: [{}, { name: 'x' }]` → `(n.name = $param0)`.
- **Nested relationship quantifiers** — `posts_SOME: { OR: [] }` compiles to an unsatisfiable `EXISTS { ... WHERE false }` instead of "any related node".
- **Connection filters** — `postsConnection_SOME: { OR: [] }` likewise.
- **Nested mutation operations** — `update.<rel>.disconnect[].where: { OR: [] }` used to detach **every** related node (and `connect` to attach every candidate); both now compile an unsatisfiable `WHERE false`.

`AND: []` is unchanged and still matches everything — the empty conjunction is true, also per Prisma. `where: undefined` / `where: {}` remain the explicit, intentional "match all" forms. Fulltext `OR`/`AND` already threw on empty arrays and are unaffected.

### 🔎 Compiler warning on empty logical operators

When a logical operator compiles with zero effective conditions, the compiler now emits a `warn` through your configured `OGMConfig.logger` — `OR` warns "matches nothing", `AND` warns "matches everything" — so a dynamically built filter that received an empty list is visible in your logs instead of silently changing query shape. Fires only on the anomalous branch (zero hot-path cost), no-ops when no logger is configured or the logger has no `warn` method.

### Tests

Regression coverage for the full blast radius: compiler-level (`OR: []`, `AND: []`, all-no-op disjuncts, mixed disjuncts, sibling-condition stitching, `NOT: { OR: [] }`, nested quantifier, connection filter), mutation-level (nested `connect`/`disconnect` with `OR: []`), model-level (`deleteMany({ where: { OR: [] } })` emits `WHERE false`, not a wipe), and warning-level (logger `warn` fired for empty `OR`/`AND`/all-no-op disjuncts, silent for effective operators and `warn`-less loggers). Full suite green (1509); lint, format, and type-check clean.

---

## 1.11.0 (2026-06-13) — ✨ `grafeo init` logo splash

> **A little polish on the way in.** An interactive `grafeo init` now opens with the grafeo wordmark — the ANSI Shadow logo in blueprint blue. It's purely decorative and rigorously gated: it appears **only** when stdout is a real terminal, so a piped or redirected run (`grafeo init > file`, `grafeo init | tee`) and any CI run get clean, unadorned output. **No new runtime dependency** — the wordmark is embedded statically (no runtime `figlet`), routed through the existing IO seam, and `NO_COLOR` is honored.

### ✨ Decorative wordmark on interactive `init`

- **TTY-gated on stdout, not stdin.** The splash gates on whether **stdout** is a TTY (`io.stdoutTTY`), distinct from the stdin-based `interactive` flag that gates prompts. This is the correctness fix that matters: redirecting output (`> file`, `| tee`) no longer leaks ANSI art into captured output, even from an interactive shell.
- **CI-safe.** Suppressed whenever `CI` is set, regardless of TTY state.
- **`NO_COLOR` honored, by presence.** Any presence of `NO_COLOR` — including an empty string, per [no-color.org](https://no-color.org) — prints the wordmark uncolored.
- **Zero footprint.** The logo is a static string table; no runtime `figlet` dependency, no change to the published runtime deps (still just `jiti`).

### Tests

New `logo` unit coverage (TTY-on colored, non-TTY no-op, CI no-op, `NO_COLOR` suppression including the empty-string presence case) plus two `init` integration cases (splash shown when stdout is a TTY; suppressed when stdout is redirected even with an interactive stdin). Full suite green (1494); lint, format, and type-check clean.

---

## 1.10.1 (2026-06-13) — neo4j-driver 6 support

> grafeo-ogm now declares compatibility with **neo4j-driver 6** alongside 5 — the peer range widens to `^5.0.0 || ^6.0.0`. **No code or API change.** grafeo never used the accessors driver 6 removed (`Node.identity` / `Relationship.start` / `Relationship.end`), and only touches stable core APIs (`neo4j.driver`, `auth`, `int`, `isInt`, `types.*`), so the full test suite — and the TypeScript type-check — passes unchanged against driver `6.1.0`. v6 users no longer get a spurious peer-dependency warning on install. (Verified at the unit + type level; the session/wire API grafeo uses is stable across the 5→6 boundary.)

---

## 1.10.0 (2026-06-13) — 🚀 `grafeo init`

> **The fastest way into grafeo.** `grafeo init` sets a project up in one step — and for the *existing* grafeo user adopting the CLI, it auto-wires itself: it finds your schema and your generated types and writes a ready `grafeo.config.ts` pointing at them. Greenfield? It scaffolds a starter schema (the Neo4j movie graph) and config. Either way you get an npm `generate` script. Interactive by default, fully non-interactive (`--yes`) for CI, and non-destructive throughout.

### ✨ `grafeo init` — scaffold, or auto-detect an existing project

- **Autodetection.** In a project that already uses grafeo, `init` locates the SDL schema (by its `@node`/`@relationship` directives — a bare GraphQL file is *not* mistaken for it) and a previously generated types file (by the generator's header line), and pre-fills `grafeo.config.ts` with those paths. Multiple schema candidates → it asks which.
- **Greenfield scaffold.** With nothing to detect (or `--fresh`), it writes a starter `schema.graphql` — the classic Neo4j movie example (`Movie`/`Person`, `ACTED_IN`/`DIRECTED`) — and a config.
- **npm script.** Adds `"generate": "grafeo generate"` to `package.json` (an existing `generate` script is preserved, never clobbered).
- **Optional seed.** `--seed` scaffolds an upsert-based `seed.ts` stub.
- **Non-destructive.** Never overwrites an existing config/schema/seed without `--force` (or an interactive confirmation); re-running `init` is safe.
- **No secrets, no new deps.** Connection settings reference `NEO4J_*` env vars (never prompted); prompts use `node:readline/promises`. The runtime footprint is unchanged.

Flags: `--schema`, `--out`, `--seed`, `--fresh`, `--yes`, `--force`. The README quickstart now leads with `npx grafeo init`.

### Tests

New `detect` + `init` coverage (14 cases): autodetection (single/multiple/none, directive-gated, marker-anchored), greenfield scaffold, `--fresh`, non-destructive config/seed writes, npm-script add/preserve, non-interactive `--yes`, no-secret-prompt, and a regression test that a quote-bearing path is safely escaped into the config (no injection). Full suite green; lint, format, type-check clean.

---

## 1.9.1 (2026-06-13) — 🩹 `grafeo generate` formatting DX

> **A first-run papercut from the 1.9.0 CLI.** Prettier is a *dev* dependency (kept out of the runtime footprint on purpose), so a consumer who runs `grafeo generate` without prettier installed got a terse `Prettier formatting failed; output written without formatting.` — accurate, but unhelpful. The output was always valid TypeScript; only the message was poor. `1.9.1` makes that path friendly and honest.

### 🩹 Actionable "formatting skipped" warning

When prettier isn't available, the generator now detects the missing-module case specifically and emits: *"prettier is not installed — generated types were written unformatted. Run `npm i -D prettier` for formatted output, or set `generate.formatOutput: false` to silence this warning."* A genuine prettier *error* (as opposed to a missing install) now reports its actual detail instead of a generic string. The warning carries a dedicated `FORMATTING_SKIPPED` code (previously mislabeled `UNSUPPORTED_TYPE`).

### 🔧 prettier declared as an optional peer dependency

`prettier` is now listed under `peerDependencies` with `peerDependenciesMeta.prettier.optional = true`. This documents the relationship for tooling and package managers without auto-installing it — the runtime footprint is unchanged (still just `jiti`), and consumers who want formatted codegen opt in by installing prettier.

### Tests

Added coverage that forces the prettier-missing path and asserts the actionable `FORMATTING_SKIPPED` warning. Full suite green; lint, format, and type-check clean.

---

## 1.9.0 (2026-06-13) — 🚀 the `grafeo` CLI

> **The first developer-facing command-line tool.** Until now grafeo-ogm was a library you imported; the schema-to-types step, the constraint/index provisioning, and seeding were all things you wired up by hand. `1.9.0` ships `grafeo` — a thin, lazy-loaded CLI over machinery the library already had. Three commands: `grafeo generate` (codegen, including a CI staleness gate), `grafeo db push` (declarative constraint/index sync against a live database), and `grafeo db seed` (idempotent project seeding). Config lives in a typed `grafeo.config.ts`. **The CLI adds exactly one runtime dependency (`jiti`), and importing the library doesn't pull it in.** No library API surface changed; existing consumers upgrade transparently.

### ✨ `grafeo generate` — codegen with a CI staleness gate

Wraps the existing `generateTypes()` so the type-emit step is no longer bespoke per project. Three modes:

- **One-shot** (default) — read schema, emit the TypeScript file, exit.
- **`--watch`** — re-emit on schema change via a debounced `fs.watch`, with a `--poll <ms>` fallback for filesystems where native watch events are unreliable (network mounts, some container bind-mounts).
- **`--verify`** — emit into memory and byte-compare against the on-disk file. Writes **nothing**; exits `1` on drift. This is the CI gate: a build fails if a committed types file has fallen behind its schema, the same way a `git diff --exit-code` after codegen would, but without a working-tree mutation.

### ✨ `grafeo db push` — declarative constraint & index sync

Diffs the constraints and indexes **declared in your SDL** against what's actually live in the database, then reconciles them. Declarations are derived from directives: `@id`/`@unique` → unique constraints, `@fulltext` → fulltext indexes, `@vector` → vector indexes. The live state is read via `SHOW CONSTRAINTS` / `SHOW INDEXES`.

The planner sorts everything into four buckets and prints them before touching anything:

- **create** — declared in SDL, missing in the DB.
- **in-sync** — declared and already present.
- **orphans** — managed-looking artifacts present in the DB but no longer declared in SDL (candidates for removal).
- **unmanaged** — DB artifacts outside grafeo's naming convention, left strictly untouched (hand-rolled DBA constraints, other tools' indexes).

`push` is **additive-by-default and idempotent** — re-running it is a no-op once in sync, and it never drops anything on the happy path. Destructive orphan drops are gated behind `--force-drop` **and** `--yes` (or an interactive confirmation); `--dry-run` prints the plan and exits without executing. Orphan detection is scoped by naming convention, so DBA-created constraints never even enter the orphan bucket — they land in *unmanaged* and are left alone.

### ✨ `grafeo db seed` — idempotent project seeding

Runs your project's seed script — resolved as config `seed` → `./seed.ts` → `./seed.js` — handing it a fully constructed, **already-connected** OGM so the script doesn't re-derive connection details. The driver is **always closed**, including when the seed script throws, so a failed seed never leaks a live connection. The docs promote `upsert` for seed data specifically because it's idempotent: re-seeding a populated database converges instead of duplicating.

### ✨ Config: `grafeo.config.ts` and connection precedence

Configuration loads from `grafeo.config.ts` / `.js` / `.json`, transpiled on the fly via `jiti` (the single new runtime dependency). A `defineConfig` export gives you full type inference on the config object. Connection settings resolve by precedence: **explicit flag > config file > `NEO4J_*` environment variables**.

One deliberate omission: **the password is never accepted as a CLI flag.** A password passed on the command line leaks into process listings (`ps`), shell history, and CI logs — so it must come from config or the environment. This is a security constraint, not an oversight.

### Lazy loading — `generate` doesn't touch the driver

Commands are loaded lazily so the cheap path stays cheap. `grafeo generate` does pure codegen and **never loads `neo4j-driver`** — only `db push` / `db seed` pull in the driver, and only when invoked. Symmetrically, importing the library from application code does **not** pull in `jiti`; the config loader lives behind the CLI entry point. No bloat leaks in either direction.

### Internal — single source of truth for constraint/index Cypher (no behavior change)

The Cypher that creates constraints and indexes was previously emitted inside `OGM.assertIndexesAndConstraints()`. `db push`'s planner needs the *same* statements to diff against the live DB, so that generation was extracted into one module — `src/schema/index-statements.ts` — now shared by both `assertIndexesAndConstraints()` and the planner. The emitted statement text and ordering are **byte-identical** to 1.8.7; this is a pure refactor with no behavioral effect on existing OGM users.

### SECURITY — orphan `DROP CONSTRAINT` re-validates the introspected name

The orphan-drop path takes a constraint *name read back from the live database* and puts it into a `DROP CONSTRAINT` statement. Constraint names are normally grafeo-generated and safe, but a live database can carry a name with unsafe characters (created by another tool, or maliciously). Before any introspected name enters Cypher, it is now re-validated through `assertSafeIdentifier`. A name that fails validation is **demoted to *unmanaged*** — it is never dropped, and the destructive path never runs against an untrusted identifier. Defense in depth: the drop path treats DB-sourced names with the same suspicion as user input.

### Minor — NLS audit metadata version bump

NLS audit metadata now emits `ogmPolicySetVersion: "1.7.0"`, dropping the stale `-beta.0` pre-release suffix it had been carrying. The policy format reached GA in 1.7.0 and is unchanged — this only corrects the reported version string. If you assert on the exact audit-metadata value, update your expectation from `1.7.0-beta.0` to `1.7.0`.

### Tests

New CLI coverage for all three commands and the config loader: `generate` one-shot/`--watch`/`--verify`-drift, the four-bucket `db push` planner with additive/idempotent/`--dry-run`/`--force-drop` paths and the unsafe-name demotion, `db seed` driver-always-closed-on-failure, and connection precedence. The `index-statements.ts` extraction is pinned by byte-identical statement assertions against the prior `assertIndexesAndConstraints()` output. Full suite green; lint, format, and type-check clean.

---

## 1.8.7 (2026-06-12) — 🚨 SECURITY + correctness

> **Three HIGH correctness bugs, two subgraph guards, and three security hardenings** from the post-1.8.6 comprehensive audit. Two of the three HIGH bugs are "fixed one site, missed the sibling" regressions of earlier fixes (v1.8.1 and v1.8.3) — sibling-site sweeps are now part of the fix checklist. Upgrade if you use `withContext`, nested relationship updates, union relationship filters, write restrictives, or subgraph operations.

### HIGH — `OGMWithContext.model(interfaceName)` reintroduced the v1.8.3 type-lying bug

v1.8.3 made `ogm.model('SomeInterface')` throw a descriptive `OGMError`. The per-request context wrapper — the entry point every NLS consumer uses — kept the pre-1.8.3 fallthrough: an interface name returned an `InterfaceModel` cast to `any`, so the first mutation call from typed code crashed with `TypeError: this.create is not a function`. The wrapper now enforces the same contract in **both** directions: `model(interfaceName)` throws and points at `interfaceModel()`, and `interfaceModel(nodeName)` throws `Unknown interface type` instead of returning a `Model` cast to `InterfaceModel`. `interfaceModel()` owns its own construction and cache now (it previously delegated through the buggy `model()` fallthrough).

### HIGH — nested `update.<rel>[].update` WHERE compiled operator suffixes as plain equality

v1.8.1 routed nested `disconnect[].where` and `connect[].where` through the connection-aware WHERE compiler — but missed the third sibling: the **nested update** path. `where: { node: { name_CONTAINS: 'x' } }` compiled to ``u.`name_CONTAINS` = $p`` — a non-existent property lookup that matches nothing — so the nested update was a **silent no-op**. `AND`/`OR`/`NOT` wrappers became bogus property predicates the same way. Now routed through `buildConnectionWhereConditions` like its siblings. Plain-equality inputs keep byte-identical param names (`update_<rel>_<i>_where_<prop>`); `edge` filters now throw loudly instead of silently never matching.

### HIGH — union relationship `_ALL` and `_SINGLE` silently behaved as `_SOME`

For union-typed relationships, `chapters_ALL: {...}` and `chapters_SINGLE: {...}` compiled to the same OR-of-EXISTS as `_SOME` — wrong rows, no error. A node with five matching chapters passed `_SINGLE`; a node with one failing chapter passed `_ALL`. Both now implement real quantifier semantics mirroring the non-union shapes:

- `_ALL` — per mentioned member, `NOT EXISTS { MATCH … WHERE NOT (inner) }`, AND-combined. Members with an empty predicate are vacuously satisfied; unmentioned union members are unconstrained (consistent with `_SOME`).
- `_SINGLE` — summed `size(…)` pattern comprehensions `= 1` across mentioned members. `@cypher`-projecting members (user fields or target policies) are rejected with an `OGMError`, mirroring the non-union `_SINGLE` contract.

v1.8.5's per-member target-policy stitching is preserved in both shapes.

### MEDIUM — subgraph operations: empty filter arrays meant "delete/clone EVERYTHING reachable"

`apoc.path.subgraphAll` treats an empty `relationshipFilter`/`labelFilter` string as "no constraint", so `$deleteSubgraph(rootId, { ownedLabels: [], ownedRelationships: [], … })` DETACH-DELETEd the **entire connected component** reachable from the root. `validateConfig` now rejects empty `ownedLabels`/`ownedRelationships` before any Cypher runs (both clone and delete). Validation errors also carry the real operation and rootId — they were previously hardcoded to `'clone'` with an empty rootId, misdirecting delete-path debugging.

### SECURITY — write restrictives now require explicit positive consent

`WriteRestrictivePolicy.when` verdicts were checked with `=== false`, so `undefined`/`null`/`0`/`''` returns silently **allowed** the write. The classic foot-gun — `when: (ctx, input) => ctx.canWrite && input.tenantId === ctx.tenantId` with an anonymous ctx — returns `undefined` and passed. Both evaluation sites (create-path and update-path) now require an explicit `true`; anything else throws `PolicyDeniedError`. **Behavior change:** policies returning truthy non-`true` values (e.g. a string) now deny — return a real boolean.

### SECURITY — `withContext` ctx is now a deep-frozen snapshot

`Object.freeze({ ...ctx })` was shallow: a policy callback could mutate nested ctx state (`ctx.user.roles.push('admin')`) and every subsequent policy decision in the same request — including nested-selection target policies — saw the escalated context. ctx is now a **deep-frozen clone** (`deepFreezeSnapshot`): plain objects/arrays are cloned recursively and frozen; class instances, Dates, Maps, and functions are kept by reference and left unfrozen. The caller's original objects stay mutable. **Behavior change:** policies must not rely on reference identity between nested ctx objects and external state (top-level identity was already broken by the spread).

### SECURITY — mutation property names now reject `__proto__`/`constructor`/`prototype`

The WHERE compiler has always blocked prototype-pollution names via `assertSafeKey`; the mutation compiler validated identifier shape only, so `model.create({ input: JSON.parse('{"__proto__": "evil"}') })` persisted a literal `__proto__` property to Neo4j. Reads through the OGM were safe (`Object.create(null)` in ResultMapper), but downstream consumers doing `Object.assign({}, node)` would re-trigger setter semantics. All mutation property-name sites (create/update/createMany/merge keys/edge properties/nested updates/mutation WHEREs) now route through a combined `assertSafePropertyName` guard. **Behavior change:** schemas with properties literally named `constructor`/`prototype` can no longer write them via the OGM — they already couldn't query them.

### Tests

24 new regression tests (union quantifiers, nested-update WHERE shapes, wrapper contract both directions, deep-freeze unit + integration, verdict strictness, subgraph guards, `__proto__` rejection). Full suite: 1414 tests, 63 suites, all green. Lint and type-check clean.

---

## 1.8.6 (2026-05-07)

> **DX fix.** Re-export `CypherAssert`, `Neo4jRecordFactory`, and `SelectionSetFactory` from the main entry. Consumers on legacy module resolvers (TypeScript `moduleResolution: "node"`, older Jest configs without subpath-imports support) can now do `import { CypherAssert } from 'grafeo-ogm'` without needing a `.d.ts` shim or a `moduleNameMapper` workaround.

### What was happening

The `grafeo-ogm/testing` subpath export has shipped since v1.0 — it works perfectly on modern resolvers (`moduleResolution: "bundler"` / `"node16"` / `"nodenext"`). But on legacy `"node"` resolution (still common in Jest configs and older TypeScript projects), the subpath wasn't picked up. Consumers had to drop a stub:

```ts
// grafeo-ogm-testing.d.ts (workaround, no longer needed)
declare module 'grafeo-ogm/testing' {
  export * from 'grafeo-ogm/dist/cjs/testing';
}
```

…plus a `moduleNameMapper` entry in `jest.config.js`. That's a four-line workaround on every consumer for a one-line problem on our end.

### Fix

`src/index.ts` re-exports the three testing utilities from `./testing`:

```ts
export {
  CypherAssert,
  Neo4jRecordFactory,
  SelectionSetFactory,
} from './testing';
```

Both import paths now work:

```ts
// Modern resolvers — namespaced (still works, recommended)
import { CypherAssert } from 'grafeo-ogm/testing';

// Legacy resolvers — main entry (now works in 1.8.6)
import { CypherAssert } from 'grafeo-ogm';
```

The dedicated `grafeo-ogm/testing` subpath is preserved — no breaking change, no deprecation. Just one more way in.

### Compatibility

Purely additive. No behavior change, no API surface removal. Consumers who already use the subpath import keep working unchanged.

### Tests

All 1388 tests still pass. Lint, format, and build all clean.

---

## 1.8.5 (2026-05-07) — 🚨 SECURITY ADVISORY

> **CRITICAL.** When a query traversed a relationship in a WHERE filter (`_SOME` / `_NONE` / `_ALL` / `_SINGLE` / `*Connection*` / union-typed relationships), the target type's NLS `'read'` policy was NOT applied inside the `EXISTS` body. A kill-switched org with a leaked target-type ID could use `where: { contentRel_SOME: { id: 'leakedId' } }` as a confirmation oracle / IDOR vector — even when its source-type policy correctly denied direct reads of the target type. **Upgrade immediately if you use NLS policies on target types reachable via relationship filters.**

### Affected versions

`1.7.0` through `1.8.4` (all NLS-enabled releases prior to 1.8.5).

### Severity

**CRITICAL** — survived the v1.7.0 NLS audit, the v1.8.0 perf audit, and the v1.8.2 default-deny security fix. Identified by external reviewers running mutation-style analysis on a downstream service.

### Impact

`WhereCompiler.tryCompileRelationship`, `compileUnionRelationship`, and `tryCompileConnection`/`compileConnectionWhereInput` recursed into target types via `compileConditions(...)` directly — there was no path for the target's `'read'` policy to AND-stitch into the EXISTS body. `SelectionCompiler.compileNestedWhere` already had the correct pattern (re-resolve `targetPolicy` via `policyContext.resolveForType(targetTypeName, 'read')` and inject a synthesized bundle); WhereCompiler did not.

`InterfaceModel.find()` and `aggregate()` had a related gap — they never passed `policyContext` to `whereCompiler.compile()` at all, so even with the source-side fix, user-where relationship traversals on interface entry points still bypassed target-side policy.

### Reproducer

```ts
// User has a permissive NLS policy that grants 'read' iff !ctx.killed.
ogm.policies.register('Content', {
  permissive: [{
    operations: ['read'],
    appliesWhen: (ctx) => !ctx.killed,
    when: () => ({}),
  }],
});

// Attacker's ctx has killed = true. Direct reads correctly return [].
await ogm.withContext({ killed: true })
  .model('Content')
  .findUnique({ where: { id: 'leaked' } });
//   Pre/Post-1.8.5: WHERE false → []  ✅

// Pre-1.8.5 IDOR: traverse via a relationship.
await ogm.withContext({ killed: true, userId: 'attacker' })
  .model('User')
  .find({ where: { contentRel_SOME: { id: 'leaked' } } });
//   Pre-1.8.5 cypher:
//     MATCH (n:User)
//     WHERE EXISTS { MATCH (n)-[:HAS_CONTENT]->(r0:Content) WHERE r0.id = $param0 }
//     RETURN n
//   The User-side policy fires, but Content's appliesWhen never runs.
//   If the attacker has any User row at all (own profile), the EXISTS
//   acts as a confirmation oracle: row exists ↔ leaked Content ID
//   exists in the graph + linked to the attacker's user.
//
// Post-1.8.5 cypher:
//     MATCH (n:User)
//     WHERE EXISTS { MATCH (n)-[:HAS_CONTENT]->(r0:Content)
//                    WHERE (r0.id = $param0) AND false }
//     RETURN n
//   Content's appliesWhen runs → permissives.length > 0 but all abstain
//   → permClause = 'false' → EXISTS can never match → IDOR closed.
```

### Root cause

`WhereCompiler.tryCompileRelationship` (line 856 pre-fix) and the union/connection variants recursed via:

```ts
const innerResult = this.compileConditions(value, relVar, targetNodeDef, ...);
// ❌ No policyContext threaded — target policy never AND-stitched
```

The correct pattern, already present in `SelectionCompiler.compileNestedWhere` (selection.compiler.ts:826-847), is:

```ts
const targetPolicy = policyContext?.resolveForType(targetDef.typeName, 'read');
const targetBundle = targetPolicy ? { ctx, operation: 'read', resolved: targetPolicy, ... } : undefined;
const compiled = this.whereCompiler.compile(value, childVar, targetDef, ..., { policyContext: targetBundle });
// ✅ result.cypher = (user filter) AND (target policy) AND-stitched
```

The fix mirrors this pattern at every WHERE-side relationship-traversal entry point.

### Fix

5 surfaces closed:

- `src/compilers/where.compiler.ts` — `tryCompileRelationship` (`_SOME` / `_NONE` / `_NOT` / `_ALL` / `_SINGLE` quantifiers + bare-relationship shorthand): now builds `targetBundle = buildTargetBundle(targetNodeDef.typeName, policyContext)` and re-enters `this.compile()` with the bundle. Inner result already AND-stitches user + policy; the EXISTS template substitutes it.
- `src/compilers/where.compiler.ts` — `compileUnionRelationship`: same pattern per union member, so each branch enforces ITS OWN target policy (not the union's).
- `src/compilers/where.compiler.ts` — `tryCompileConnection` / `compileConnectionWhereInput`: `node` and `node_NOT` keys now route through `this.compile()` with target bundle. Recursive `AND` / `OR` / `NOT` paths inside connection-where propagate `policyContext` for any nested node-keys to pick up.
- `src/compilers/where.compiler.ts` — `_SINGLE` quantifier: distinguishes user-`@cypher` vs policy-`@cypher` errors so authors get a precise message naming the target type when the policy is the blocker.
- `src/interface-model.ts` — `find()` and `aggregate()` now pass a synthetic `PolicyContextBundle` with `resolved.overridden: true` (no top-level policy clause emit, since CASE-per-label already enforces source-side policy) and live `resolveForType` (so user-where relationship traversals enforce target-side policy via the new WhereCompiler logic).

### What this DOES NOT change

- **No-policy queries** — when no `policyContext` is present, the relationship-traversal code paths short-circuit identically to pre-1.8.5. Byte-identical Cypher emission, byte-identical params, zero overhead.
- **Source-side policy** — the v1.7.0+ AND-stitch of source-type policy at the top-level `WHERE` is unchanged. `compilePolicyClause` is untouched.
- **Edge WHERE** — relationship-properties types are NOT registered in the policy registry by design. No NLS on edges. `compileEdgeConditions` is unchanged.
- **`null` relationship → `NOT EXISTS`** — graph-shape only (no row leakage). Documented as out-of-scope; no change.
- **Policy-on-policy recursion** — when a policy's own `when()` partial uses `_SOME`, the recursive `compileConditions` calls inside `compilePolicyClause` deliberately do NOT thread `policyContext`. Adding this would create infinite-regress risk requiring cycle detection. Documented as deferred to v1.9.0.

### Tests

New file `tests/policy/where-relationship-traversal.spec.ts` — 7 regression tests using a real `WhereCompiler` instance and a real `PolicyContextBundle` with a real `resolveForType` callback. NO mocks of the WhereCompiler or OGM.

Cases covered:
1. `_SOME` + permissive on target → asserts target permissive predicate inside EXISTS body
2. `_NONE` + restrictive on target → asserts restrictive AND-stitched inside `NOT EXISTS { ... }`
3. `_ALL` + default-deny → asserts target unreachable
4. `*Connection { node: {...} }` + permissive on target → asserts connection EXISTS body has policy
5. Union relationship `_SOME: { Image: {...} }` + per-member permissive → policy in `Image` branch only
6. `_SINGLE` + permissive (stored properties only) → works
7. `_SINGLE` + policy with `@cypher` field → throws with target-type-named error

Test count: **1381 → 1388** (+7). All 1388 pass.

**Zero existing tests required modification.** The byte-identical regression contract held: when no `policyContext` is passed, every relationship-traversal path emits the same Cypher as pre-1.8.5.

### Compatibility

Public API surface unchanged. Cypher emission changes ONLY for queries with `policyContext` AND a relationship traversal AND a registered `'read'` policy on the target type — exactly the queries that were silently leaking pre-1.8.5.

### Acknowledgement

Discovered by external reviewers performing mutation-style analysis on a downstream service. Reported, scoped via parallel exploration agents, fixed via parallel implementation agents, tested with real-compiler regression tests, and shipped within hours.

### For consumers writing tests against grafeo-ogm

The failure mode that hid CRIT-3 in downstream services was mocking `clientOgm.find()` itself — those tests proved wiring (the service called the OGM with the right ctx) but never proved authorization (the kill-switch policy actually compiled to `WHERE false`). The robust pattern, used throughout grafeo-ogm's own test suite, is to construct a real `OGM` with a mocked `Driver` (capture `cypher` + `params` via `session.run`), let the real WhereCompiler run, and assert on the captured Cypher. See `tests/policy/where-relationship-traversal.spec.ts` for a concrete example. A first-class `TestDriver` API is planned for v1.9.0.

---

## 1.8.4 (2026-05-07)

> **Backwards-compat fix.** `Model` now always auto-emits `__typename` in default projections — matching `@neo4j/graphql-ogm` behaviour. Apollo Client cache normalisation, type-discriminated unions in TS callers, and any consumer that uses `__typename` as a discriminator now get it on every concrete-type read and mutation, not just on union/interface targets.

### What was happening

```ts
const result = await ogm.model('Book').find({ where: { id: 'b1' } });
// Pre-1.8.4: { id: 'b1', title: 'Dune', pageCount: 412 }
// Post-1.8.4: { __typename: 'Book', id: 'b1', title: 'Dune', pageCount: 412 }
```

Pre-1.8.4, `__typename` was auto-emitted ONLY when the target was abstract (union or interface with implementations) — `selection.compiler.ts:145-158`. Reads of concrete `@node` types (`Book`, `User`, etc.) returned the schema's scalar properties and nothing else. Mutations without explicit selection returned the bare Neo4j Node, which has no `__typename` field at all.

This was a documented behaviour difference from `@neo4j/graphql-ogm` that consumers running Apollo Client / GraphQL pipelines hit immediately:

- Apollo's `InMemoryCache` keys entries by `__typename + id`. Without `__typename` it can't normalise.
- Discriminated-union pattern matching in TypeScript silently falls into the `default` branch.
- Test fixtures depending on `__typename === 'Book'` evaluate to `false`.

### Fix

Three call sites in `src/model.ts` now route through the default projection (which includes `__typename`) instead of bailing to a bare `RETURN n`:

- `defaultSelection()` (line 1728) — `__typename` is now the first scalar in the default selection list. `find()`, `findFirst()`, `findUnique()`, `findFirstOrThrow()`, `findUniqueOrThrow()`, `searchByVector()`, and `searchByPhrase()` all inherit this transitively via `resolveSelection()`.
- `applySelectionSetToMutation()` (line 1770) — when `selectionSet` is undefined (the no-explicit-selection path used by `create()` / `update()` / `delete()` / `setLabels()`), now compiles `defaultSelection()` instead of leaving the bare `RETURN n`.
- `applySelectionSetToUpsert()` (line 1888) — same fix for `upsert()`.

`SelectionCompiler` already understood `__typename` as a synthetic scalar field (line 164 of `selection.compiler.ts`) — for concrete types it emits the constant string (`__typename: 'Book'`), for unions/interfaces it emits a `head([__label IN labels(n) WHERE __label IN [...]])` expression. The fix is purely a default-selection change; no compiler logic changed.

### What this DOES NOT change

- **Explicit `select` / `selectionSet`** — callers who specify their own projection get exactly what they ask for. We do NOT silently inject `__typename` into a user-supplied selection. If you want it, ask for it explicitly: `select: { __typename: true, id: true }`.
- **InterfaceModel** — already emitted `__typename` via CASE-per-label (resolved from `labels(n)`). Unchanged.
- **Abstract relationship targets** — `Model.find({ select: { authors: { ... } } })` where `authors` points at a union/interface still auto-emits `__typename` in the nested projection, same as pre-1.8.4.
- **`@cypher` field** projections, `aggregate()`, `count()` — all unchanged.

### Behaviour change risks

Two edge cases for consumers to be aware of:

1. **Wire size** — every entity result now includes a `__typename` field. For a 50-row result this is ~50 × ~13 bytes (`__typename: 'Book'`) = ~650 extra bytes. Negligible for almost all callers.
2. **Schema-vs-store divergence** — pre-1.8.4 mutations without selection returned the raw Neo4j Node, including any properties stored on the node that are NOT in the GraphQL schema (e.g., legacy fields removed from the SDL but still present in the database). Post-1.8.4 the projection includes only schema-declared fields plus `__typename`. If your code relied on out-of-schema properties leaking through mutation responses, you must either (a) add them to the schema or (b) supply an explicit `selectionSet` that mentions them. Reads via `find()` already had this constraint pre-1.8.4 and behaved identically.

### Tests

- New file `tests/typename-auto-emit.spec.ts` — 11 regression tests covering `find()`, `findFirst()`, `findUnique()`, `create()`, `update()`, `upsert()`, explicit-select preservation, and unchanged InterfaceModel behaviour.
- One existing test in `tests/policy/model-mutation.spec.ts:305` was updated — it asserted "policy bypass means cypher must NOT contain `ownerId`" via a bare substring match. With the new projection emitting `.\`ownerId\``, the test now asserts the policy's WHERE-clause shape (`n.\`ownerId\` = $...`) is absent, which was the test's actual intent.
- Test count: **1370 → 1381** (+11). All pass.

### Compatibility

Public API surface unchanged. The Cypher emit changes for `find()`-family and mutation calls that did NOT pass an explicit `select` / `selectionSet`. Result shape gains a single `__typename` field; existing fields remain. This is the third backwards-compat fix in the v1.8.x series (after v1.8.1 connection-shape WHERE in nested disconnect/connect and v1.8.2 NLS permissive abstain default-deny).

---

## 1.8.3 (2026-05-06)

> **Bugfix.** `ogm.model('SomeInterface')` no longer silently returns an `InterfaceModel` — it now throws an `OGMError` immediately, naming the correct API. Pre-1.8.3 this returned an `InterfaceModel` cast to `any`, and the first mutation call (`.create()`, `.update()`, `.delete()`, `.upsert()`, `.setLabels()`) failed with `TypeError: this.create is not a function`.

### What was broken

```ts
const personModel = ogm.model<Person>('Person');  // 'Person' is an interface
//                                                    ↑ TypeScript: Model<Person>
//                                                       Runtime: InterfaceModel
personModel.create({...});  // 💥 TypeError: this.create is not a function
```

The TypeScript signature on `model<K>(name)` promises a `Model<T>` with full CRUD. Pre-1.8.3 the runtime cast an `InterfaceModel` to `any` and returned it whenever `name` matched an interface in the schema. Mutation methods on `InterfaceModel` don't exist (only read-only queries that span all implementing types), so the first mutation call crashed at the prototype level.

The crash pointed at the call site (`personModel.create(...)`) instead of the misnamed lookup (`ogm.model('Person')`). Tests asserted the buggy behaviour as a feature.

### What now happens

```ts
ogm.model('Person');
// OGMError: "Person" is an interface, not a node type. Use
// `ogm.interfaceModel('Person')` instead. model() returns Model<T>
// with full CRUD; interfaceModel() returns InterfaceModel<T> with
// read-only queries that span all implementing types.
```

The error fires at the lookup site, naming the mistake and the correct API.

### Migration

If you used the old fallthrough behaviour (which only "worked" for read-only operations), switch to `interfaceModel`:

```ts
// ❌ Pre-1.8.3 — type-lied, would crash on mutations
const personModel = ogm.model<Person>('Person').find({});

// ✅ Post-1.8.3 — explicit interface model, read-only by design
const personModel = ogm.interfaceModel<Person>('Person').find({});
```

Both `model('Person')` and `interfaceModel('Person')` worked pre-1.8.3 for reads; only `model('Person').create(...)` was the trap. The bugfix surfaces the trap without removing any working code path.

### Fixed

- `src/ogm.ts:381-440` — `model()` now throws when `name` matches an interface (instead of silently returning an `InterfaceModel`). The interface-cache cross-lookup at the top of `model()` was also removed; `interfaceModel()` owns its cache.

### Tests

- Updated `tests/ogm.spec.ts` — replaced 3 tests that documented the old fallthrough as a feature with 3 new tests that pin the new throw contract.
- Test count unchanged at **1370/1370**.

### Compatibility

Public API surface change. The TypeScript signature on `model()` was already a lie (returned `InterfaceModel` cast to `any`), so any caller actually using the returned object's mutation methods was already broken. The fix turns a confusing `TypeError: this.create is not a function` into a clear `OGMError` at the call site of `model()`.

`interfaceModel()` was always the correct entry point for read-only queries spanning all implementing types — that contract is unchanged.

### Rejected this cycle

Two performance candidates from the post-v1.8.0 audit were measured and rejected for failing the `<2% regression` gate of Tier 4 discipline:

- **Perf H1** — thread `paramsTarget` into `compilePolicyClause` (mirror of the v1.8.0 Fix C pattern). Showed +4% regression on nested AND/OR permissives across 2 runs. Snapshots: `bench/snapshots/rejected-H1-policy-paramsTarget.run{1,2}.json`.
- **Perf H3** — `key.indexOf('_') === -1` fast path for the OPERATOR_SUFFIXES table walk. Showed -6.5% on `simple equality` but +2.8% regression on `deep logical AND/OR/NOT` across 4 runs. Snapshots: `bench/snapshots/rejected-H3-suffix-fastpath-run{1-4}.json`.

The v1.8.0 audit's predicted gain of -8.7% on H1 was based on assuming the AND/OR/NOT recursion did NOT thread `paramsTarget` — but Fix C v1.8.0 already had. The marginal saving from threading the outer policy entry was inside noise. We keep the discipline.

---

## 1.8.2 (2026-05-06) — 🚨 SECURITY ADVISORY

> **CRITICAL — Permissive policies that ALL abstain at runtime now correctly DENY instead of silently allowing the entire result set. Upgrade immediately if you use Node-Level Security (NLS) Permissive policies with conditional `when()` callbacks or any `cypher.fragment` that may return an empty string.**

### Affected versions

`1.7.0` through `1.8.1` (all NLS-enabled releases prior to 1.8.2).

### Severity

**CRITICAL** — silently inverts the deny default. Surfaced by an internal post-v1.8.0 security audit.

### Impact

When EVERY registered Permissive policy on a node abstained at runtime, the WHERE compiler emitted `WHERE true` and returned the **full table** to the caller. The pre-compile guard (`Model.assertNotDeniedAtCompile`) inspected `permissives.length`, not runtime contributions, so the bypass survived TS checks, code review, and the v1.7.0 NLS audit. The audit metadata also reported the request as policy-enforced.

### Reproducer

Three documented patterns triggered the bypass. The most natural — a conditional grant that abstains when ctx is missing the relevant field:

```ts
ogm.policies.register('Document', {
  permissive: [{
    operations: ['read'],
    when: (ctx: { tenantId?: string }) =>
      ctx.tenantId ? { tenantId: ctx.tenantId } : null, // ❌ abstain
  }],
});

// Caller without tenantId in ctx (anonymous, misconfigured middleware, etc):
await ogm.withContext({}).model('Document').find({});
//   Pre-1.8.2: MATCH (n:Document) WHERE true RETURN n  → DUMP ALL TENANTS
//   Post-1.8.2: MATCH (n:Document) WHERE false RETURN n → []
```

The other two patterns: `when: () => undefined`, and `cypher.fragment: () => ''` (the empty-fragment path is type-clean — `string` includes `''` — so it required no TS bypass).

### Root cause

`src/compilers/where.compiler.ts:353-360` emitted `permClause = 'true'` whenever `permFrags.length === 0`, on the assumption that an empty `permFrags` meant "every permissive returned an empty partial, which is match-anything." That conflated TWO distinct runtime states:

1. `when()` returns `{}` (empty partial) — line 257-259 explicitly pushes `'true'` into `permFrags`. **Length is 1, not 0.** This is the documented "I want allow-all" escape hatch.
2. `when()` returns `null`/`undefined` OR `cypher.fragment` returns `''` — the contribution is silently dropped. `permFrags` stays empty.

The audit identified the conflation. Permissives are an ALLOW-LIST: if no rule grants access, access is DENIED. Empty `permFrags` is now `'false'`, not `'true'`.

### Fix

`src/compilers/where.compiler.ts:353-380` — single-line change with a long comment block:

```diff
   const permClause =
     permFrags.length === 0
-      ? 'true'   // pre-1.8.2: silently invert deny default
+      ? 'false'  // permissives are an allow-list; no rule fired = DENY
       : permFrags.length === 1
         ? permFrags[0]
         : `(${permFrags.join(' OR ')})`;
```

The `permissives.length === 0` branch (line 346-350 — no permissives registered AT ALL) was already correct (`return 'false'`). This patch fixes the case where permissives WERE registered but all abstained.

### Migration path

If you genuinely need "this policy grants access to every row," use **explicit allow-all** by returning an empty partial:

```ts
// ❌ Pre-1.8.2 worked accidentally — abstain leaked to allow-all
when: (ctx) => ctx.userId ? { ownerId: ctx.userId } : null

// ✅ Explicit grant — return empty partial (match-anything)
when: (ctx) => ctx.userId ? { ownerId: ctx.userId } : ({} as never)

// ✅ Better — separate permissives, each with its own scope
permissive: [
  { operations: ['read'], when: (ctx) => ({ ownerId: ctx.userId }) },
  { operations: ['read'], appliesWhen: (ctx) => ctx.role === 'admin', when: () => ({}) },
]
```

### What this DOES NOT change

- **No-policy queries** (typeName has zero registered policies) — byte-identical Cypher emit. The `permissives.length === 0` branch in `compilePolicyClause` is unchanged.
- **Successful permissive grants** — when at least one permissive returns a non-empty partial OR a non-empty `cypher.fragment`, behaviour is identical.
- **Restrictive policies** — same code, same behaviour. (The audit identified a related MEDIUM finding on write-restrictive null-as-allow which is queued for a follow-up release; the patch here only addresses the CRITICAL permissive path.)
- **Empty-partial allow-all escape hatch** — `when: () => ({})` still pushes `'true'` and emits `WHERE true`. The migration path leaves this preserved.

### Tests

Added `tests/policy/permissive-abstain-default-deny.spec.ts` with 8 regression tests covering:

- Single permissive `when()` returns `null` / `undefined` / via `cypher.fragment: () => ''`
- Multiple permissives all abstaining
- Mixed: one permissive grants, others abstain (the granting one wins as before)
- Empty partial `when: () => ({})` still emits `WHERE true` (migration path)
- Conditional `when()` with both grant and abstain branches
- Abstaining permissive + restrictive — the absence of a granting permissive denies even if the restrictive returns `{}`

Test count: **1362 → 1370** (+8). All 1370 pass.

### Other findings from the same audit (NOT in this patch)

The post-v1.8.0 security audit also surfaced:

- **HIGH** — write-restrictive `when()` returning `null` treated as allow (write-side, separate code path)
- **MEDIUM** — shallow `Object.freeze` on ctx (defense-in-depth)
- **LOW** — `assertSafeKey` not called from mutation compiler (consistency gap)

These are queued for v1.9.0 — none have an exploit path comparable to the CRITICAL fixed here.

### Acknowledgement

Discovered by an internal multi-agent code audit run on the v1.8.0 release. Reported, scoped, fixed, tested, and shipped within hours of the audit completing.

---

## 1.8.1 (2026-05-06)

> **Critical backwards-compatibility fix.** Nested `update.<rel>.disconnect[].where` and `update.<rel>.connect[].where` with connection-shape inputs (`{ NOT: { node: {...} } }`, `{ AND: [...] }`, `{ OR: [...] }`) compiled to broken Cypher. Anyone migrating from `@neo4j/graphql-ogm` using these wrapper shapes inside nested update operations was hit silently — `relationshipsDeleted: 0` with no error. **Upgrade immediately if you use nested `update.<rel>.disconnect` or `update.<rel>.connect` with `NOT` / `AND` / `OR` wrappers.**

### What was broken

For input like:

```ts
ogm.model('Edition').update({
  where: { id: 'conc1' },
  update: {
    tiers: [
      {
        disconnect: [
          { where: { NOT: { node: { id_IN: ['tier1', 'tier2'] } } } },
        ],
      },
    ],
  },
});
```

Pre-1.8.1 emitted:

```cypher
OPTIONAL MATCH (n)<-[r:GRANTS_ACCESS_TO_CONCENTRATION]-(target:Tier)
WHERE target.`node` <> $param   -- ❌ "node" treated as property name
DELETE r                         -- ❌ never matches → no-op
```

`target.node` is a non-existent property; the `<>` comparison against a Map literal never matches; the `DELETE` is a no-op. Symptom: `relationshipsDeleted: 0` with no warning.

1.8.1 emits the correct Cypher:

```cypher
OPTIONAL MATCH (n)<-[r_disc_tiers_0_0:`GRANTS_ACCESS_TO_CONCENTRATION`]-(n_disc0:`Tier`)
WHERE NOT (n_disc0.`id` IN $update_tiers_0_disc_0_NOT_id_IN)
DELETE r_disc_tiers_0_0
```

### Root cause

Tier 1 (1.7.2) introduced `buildConnectionWhereConditions` to handle the connection-shape inputs (`node`, `NOT`, `AND`, `OR`, fallback to bare node fields) for top-level `disconnect`/`connect` and selection-set connection filters. The **nested** update path (`buildUpdateRelationships`, `mutation.compiler.ts:1331+`) was not migrated and still routed through `buildNodeWhereConditions(whereSpec.node ?? whereSpec, ...)` directly — which treats `NOT`/`AND`/`OR` as scalar property names with operator suffixes, producing the broken emit above.

The same bug existed symmetrically on the nested `connect` path.

### Fixed

- `src/compilers/mutation.compiler.ts:1357-1379` — nested disconnect now routes through `buildConnectionWhereConditions`, identical to the top-level `buildDisconnects` path.
- `src/compilers/mutation.compiler.ts:1400-1426` — nested connect routes through the same compiler. Mirror of the disconnect fix.

### Tests

Added 4 regression tests in `tests/mutation.compiler.spec.ts`:
- Nested `disconnect.where: { NOT: { node: { id_IN } } }` (the user-reported case)
- Nested `disconnect.where: { AND: [...] }`
- Nested `disconnect.where: { OR: [...] }`
- Nested `connect.where: { NOT: { node: {...} } }` (mirror)

Test count: **1358 → 1362** (+4). All 1362 pass. No semantics change for callers using only `where: { node: {...} }` or bare node-field shapes.

### Compatibility

Purely additive fix. No public API change. No emitted-Cypher change for any input that was working in 1.8.0.

---

## 1.8.0 (2026-05-05)

> Performance release. Three Tier 4 hot-path fixes from the audit landed
> after measurement against a new dev-only `mitata` benchmark harness.
> Two candidate fixes (cache dedup, mutation params spread) didn't clear
> the 5% acceptance threshold and were reverted. **No behaviour changes
> — semantics are identical to 1.7.5.** Stored-property queries, NLS
> policy enforcement, code-generation output, and emitted Cypher are
> all byte-for-byte equivalent to 1.7.5 for the same inputs.

### Headline gains

The biggest absolute time savings per call (`avg`, mitata, single host):

| Hot path | 1.7.5 | 1.8.0 | Saved | Δ |
|---|---|---|---|---|
| Result mapping — 10 nested reviews + 5 tags row | **7.56 µs** | **6.42 µs** | 1.14 µs | **−15%** |
| Result mapping — mixed types + nested object | 894 ns | **735 ns** | 159 ns | **−18%** |
| Result mapping — pure scalar map | 185 ns | **119 ns** | 66 ns | **−36%** |
| WHERE compile — deep AND/OR/NOT nesting | **3.66 µs** | **3.11 µs** | 550 ns | **−15%** |
| Selection compile — deep (multi-rel + connection) | **2.69 µs** | **2.26 µs** | 428 ns | **−16%** |
| Selection compile — nested (1 level rels) | 1.11 µs | **940 ns** | 172 ns | **−16%** |
| Selection compile — simple `{ id title }` | 151 ns | **120 ns** | 32 ns | **−21%** |
| WHERE compile — connection (node + edge) | 1.30 µs | **1.21 µs** | 99 ns | **−8%** |
| `escapeIdentifier` (no-backticks fast path) | 19 ns | **1.1 ns** | 18 ns | **−94%** |

### What got faster — and why

#### 1. `ResultMapper.convertNeo4jTypes` — `Object.entries` → `for...in` (fix E)

Pre-1.8.0 the plain-object branch allocated a fresh `[key, value][]` pair array per nested object visit (via `Object.entries`). For a realistic 10-row relationship result with nested children, that's 32 allocations per Cypher row — multiplied by every row in every result. Switched to `for...in` + `Object.prototype.hasOwnProperty.call`. The `Object.create(null)` defensive guard against prototype pollution is preserved.

```
                                    1.7.5      1.8.0      Saved      Δ
pure scalar map                    184.5 ns   118.5 ns    66.0 ns   −36%
single Neo4j Integer (safe)        145.4 ns   134.4 ns    11.0 ns    −8%
mixed types + nested object        894.0 ns   735.0 ns   159.0 ns   −18%
nested rel array (10 + 5 children)   7.56 µs    6.42 µs    1.14 µs   −15%
```

#### 2. `escapeIdentifier` fast path (fix F)

`escapeIdentifier` is called dozens of times per Cypher emit (every relationship type, every label, every property name). Pre-1.8.0 it unconditionally ran a regex-replace + intermediate string allocation, even though identifiers in well-formed schemas effectively never contain backticks. Added a single `indexOf('` ` `')` check before the regex; the >99.99% case now returns the wrapped string directly.

The direct microbenchmark went from 19 ns to 1.1 ns (−94%) — V8 effectively inlines the fast path to no-op cost. The real win is the cascade through every code path that calls `escapeIdentifier` transitively:

```
                                    1.7.5      1.8.0      Saved      Δ
compile simple { id title }        151.2 ns   119.7 ns    31.6 ns   −21%
compile nested (1 level rels)        1.11 µs    940 ns   172.3 ns   −16%
compile deep (multi-rel + conn)     2.69 µs    2.26 µs   428.4 ns   −16%
deep logical AND/OR/NOT             3.66 µs    3.11 µs   549.8 ns   −15%
relationship _SOME inner where     735.5 ns   698.1 ns    37.3 ns    −5%
connection where (node + edge)      1.30 µs    1.21 µs    99.0 ns    −8%
```

The slow path (identifier WITH backticks) is unchanged — still routes through the original regex.

#### 3. `WhereCompiler.compileConditions` shared params accumulator (fix C)

`compileConditions` is recursive — `AND` / `OR` / `NOT` branches recurse into themselves with smaller sub-objects. Pre-1.8.0 every recursion frame allocated a fresh `{}` Map and merged via `Object.assign` on the way back up. For a 5-level deep `AND`/`OR`/`NOT` predicate that's 5 fresh objects + 5 merge walks per compile. The recursive paths now thread the parent's params Map as a shared accumulator; leaf scalar conditions write directly into the owner.

```
                                    1.7.5      1.8.0      Saved      Δ
deep logical AND/OR/NOT             3.66 µs    3.11 µs   549.8 ns   −15%
```

The public WhereCompiler API surface is unchanged — `paramsTarget` is an optional internal parameter; external callers keep the old contract.

### Real-world impact

For a typical paginated query (`Book.find({ where, select: { id, title, hasReviews { ... } } })` returning 50 rows):

| Stage | 1.7.5 | 1.8.0 | Saved per request |
|---|---|---|---|
| WHERE compile (mixed operators) | 1.96 µs | 1.86 µs | 100 ns |
| Selection compile (cache hit) | 28 ns | 28 ns | — |
| Result mapping (50 × mixed-types row) | 44.7 µs | 36.8 µs | 7.9 µs |
| **Total per request** | **≈46.7 µs** | **≈38.7 µs** | **≈8 µs** |

Multiplied by sustained load:

| QPS | Saved per second | CPU core equivalent |
|---|---|---|
| 1,000 | 8 ms | 0.8% of one core |
| 10,000 | 80 ms | **8% of one core** |
| 50,000 | 400 ms | **40% of one core liberated** |

For result-heavy workloads (1000 rows × nested relationship array): **~1.14 ms saved per query** at the OGM layer alone.

### Node-Level Security (NLS) policy hot path

Policy-enabled queries got modest gains. Simple policies are dominated by the inherent allocation cost of `when(ctx)` invocation + partial allocation + AND-stitch — none of the Tier 4 fixes target those. Nested-`when` policies see the recursion benefit from fix C.

| Policy shape | 1.7.5 | 1.8.0 | Saved | Δ |
|---|---|---|---|---|
| User where, no policy (baseline) | 1.96 µs | 1.89 µs | 71 ns | −3.6% |
| + single permissive (flat `when`) | 2.28 µs | 2.25 µs | 28 ns | −1.2% 🟡 |
| + two permissives (OR-grant) | 3.00 µs | 2.95 µs | 54 ns | −1.8% 🟡 |
| + permissive AND restrictive | 2.93 µs | 2.88 µs | 46 ns | −1.6% 🟡 |
| + nested AND/OR permissive (deep `when`) | **5.09 µs** | **4.65 µs** | 442 ns | **−8.7%** 🟢 |
| + cypher escape hatch fragment | 2.31 µs | 2.28 µs | 35 ns | −1.5% 🟡 |

**TL;DR for NLS users**: if your policies are simple (`when: ctx => ({ ownerId: ctx.userId })`) the gain is ≈30–50 ns per query — imperceptible. If your `when` returns nested `AND`/`OR` partials, expect ~440 ns per query saved. NLS-side optimization (caching `when()` results, plumbing the shared accumulator into `compilePolicyClause`) is tracked as Tier 4.5 follow-up work.

### Rejected fixes (measured, didn't clear threshold)

Two Tier 4 candidates were applied, measured, and reverted because they didn't clear the 5% acceptance bar with no >2% regression elsewhere. Snapshots preserved under `bench/snapshots/fix-B.run*.json` and `fix-D.run*.json` for future reference:

- **B — Dedup `Model._selectionCache` and `SelectionCompiler.parseCache`.** Code-wise correct (one fewer Map.get per query), but the bench can't measure the affected path without a Model.find end-to-end benchmark with mock executor. Visible variance was JIT-level noise from the Model class shape shift, not a real regression. May be revisited if a Model.find end-to-end benchmark is added.
- **D — Mutate `whereResult.params` in place** in mutation compiler (3 sites). Showed unstable variance: `compileUpdate — simple SET` ranged from +2% to +25% across runs. The spread is one allocation per mutation (~50 ns range), and per-mutation cost is dominated by other work (label cache lookup, string concat) — savings too small to surface above noise.

### Dev-only: `mitata` benchmark harness

A new `bench/` directory was added with the `mitata` benchmark library as a `devDependency`. **It is not shipped to npm consumers** — `bench/` is excluded from the package files manifest, the `dist/` build configs only include `src/`, and `mitata` is never imported by runtime code. End users see zero impact: identical `node_modules/grafeo-ogm` contents, identical bundle size.

The harness covers WhereCompiler, SelectionCompiler, ResultMapper, MutationCompiler, escapeIdentifier, and NLS policy paths. Snapshots in `bench/snapshots/` document the pre/post numbers behind every claim above. Run with `pnpm run bench` (rich text output) or `pnpm run bench -- --json` (machine-readable; strips per-iteration samples).

### What's NOT in this release

The audit also flagged these — held back because they need more design:

- **NLS policy optimisations** (Tier 4.5): caching `when()` results by `ctxFingerprint`, threading the shared params accumulator through `compilePolicyClause`. Would close the 1–2% simple-policy gap.
- **Selection-cache dedup** (deferred fix B): re-evaluate after a Model.find end-to-end benchmark is added.
- **Bundle-size reduction** by separating the codegen entry point. Breaking change — needs a major version.

### Test coverage

No semantic tests changed in this release — only perf code paths touched. 1358/1358 tests still pass. Lint clean, format clean, build clean.

## 1.7.5 (2026-05-05)

> Tier 5 cleanups from the audit. Four small but useful fixes: a counter
> bug in `_SINGLE`, a DoS-guard cap on `AND` / `OR` array length, a real
> LRU eviction policy on the selection-set parse cache, and an opt-in
> strict mode that surfaces typo'd `where` field names. None of these
> change behaviour for code that wasn't reaching the broken paths;
> `strictWhere` is opt-in.

### Fixed

- **`_SINGLE` quantifier no longer skips a parameter slot.** Pre-1.7.5 the `_SINGLE` case did `counter.count++` AFTER the inner compilation completed, leaving an unused index in the param namespace. With one inner condition (`$param1`), the next outer scalar landed on `$param3` instead of `$param2` — invisible to most queries but masking real collisions whenever a future compiler shared this counter. The extra increment is gone.
- **`AND` / `OR` arrays capped at 256 entries.** Each entry costs a recursion frame, a parameter slot, and a Cypher AST node, so a 100k-entry array compiles to a 100k-clause `WHERE` body — a practical DoS vector if user input ever flows into a logical array. Throws `OGMError` on overrun. The cap also applies inside connection-where logical operators.
- **`SelectionCompiler.parseCache` is now a real LRU.** Pre-1.7.5 the implementation was `if (size < 200) set(...)` — once saturated, every subsequent miss had to re-parse via `graphql.parse()` because nothing was ever inserted (and nothing was ever evicted to make room). Apps with high selection-set cardinality silently paid full parse cost on every request post-saturation. The new policy: on hit, `delete + set` (move to MRU); on full insert, evict the oldest entry (`Map.keys().next().value` — Maps preserve insertion order). Dedup with `Model._selectionCache` is deferred to Tier 4 / a future release.

### Added

- **Opt-in `strictWhere` mode.** `OGMConfig.features.strictWhere = true` makes the where compiler throw `OGMError` when a `where` clause references a field name not declared on the target type — surfacing typos at the call site instead of silently returning empty results. Default is `false` to preserve existing behaviour. Recommended for new codebases:
  ```ts
  new OGM({
    typeDefs,
    driver,
    features: { strictWhere: true },
  });
  ```
  With strict mode off (the default), `where: { naem: 'Alice' }` continues to compile to `n.\`naem\` = $param0` — safe (escaped via `assertSafeIdentifier`) but silent. With strict mode on, the same call throws `OGMError: Unknown field "naem" in where clause.`

### Test coverage

- `tests/where.compiler.spec.ts` — regressions for `_SINGLE` counter, `AND`/`OR` cap (above + at boundary), `strictWhere` on/off behaviour.
- `tests/selection.compiler.spec.ts` — regressions for real LRU eviction, including the "touched entry survives" property.
- 1350 → 1358 tests, all passing.

### Out of scope (still deferred)

- `Model._selectionCache` and `SelectionCompiler.parseCache` deduplication — Tier 4 work, needs the perf benchmark harness.
- `generateTypes` emitter parallelisation — Tier 4, marginal win on schemas under 200 types.
- Bundle-size reduction by moving the generator to a separate entry point — breaking change, separate discussion.
- `escapeIdentifier` regex micro-optimisation — Tier 4 micro-opt territory.

## 1.7.4 (2026-05-05)

> Tier 3 contract violations from the audit. Six fixes across mutations,
> aggregates, fulltext, and the InterfaceModel. Three are behaviour-
> changing where the previous behaviour was silently wrong; the others
> tighten validation that should have been there from the start.

### Fixed

- **`setLabels` rejects overlap between `addLabels` and `removeLabels`.** Pre-1.7.4 the same label appearing in both arrays produced `SET n:Foo REMOVE n:Foo`, which Cypher executes left-to-right so the final state is REMOVED — almost certainly never the developer's intent. Now throws `OGMError` with the conflicting labels listed.
- **`upsert` requires at least one `@unique` or `@id` key in the `where` clause.** Pre-1.7.4 `compileMerge` accepted any scalar key, so a typo (`usernme: 'a'`) became a phantom MERGE property — Neo4j happily created a node carrying that misspelt attribute. Worse, a non-unique `where: { country: 'AR' }` would MERGE-fan-out across every existing matching node, applying `ON MATCH SET` to all of them. The new guard requires the MERGE pattern to target at most one row.
- **`update.<rel>.connect: [...]` rejects heterogeneous array shapes.** The UNWIND fast path used `firstItem`'s key set to build the `WHERE` clause for ALL items — if `spec[1]` had additional filter keys, those keys were silently dropped. Now compares signature (`node:[a,b]|edge:[c]`) per item and throws on divergence with a clear message.
- **`InterfaceModel.find` validates `limit` and `offset` like `Model`.** Pre-1.7.4 raw values were forwarded to the driver — negative `limit` either errored at the driver layer or triggered an unbounded scan (driver-version-dependent). Now mirrors `Model.compileOptions`: rejects non-finite or negative values; caps `limit` at 10,000.
- **Relationship fulltext uses `endNode(rel)` for IN-direction relationships.** Pre-1.7.4 the compiler hardcoded `startNode(rel)`, binding the wrong endpoint to `nodeVar` for `(parent)<-[rel]-(target)` definitions. Result: empty / wrong rows for IN-direction relationship fulltext queries. Now branches on `relDef.direction`.
- **Aggregate runtime emits type-aware Cypher.** Pre-1.7.4 the runtime called `min` / `max` / `avg` for every requested field regardless of property type, so `aggregate({ name: true })` on a `String` field came back with `average: null` (Neo4j returns null for non-numeric `avg`). Now resolves the property type from the schema and emits only operations that apply: numeric (`Int` / `Float`) gets `min` / `max` / `avg` / `sum` (the `sum` aggregation is new — pre-1.7.4 the codegen claimed it existed but the runtime never emitted it); temporal (`DateTime` / `Date` / `Time` / `LocalDateTime` / `LocalTime`) gets `min` / `max`; everything else gets `min` / `max` only. Same fix in `InterfaceModel.aggregate`.

### Test coverage

- `tests/mutation.compiler.spec.ts` — regressions for setLabels overlap, heterogeneous connect array.
- `tests/model.spec.ts` — regression for type-aware aggregate (numeric Int field gets `sum` + `average`).
- `tests/interface-model.spec.ts` — regressions for limit/offset validation (negative reject, 10k cap) and aggregate type-aware emission for non-numeric fields.
- `tests/fulltext-advanced.spec.ts` — regression for IN-direction relationship fulltext using `endNode(rel)`.
- 1343 → 1350 tests, all passing.

### Behaviour changes

- `aggregate({ stringField: true })` no longer returns an `average: null` key. The result entry is `{ min, max }` only — code reading `result.stringField.average` will see `undefined` instead of `null`. Both indicate "this aggregation doesn't apply", but `undefined` is the correct signal.
- `aggregate({ intField: true })` now returns `{ min, max, average, sum }` — `sum` is new. Existing code that did not access `.sum` is unaffected.
- `upsert({ where: { nonUniqueField: ... }, ... })` now throws. Code that relied on non-unique upsert as a "create + bulk-update" was silently buggy and must split into separate `create` + `update` calls.
- `update({ ..., rel: { connect: [{ where: shape1 }, { where: shape2 }] } })` with divergent shapes now throws. Pre-1.7.4 it silently dropped the divergent keys. Caller must normalise shapes or split into separate `update` calls.

### Out of scope (deferred)

- `shortest` / `longest` aggregate operations (codegen claims they exist on `String` / `ID`). Implementing them requires a `reduce` over `collect()` which breaks the simple RETURN-aggregation pattern. Tracked for a future release; the codegen-emitted keys remain `undefined` at runtime until then.
- Tier 4 hot-path performance work (selection-cache dedup, where-frame allocation, result-mapper allocation). Needs a benchmark harness before changes are accepted.

## 1.7.3 (2026-05-05)

> Security hardening release. Four defensive fixes surfaced by the same
> internal audit that produced 1.7.2. No behaviour change for callers
> that weren't reaching the hardened paths — Cypher emit is byte-
> identical for stored-property filters, vectors, and result mappings
> below the new boundaries.

### Fixed

- **Lucene bareword booleans neutralised.** `sanitizeLuceneQuery` already escaped symbol-form operators (`+`, `-`, `&&`, `||`, `^`, `~`, `:`, etc.) but let bareword `AND` / `OR` / `NOT` / `TO` survive — so an attacker could still inject a boolean query (e.g. `foo AND _exists_:adminFlag`) even when the developer routed input through the sanitizer. The function now lowercases standalone uppercase booleans BEFORE the placeholder dance, turning them into literal-word matches under Lucene's standard analyser. Word boundaries (`\b`) keep middle-of-word matches like `BAND` / `STOP` / `PORTO` untouched.
- **Vector + fulltext phrase length capped at 8 KB.** `searchByPhrase` forwards the input directly to the configured embedding provider (OpenAI / Vertex AI / etc., usually billable per token); fulltext forwards directly to the database parser. Pre-1.7.3 there was no cap — an attacker could send a multi-megabyte phrase to drive runaway billing or exhaust driver memory. New behaviour: throws `OGMError` with a clear message before any external call. 8 KB is well above any legitimate search query.
- **Neo4j Integer overflow no longer truncates silently.** `ResultMapper.convertNeo4jTypes` previously called `value.toNumber()` unconditionally — values above `Number.MAX_SAFE_INTEGER` (2⁵³) returned a wrong-but-plausible Number (e.g. `9007199254740993n` came back as `9007199254740992`). The mapper now gates on `value.inSafeRange()` and returns a `BigInt` for out-of-range integers. Values within the safe range still return as `Number`, so ordinary IDs / counters keep their existing type — only the overflow path changes.

### Documented

- **`@cypher` SDL trust boundary made explicit.** The `statement` argument is interpolated verbatim into Cypher with no parameterisation. README now flags this as a development-time-only trust requirement: if `typeDefs` are ever assembled from runtime input (env vars, database records, remote config, user input), the application has a Cypher-injection vector equivalent to RCE on the database. The runtime cannot distinguish developer-authored from user-derived SDL — that boundary is the application's responsibility.

### Test coverage

- `tests/lucene.spec.ts` — 6 new tests covering bareword lowercase, word-boundary safety, the documented attack vector, and `&&` / `AND` interleaving.
- `tests/fulltext.compiler.spec.ts` + `tests/vector.compiler.spec.ts` — 3 new tests covering the 8 KB boundary (throw above, accept at).
- `tests/result-mapper.spec.ts` — 2 new tests covering the `inSafeRange` boundary (Number for safe, BigInt for overflow).
- 1332 → 1343 tests, all passing.

### Out of scope (deferred)

- Tier 3 contract violations (aggregate codegen mismatch, `setLabels` overlap, `upsert` MERGE-key validation, `extractConnectWhereConditions` array divergence, `InterfaceModel.find` limit/offset) — each needs a public-API decision before fixing.
- Tier 4 hot-path performance (double selection cache, `params:{}` allocation per where frame, `Object.entries` + `Object.create(null)` per result-mapper visit) — needs a benchmark harness before changes are accepted.

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
