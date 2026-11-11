# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

grafeo-ogm is a type-safe Object-Graph Mapper for Neo4j that uses GraphQL SDL as the schema definition language. It compiles high-level CRUD operations into parameterized Cypher queries with full TypeScript type safety via code generation. It continues `@neo4j/graphql-ogm`, which was removed from `@neo4j/graphql` 6.0.0 (its 5.x LTS line still ships, tied to `neo4j-driver` 5). It keeps the same `OGM` / `Model` API, with deliberate differences listed in the README Migration section, and adds Prisma-inspired query methods, runtime multi-label support and `neo4j-driver` 6 support. When describing upstream, say "removed from v6" or "discontinued after v5", not "deprecated" or "abandoned".

## Commands

```bash
pnpm run build          # TypeScript → dist/ (ES2020, CommonJS)
pnpm run test           # Run all tests (Jest, ts-jest)
pnpm run lint           # ESLint (src/ only)
pnpm run lint:fix       # ESLint auto-fix
pnpm run format         # Prettier format
pnpm run format:check   # Prettier check
```

Run a single test file:
```bash
npx jest tests/where.compiler.spec.ts
```

Run a specific test by name:
```bash
npx jest -t "compiles _CONTAINS operator"
```

Run the opt-in **live suites** (`tests/integration/`, skipped unless the env var is set) against a disposable Neo4j 5.26:
```bash
docker run -d --name grafeo-live-526 -p 17687:7687 -e NEO4J_AUTH=neo4j/livetest-pw-526 neo4j:5.26
NEO4J_URI=bolt://localhost:17687 NEO4J_USER=neo4j NEO4J_PASSWORD=livetest-pw-526 \
  npx jest tests/integration --runInBand
```
- `tests/integration/subgraph-apoc.spec.ts` needs an APOC server: `NEO4J_APOC_URI` + `NEO4J_APOC_PASSWORD` (`-e 'NEO4J_PLUGINS=["apoc"]'`).
- `tests/integration/vector-phrase.spec.ts` needs the GenAI plugin: `NEO4J_GENAI_URI` (`-e 'NEO4J_PLUGINS=["genai"]'`). It never contacts a provider.
- Use a throwaway container on a non-default port. **Never point the live suites at a database you care about** — every suite tags its data with a `runId` and deletes it, but `db push` tests manage constraints and indexes.
- CI runs all live suites in the `live (Neo4j 5.26)` job (reusable `.github/workflows/live.yml`, one `neo4j:5.26` service with APOC + GenAI), on every push/PR and before every npm publish (`release.yml` `publish` needs it). `scripts/ci/assert-live-suites-ran.cjs` fails the job if any live test skipped, so a new suite must be reachable from the env vars set there.

## Architecture

### Core Pipeline

```
GraphQL SDL → parseSchema() → SchemaMetadata → Compilers → Cypher + Params → Executor → Neo4j → ResultMapper → JS objects
```

**OGM** (`src/ogm.ts`) is the central hub. It parses the schema once in the constructor, creates shared compiler instances, and vends cached `Model` / `InterfaceModel` instances via `ogm.model(name)`.

**Model** (`src/model.ts`) implements all CRUD operations by delegating to the compiler pipeline and executor. Includes Prisma-like methods: `find`, `findFirst`, `findUnique`, `findFirstOrThrow`, `findUniqueOrThrow`, `create`, `createMany`, `update`, `updateMany`, `delete`, `deleteMany`, `upsert`, `count`, `aggregate`, `setLabels`. Supports both string `selectionSet` and typed `select: {}` API (mutually exclusive). All query/mutation methods accept a `labels` parameter for runtime multi-label filtering.

**InterfaceModel** (`src/interface-model.ts`) provides read-only queries (`find`, `findFirst`, `findUnique`, `findFirstOrThrow`, `findUniqueOrThrow`, `count`, `aggregate`) across all types implementing a shared GraphQL interface. Mutations throw — use the concrete model instead. Always returns `__typename` in results.

### Schema Layer (`src/schema/`)

