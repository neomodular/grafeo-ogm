# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

grafeo-ogm is a type-safe Object-Graph Mapper for Neo4j that uses GraphQL SDL as the schema definition language. It compiles high-level CRUD operations into parameterized Cypher queries with full TypeScript type safety via code generation. It is a community continuation of the deprecated `@neo4j/graphql-ogm`, maintaining full backwards compatibility while adding Prisma-inspired query methods and runtime multi-label support.

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

## Architecture

### Core Pipeline

```
GraphQL SDL → parseSchema() → SchemaMetadata → Compilers → Cypher + Params → Executor → Neo4j → ResultMapper → JS objects
```

**OGM** (`src/ogm.ts`) is the central hub. It parses the schema once in the constructor, creates shared compiler instances, and vends cached `Model` / `InterfaceModel` instances via `ogm.model(name)`.

**Model** (`src/model.ts`) implements all CRUD operations by delegating to the compiler pipeline and executor. Includes Prisma-like methods: `find`, `findFirst`, `findUnique`, `findFirstOrThrow`, `findUniqueOrThrow`, `create`, `createMany`, `update`, `updateMany`, `delete`, `deleteMany`, `upsert`, `count`, `aggregate`, `setLabels`. Supports both string `selectionSet` and typed `select: {}` API (mutually exclusive). All query/mutation methods accept a `labels` parameter for runtime multi-label filtering.

**InterfaceModel** (`src/interface-model.ts`) provides read-only queries (`find`, `findFirst`, `findUnique`, `findFirstOrThrow`, `findUniqueOrThrow`, `count`, `aggregate`) across all types implementing a shared GraphQL interface. Mutations throw — use the concrete model instead. Always returns `__typename` in results.

### Schema Layer (`src/schema/`)

- `parser.ts` — Parses GraphQL SDL into `SchemaMetadata` using `graphql-js`. Handles `@node`, `@relationship`, `@id`, `@unique`, `@cypher`, `@fulltext` directives.
- `types.ts` — Core types: `SchemaMetadata`, `NodeDefinition`, `PropertyDefinition`, `RelationshipDefinition`. All collections use `Map` for O(1) lookups.

### Compiler Layer (`src/compilers/`)

Each compiler is stateless and produces `{ cypher, params }` output:

- **WhereCompiler** — Filter objects → `WHERE` clauses. Supports scalar operators (`_CONTAINS`, `_GT`, `_IN`, etc.), logical (`AND`/`OR`/`NOT`), relationship quantifiers (`_SOME`/`_NONE`/`_ALL`), and connection filters. Max recursion depth: 10.
- **SelectionCompiler** — GraphQL selection sets → Cypher map projections (`RETURN n { .id, .name }`). Handles relationships via pattern comprehensions, unions via `CASE WHEN`, connections via edge patterns. 200-entry LRU parse cache. Max depth: 5.
- **MutationCompiler** — Generates `CREATE`, `SET`, `DELETE`, `MERGE` Cypher with nested relationship operations (connect/disconnect). Handles multi-label nodes and cascade deletes.
- **FulltextCompiler** — Builds `CALL db.index.fulltext.queryNodes()` clauses. Validates index names against schema.
- **SelectNormalizer** — Converts typed `select` API objects into `SelectionNode[]` trees for SelectionCompiler. Handles `field: true` (scalar or all-scalars for relationships), `field: { select: {}, where?: {} }` (nested selection with optional filtering), and connection fields (`*Connection` suffix with `edges.node`/`edges.properties`).

### Execution Layer (`src/execution/`)

- **Executor** — Runs Cypher via neo4j-driver. Supports explicit transactions, managed transactions, auto-commit sessions. Static `debug` flag for query logging.
- **ResultMapper** — Converts Neo4j types (Integer, DateTime, Point, Node, Relationship) to plain JS objects. Depth guard at 50. Uses `Object.create(null)` to prevent prototype pollution.

### Type Generator (`src/generator/`)

`generateTypes()` orchestrates sequential type emitters to produce a complete TypeScript file from schema. Emitters in `type-emitters/` each handle one concern (node types, where inputs, mutation inputs, connections, aggregations, etc.). Output is optionally formatted with Prettier.

### Security (`src/utils/validation.ts`, `src/utils/lucene.ts`)

All identifiers are validated (`assertSafeIdentifier`, `assertSafeLabel`) and backtick-escaped. Parameters use numbered naming (`param0`, `param1`) to prevent injection. Lucene queries are sanitized for fulltext search. Prototype pollution keys (`__proto__`, `constructor`) are blocked.

## Conventions

- **Parameter naming**: Where clauses use `param0..N`, fulltext uses `ft_phrase`/`ft_score`, updates use `update_fieldName`, selections use `sel_param0..N`
- **Cypher variables**: Nodes are `n`, `n0`, `n1` (depth-based); relationships are `r0`, `r1`; edges are `e0`, `e1`
- **Caching**: Compilers cache parsed results with `clearCache()` methods for test isolation. Call `Model.clearSelectionCache()` in tests when needed.
- **Error types**: `OGMError` (base), `RecordNotFoundError` (from `findFirstOrThrow`/`findUniqueOrThrow`)
- **Tests**: Use mock factories (`NodeDefinition`, `PropertyDefinition`, `RelationshipDefinition`) rather than parsing real schemas. `CypherAssert`, `Neo4jRecordFactory`, and `SelectionSetFactory` are exported from `src/testing/`.
- **TypeScript**: Strict mode, ES2020 target, CommonJS output
- **Style**: Single quotes, trailing commas (Prettier), no `console.log` (ESLint)
