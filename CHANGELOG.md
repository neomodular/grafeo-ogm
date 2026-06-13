# Changelog

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