- `parser.ts` — Parses GraphQL SDL into `SchemaMetadata` using `graphql-js`. Handles `@node`, `@relationship` (direction must be exactly `IN`/`OUT`), `@relationshipProperties`, `@declareRelationship` (resolved from implementors), `@id` (generates a UUID; does **not** imply a constraint), `@unique`, `@default` (scalars and lists), `@cypher`, `@fulltext`, `@vector` directives.
- `types.ts` — Core types: `SchemaMetadata`, `NodeDefinition`, `PropertyDefinition`, `RelationshipDefinition`. All collections use `Map` for O(1) lookups.

### Compiler Layer (`src/compilers/`)

Each compiler is stateless and produces `{ cypher, params }` output:

- **WhereCompiler** — Filter objects → `WHERE` clauses. Supports scalar operators (`_CONTAINS`, `_GT`, `_IN`, etc.), logical (`AND`/`OR`/`NOT`), relationship quantifiers (`_SOME`/`_NONE`/`_ALL`/`_SINGLE`), and connection filters. Where values are coerced to the stored representation (`coerceWhereValue` / `wrapWhereParam` in `src/utils/write-coercion.ts`). Max recursion depth: 10.
- **SelectionCompiler** — GraphQL selection sets → Cypher map projections (`RETURN n { .id, .name }`). Handles relationships via pattern comprehensions, unions/interfaces via `CASE WHEN`, connections via edge patterns (+ `totalCount`), `selectionSet` field arguments and aliases. 200-entry LRU parse cache. Max depth: 5.
- **MutationCompiler** — Generates `CREATE`, `SET`, `DELETE`, `MERGE` Cypher with nested relationship operations (create/connect/disconnect/update/delete at any depth, including interface/union targets). Nested op order within an update item: delete, disconnect, connect, create, update — this differs from `@neo4j/graphql` 5.x (delete, disconnect, update, connect, create), which `strict: true` uses (v2.9.0). Root `update()` order: `update` body (SET + nested ops), root disconnect, root connect; under `strict: true` the root disconnect runs first, as upstream. Handles multi-label nodes and cascade deletes.
- **FulltextCompiler** — Builds `CALL db.index.fulltext.queryNodes()` / `queryRelationships()` clauses, with `AND`/`OR`/`NOT` (later `AND` branches and `NOT` run in uncorrelated inner CALLs via `joinBranchOn`). Validates index names against schema.
- **VectorCompiler** — `searchByVector` / `searchByPhrase` (`genai.vector.encode` is a *function*, evaluated in a `WITH`).
- **SelectNormalizer** — Converts typed `select` API objects into `SelectionNode[]` trees for SelectionCompiler. Handles `field: true` (scalar or all-scalars for relationships), `field: { select: {}, where?: {} }` (nested selection with optional filtering), and connection fields (`*Connection` suffix with `edges.node`/`edges.properties`).

### Execution Layer (`src/execution/`)

- **Executor** — Runs Cypher via neo4j-driver. Supports explicit transactions, managed transactions, auto-commit sessions. Static `debug` flag for query logging.
- **ResultMapper** — Converts Neo4j types (Integer, DateTime, Point, Node, Relationship) to plain JS objects. Depth guard at 50. Uses `Object.create(null)` to prevent prototype pollution.

### Type Generator (`src/generator/`)

`generateTypes()` orchestrates sequential type emitters to produce a complete TypeScript file from schema. Emitters in `type-emitters/` each handle one concern (node types, where inputs, mutation inputs, connections, aggregations, etc.). Output is optionally formatted with Prettier.

### Node-Level Security (`src/policy/`)

`policies` (permissive / restrictive, per operation) are compiled into the Cypher of every read and write. A type's policy applies wherever that type is reached — root, nested selection, relationship filters, connect/disconnect (`read`), nested create (`create` + `WITH CHECK`), nested update (`update`), cascade delete (`delete`). In `mutation.compiler.ts` this is `buildTargetPolicyPredicate`; abstract (interface/union) targets get a per-member `CASE`. `src/policy/nested-writes.ts` checks nested write input before compile. OGMs without `policies` must emit **byte-identical** Cypher (`tests/policy/byte-identical.spec.ts`).

### CLI, subgraph and testing helpers

- `src/cli/` — `grafeo init`, `generate`, `db push` (constraint/index sync; orphans are attributed by *definition* via `SHOW CONSTRAINTS` / `SHOW INDEXES YIELD *`, never by name alone), `db seed`.
- `src/subgraph/` — APOC-based `cloneSubgraph` / `deleteSubgraph` (owned relationships are outgoing by default; root matched by label).
- `src/testing/` — public `CypherAssert`, `Neo4jRecordFactory`, `SelectionSetFactory`. They are user-facing API: keep them faithful to what the real driver returns.

### Security (`src/utils/validation.ts`, `src/utils/lucene.ts`)

All identifiers are validated (`assertSafeIdentifier`, `assertSafeLabel`) and backtick-escaped. Parameters use numbered naming (`param0`, `param1`) to prevent injection. Lucene queries are sanitized for fulltext search. Prototype pollution keys (`__proto__`, `constructor`) are blocked.

## Compiler invariants (must hold for every change)

Each of these was a shipped bug. Keep them true, and pin new code paths with a live test.

1. **Neo4j 5.x syntax.** The generated Cypher must run on Neo4j 5.x (5.26 LTS, Aura 5.27), which is stricter than 2025.x+:
   - A `CALL { … }` subquery may not directly follow a write clause (`SET`, `CREATE`, `MERGE … ON … SET`) — put a `WITH` in between.
   - The importing `WITH` must be the first clause of a `CALL` body.
   - Don't emit `CALL (x) { … }` (5.23+) or `OPTIONAL CALL` (5.24+); use the `CALL { WITH x … }` form.
   - No aggregation inside a pattern comprehension or `COLLECT { }` projection.
2. **Row cardinality.** A write must return each updated node exactly once:
   - Every inline `MATCH` / `OPTIONAL MATCH` / `UNWIND` in a write pipeline (connect, disconnect, nested ops) runs inside `CALL { … RETURN count(*) AS _x }`, so zero matches don't drop the node (and half-commit the write) and many matches don't multiply later clauses.
   - `@cypher` preludes reduce their column with `head(collect(col))` in an inner `CALL` — one row per node, `null` when the statement returns nothing.
3. **Order before projecting.** `ORDER BY` / `SKIP` / `LIMIT` go on `WITH *` **before** `RETURN n { … }` (`orderBeforeProjection`). After the projection, `n` is the map, not the node.
4. **Policies everywhere.** Any new read or write path that reaches a target type must apply that type's policy (see Node-Level Security). Run `tests/policy/` and `tests/integration/nls-enforcement.spec.ts`.
5. **Write input is validated, never silently dropped.** Unknown keys, unsupported nested shapes and unsupported arguments throw `OGMError`. If the generated types offer an input, the runtime must honour it (or the types must stop offering it).

## Proving a fix

- Reproduce first on a live 5.26 (see Commands), write the failing test, then fix. A mock-only test that checks Cypher strings cannot see a server-side rejection.
- Show the test failing without the fix using a **throwaway `git worktree`** of the pre-fix commit — not `git stash`, whose stack is shared across worktrees and parallel sessions.
- The property suites (`tests/integration/properties/`, fast-check, fixed seed) check the compiler invariants on generated reads and writes; a failure prints the seed, path and shrunk input — replay it with `PROPERTY_SEED=<seed> PROPERTY_PATH=<path>`, go deeper with `PROPERTY_RUNS=<n>` or another seed, and remove the generator exclusion named after a finding when you fix it.
- Never cast with `as never` / `as any` to get a bug repro to compile: check the real method signature first (e.g. `updateMany` takes `data`, not `update`; transaction `context` goes *inside* the params object).

## Releases

Conventional commits, signed, with no AI attribution. One `fix:` / `feat:` per change (`Closes #N` in the body when it fixes an issue), then `chore: release vX.Y.Z — summary` touching only `CHANGELOG.md` + `package.json`. Pushing an annotated `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which builds, tests and publishes to npm (allow ~2 min for `latest` to update). A fix that changes behaviour callers may rely on is a **minor** release with a "Behavior changes" section, never a patch (security fixes may be patches by explicit decision).

## Conventions

- **Parameter naming**: Where clauses use `param0..N`, fulltext uses `ft_phrase`/`ft_score`, updates use `update_fieldName`, selections use `sel_param0..N`
- **Cypher variables**: Nodes are `n`, `n0`, `n1` (depth-based); relationships are `r0`, `r1`; edges are `e0`, `e1`
- **Caching**: Compilers cache parsed results with `clearCache()` methods for test isolation. Call `Model.clearSelectionCache()` in tests when needed.
- **Error types**: `OGMError` (base), `RecordNotFoundError` (from `findFirstOrThrow`/`findUniqueOrThrow`)
- **Tests**: Unit tests use mock factories (`NodeDefinition`, `PropertyDefinition`, `RelationshipDefinition`) rather than parsing real schemas. Behaviour that depends on the server gets a live test under `tests/integration/` (opt-in on `NEO4J_URI`; `It`-prefixed labels, a per-run `runId`, cleanup in `afterAll`). Generated-type fixes are tested by compiling real user code (`tests/helpers/generated-typecheck.ts`). `CypherAssert`, `Neo4jRecordFactory`, and `SelectionSetFactory` are exported from `src/testing/`.
- **Version labels in comments**: comments that explain a fix name the release it ships in (`v2.4.8 — …`, `Pre-2.4.8 …`).
- **TypeScript**: Strict mode, ES2020 target, CommonJS output
- **Style**: Single quotes, trailing commas (Prettier), no `console.log` (ESLint)

<!-- gortex:communities:start -->
## Codebase Overview (generated by Gortex)

- **Languages:** typescript (primary), contract, gitignore, go, graphql, image, javascript, json, markdown, yaml
- **Entry points:** `bench/index.ts`, `examples/01-basic-crud.ts`, `examples/02-prisma-like-queries.ts`, `examples/03-typed-select.ts`, `examples/04-where-filters.ts`, `examples/05-nested-mutations.ts`, `examples/06-fulltext-search.ts`, `examples/07-transactions.ts`, `examples/08-raw-cypher.ts`, `examples/09-interface-models.ts`, `examples/10-multi-label.ts`, `examples/11-aggregation.ts`, `examples/12-error-handling.ts`, `examples/13-code-generation.ts`, `examples/14-testing-utilities.ts`, `src/cli/index.ts`
- **Most-referenced symbols:** `compile` (240 usages), `permissive` (195 usages), `get` (172 usages), `OGM` (163 usages), `model` (131 usages), `find` (129 usages), `withContext` (121 usages), `OGMError` (112 usages), `compile` (89 usages), `emitInputTypes` (80 usages)
- **Graph size:** 7700 nodes, 40018 edges
- **Breakdown:** 5 contracts, 472 docs, 22 fields, 235 files, 1052 functions, 34 generic_params, 1 images, 510 imports, 87 interfaces, 2254 locals, 181 methods, 28 modules, 1440 params, 1 todos, 273 types, 1105 variables

## MANDATORY: Use Gortex MCP tools instead of Read/Grep/Glob

Gortex is running as an MCP server. You **MUST** prefer graph queries over file reads on every task in this repo — `search_symbols`, `find_usages`, `get_symbol_source`, `get_editing_context`, `smart_context`, `edit_symbol` / `edit_file` / `rename_symbol` / `batch_edit`. PreToolUse hooks deny `Read` / `Grep` / `Glob` against indexed source; the deny message names the right tool. The full per-tool catalog loads via `tools/list` — not restated here.

### Calibration: the graph narrows scope, source confirms behavior

The mandate above stands — but graph queries *narrow scope*, they do not *replace reading the implementation*. The graph tells you **where** the logic lives and **what** connects to it; the source tells you **how** it behaves. For the symbol you are about to change or depend on, read its full body with `get_symbol_source` — do not act on a one-line summary alone.

Be especially deliberate with **behavior-critical code** — database migrations, retry / fallback / error-recovery paths, compatibility shims, concurrency-sensitive sections, and the tests that pin them. For these, call `get_symbol_source` and read the real implementation; never pass `compress_bodies:true`, which elides exactly the branches that carry the risk. Reserve compressed bodies and graph summaries for breadth (surveying many symbols); use full source for the few you are about to commit to.

## Required workflow (every task on this repo)

These are not suggestions — run each step at the trigger.

1. Confirm the daemon is up with `index_health` (cheap liveness + scope). Call `graph_stats` only when you actually need node/edge counts or `per_repo` orientation — it returns a large payload and can block during warmup.
2. If `total_nodes` is 0, **call** `index_repository` with `"."` before anything else.
3. In multi-repo mode, **call** `get_active_project` to check scope; use `set_active_project` to switch.
4. Open a non-trivial task with `smart_context` for orientation. For a single known symbol or file, go straight to `search_symbols` / `get_symbol_source` — don't front-load `smart_context` before every read.
5. Before editing a file, **call** `get_editing_context` on it first.
6. Before changing any function signature, **call** `verify_change` to catch broken callers and interface implementors (cross-repo).
7. For any refactor, **call** `get_edit_plan` then `batch_edit` to apply atomically.
8. Verify with the project's real build/test. Reserve `check_guards` for guard-relevant changes and `get_test_targets` to find the tests covering a substantive change — not mechanically after every edit.

<!-- gortex:skills:start -->
## Community Skills

| Area | Description | Skill |
|------|-------------|-------|
| Compilers 2 Dirs Buildupdaterelationships | 499 symbols | `/gortex-compilers-2-dirs-buildupdaterelationships` |
| Src 3 Dirs Aggregate | 277 symbols | `/gortex-src-3-dirs-aggregate` |
| Tests 4 Dirs Relationshipdefinition | 238 symbols | `/gortex-tests-4-dirs-relationshipdefinition` |
| Examples 3 Dirs | 204 symbols | `/gortex-examples-3-dirs` |
| Compilers 3 Dirs | 171 symbols | `/gortex-compilers-3-dirs` |
| Examples Inputmaybe | 147 symbols | `/gortex-examples-inputmaybe` |
| Compilers 2 Dirs Compileconditions | 146 symbols | `/gortex-compilers-2-dirs-compileconditions` |
| Policy 1 Dirs Permissive | 146 symbols | `/gortex-policy-1-dirs-permissive` |
| Tests 4 Dirs Propertydefinition | 133 symbols | `/gortex-tests-4-dirs-propertydefinition` |
| Src 6 Dirs | 132 symbols | `/gortex-src-6-dirs` |
| Tests 5 Dirs | 123 symbols | `/gortex-tests-5-dirs` |
| Schema 1 Dirs Parseschema | 106 symbols | `/gortex-schema-1-dirs-parseschema` |
| Policy 3 Dirs | 101 symbols | `/gortex-policy-3-dirs` |
| Cli 3 Dirs Rundbpush | 97 symbols | `/gortex-cli-3-dirs-rundbpush` |
| Emitters 5 Dirs | 87 symbols | `/gortex-emitters-5-dirs` |
| Src 3 Dirs Compilerelationshipindex | 86 symbols | `/gortex-src-3-dirs-compilerelationshipindex` |
| Utils 1 Dirs Refuse | 86 symbols | `/gortex-utils-1-dirs-refuse` |
| Compilers 1 Dirs Compileconnection | 85 symbols | `/gortex-compilers-1-dirs-compileconnection` |
| Compilers 1 Dirs Normalizerelationship | 66 symbols | `/gortex-compilers-1-dirs-normalizerelationship` |
| Policy 2 Dirs | 66 symbols | `/gortex-policy-2-dirs` |
<!-- gortex:skills:end -->

<!-- gortex:communities:end -->
