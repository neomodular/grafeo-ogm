<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/grafeo-mark-on-dark.svg" />
    <img src="./assets/brand/grafeo-mark-on-light.svg" alt="grafeo-ogm" width="96" height="96" />
  </picture>
</p>

<h1 align="center">grafeo-ogm</h1>

<p align="center"><strong>Type-safe Neo4j queries, without the boilerplate.</strong><br />A type-safe object-graph mapper for Neo4j, driven by GraphQL SDL.</p>

[![npm version](https://img.shields.io/npm/v/grafeo-ogm.svg)](https://www.npmjs.com/package/grafeo-ogm)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933.svg)](https://nodejs.org/)
[![Neo4j](https://img.shields.io/badge/Neo4j-5.x-008CC1.svg)](https://neo4j.com/)

Define your graph model once in `.graphql` and get fully typed CRUD operations, optimized Cypher compilation, and TypeScript code generation -- no boilerplate, no Cartesian products, no injection vulnerabilities.

> **grafeo** (*/ˈɡra.fe.o/*) -- from Greek *grapho* (write, draw), the root behind "graph." Because your data model should be written once and understood everywhere.

---

## Table of Contents

- [Why grafeo-ogm?](#why-grafeo-ogm)
- [Common Use Cases](#common-use-cases)
- [Quick Start](#quick-start)
- [CLI](#cli)
- [Features Overview](#features-overview)
- [Schema Definition](#schema-definition)
- [Query API](#query-api)
- [Mutation API](#mutation-api)
- [Strict mode](#strict-mode)
- [Advanced Features](#advanced-features)
- [Vector Search](#vector-search)
- [Type Generation](#type-generation)
- [Testing Utilities](#testing-utilities)
- [Security](#security)
- [Migration from @neo4j/graphql-ogm](#migration-from-neo4jgraphql-ogm)
- [Comparisons](#comparisons)
- [FAQ](#faq)
- [API Reference](#api-reference)
- [Contributing](#contributing)
- [License](#license)

---

## Why grafeo-ogm?

The official [`@neo4j/graphql-ogm`](https://github.com/neo4j/graphql/tree/changeset-release/lts/packages/ogm/) was deprecated with no development path beyond v5. grafeo-ogm is a community continuation that maintains **full backward compatibility** while addressing five fundamental problems the original library could never patch:

| Problem | @neo4j/graphql-ogm | grafeo-ogm |
|---|---|---|
| **Deprecation** | Abandoned by Neo4j; no path beyond v5 | Actively maintained; evolves with your schema |
| **Query efficiency** | `OPTIONAL MATCH` chains that create Cartesian products across relationships | Pattern comprehensions scoped to matched nodes -- O(1) rows per node regardless of relationship count |
| **Security** | No identifier validation, no injection prevention, no parameterization enforcement | 7 security controls: parameterization, identifier regex, label validation, prototype pollution prevention, Lucene escaping, depth limiting, sort direction validation |
| **Type generation** | Monolithic multi-MB output; required a running Neo4j driver at build time | Modular emitter pipeline; no driver needed at build time; output sized proportionally to schema |
| **Customization** | No union type support, no subquery isolation, no edge property queries | Full union/interface support, `CALL` subquery isolation for mutations, connection fields with edge properties |

### Pattern Comprehensions vs. OPTIONAL MATCH

The most impactful difference is how relationships are queried. The old OGM chains `OPTIONAL MATCH` clauses that multiply intermediate rows:

```
10 variants x 5 categories x 3 tags = 150 intermediate rows per node
Query 200 nodes = 30,000 rows processed
```

grafeo-ogm uses pattern comprehensions that evaluate each relationship independently inside the RETURN projection:

```cypher
RETURN n {
  .id, .name,
  variants: [(n)-[:HAS_VARIANT]->(n0:Variant) | n0 { .id, .value }],
  status: head([(n)-[:HAS_STATUS]->(n0:Status) | n0 { .id, .name }])
}
-- Always 1 row per node. Adding relationships adds list expressions, never rows.
```

| Query | Old OGM (rows) | grafeo-ogm (rows) | Reduction |
|---|---|---|---|
| 1 node, 10+5+3 rels | 150 | 1 | 150x |
| 50 nodes, same rels | 7,500 | 50 | 150x |
| 200 nodes, same rels | 30,000 | 200 | 150x |

### CALL Subquery Isolation

Mutations with multiple connect/disconnect operations are wrapped in `CALL { ... }` subqueries. Each operation runs in isolation -- no Cartesian products, no duplicate relationships, no silently dropped operations when a disconnect target doesn't exist.

---

## Common Use Cases

grafeo-ogm fits any TypeScript application backed by Neo4j. Common patterns it solves cleanly:

**Knowledge graphs & semantic search**
Model entities, properties, and relationships in GraphQL SDL. Combine relationship traversal with `@fulltext` indexes for hybrid keyword + structural queries (e.g. "find all `Document` nodes mentioning *X* that are linked to active `Project` nodes owned by team *Y*").

**Social graphs & follower networks**
Multi-hop traversals with relationship properties (e.g. `since`, `weight`) become typed `*Connection` queries with sortable edges. No raw Cypher needed for "mutual followers", "friends of friends", or "shortest path between users".

**Recommendation engines**
Express collaborative filtering as relationship queries: "users who bought *X* also bought *Y*" becomes a typed `connect`/`*Connection` selection sorted by edge frequency or recency. Use `@cypher` directives for custom scoring algorithms in pure Cypher.

**Permission & policy graphs (RBAC / ReBAC)**
Model `User → ROLE → Permission` chains as native relationships. Filter queries with relationship existence (`Connection_SOME`) instead of joining tables. Multi-label nodes (`@node(labels: [...])`) handle hierarchical roles cleanly.

**Master data management & data lineage**
Track provenance, transformations, and dependencies between datasets. Interface types (`InterfaceModel`) let you query polymorphic entities (any `Asset`, any `Pipeline`) without losing type safety.

**Fraud detection & anti-money laundering**
Express patterns like "transaction chains > 3 hops between sanctioned accounts" using relationship quantifiers (`_SOME`, `_NONE`, `_ALL`). The mutation compiler's `CALL` subquery isolation prevents pipeline pollution when batching graph updates.

**Content management with rich relationships**
Articles, authors, tags, categories, and comments — all with edge metadata (timestamps, ordering, visibility). Connection edges with `orderBy: { edge: { ... } }` give you Prisma-style sortable joins on relationship properties.

---

## Quick Start

### Installation

```bash
# npm
npm install grafeo-ogm neo4j-driver graphql

# pnpm
pnpm add grafeo-ogm neo4j-driver graphql

# yarn
yarn add grafeo-ogm neo4j-driver graphql
```

### 1. Define your schema

> **Fastest start:** `npx grafeo init` scaffolds a starter `schema.graphql` + `grafeo.config.ts` for you — and auto-detects an existing setup. See [CLI → `grafeo init`](#cli). Prefer to do it by hand? Define a `schema.graphql`:

```graphql
# schema.graphql
type Book @node
  @fulltext(indexes: [{ name: "BookSearch", fields: ["title"] }]) {
  id: ID! @id @unique
  title: String!
  isbn: String @unique
  published: DateTime
  author: Author! @relationship(type: "WRITTEN_BY", direction: OUT)
  categories: [Category!]! @relationship(type: "IN_CATEGORY", direction: OUT)
}

type Author @node {
  id: ID! @id @unique
  name: String!
  books: [Book!]! @relationship(type: "WRITTEN_BY", direction: IN)
}

type Category @node {
  id: ID! @id @unique
  name: String!
}
```

### 2. Generate types (recommended)

```bash
npx grafeo generate
```

This wraps `generateTypes()` to emit typed models from your SDL — wire them in with `new OGM<ModelMap>(...)` for full inference. See the [CLI](#cli) and [Type Generation](#type-generation) sections. You can skip this and run the OGM untyped, but you forfeit compile-time safety.

### 3. Initialize the OGM

```typescript
import { OGM } from 'grafeo-ogm';
import neo4j from 'neo4j-driver';
import fs from 'fs';

const driver = neo4j.driver(
  'bolt://localhost:7687',
  neo4j.auth.basic('neo4j', 'password'),
);
const typeDefs = fs.readFileSync('./schema.graphql', 'utf-8');

const ogm = new OGM({ typeDefs, driver });
```

For new code, pass `strict: true` as well. It turns on the corrected behaviour for a handful of surprising input shapes and becomes the default in 3.0. See [Strict mode](#strict-mode).

### 4. Basic CRUD

```typescript
const Book = ogm.model('Book');

// Create
const result = await Book.create({
  input: [{
    title: 'Graph Databases',
    isbn: '978-1491930892',
    author: { connect: { where: { node: { name: 'Jim Webber' } } } },
  }],
});

// Read
const books = await Book.find({
  where: { title_CONTAINS: 'Graph' },
  select: {
    id: true,
    title: true,
    author: { select: { name: true } },
  },
});

// Update
await Book.update({
  where: { isbn: '978-1491930892' },
  update: { title: 'Graph Databases, 2nd Edition' },
});

// Delete
await Book.delete({ where: { isbn: '978-1491930892' } });
```

### 5. Transactions

```typescript
await ogm.$transaction(async (ctx) => {
  await Book.create({ input: [{ title: 'Book A' }], context: ctx });
  await Book.create({ input: [{ title: 'Book B' }], context: ctx });
  // Both committed atomically, or both rolled back on error
});
```

---

## CLI

grafeo-ogm ships a `grafeo` binary (installed with the package — no global install needed). Run it with `npx grafeo <command>`. The CLI is plumbing over the same library machinery you can call programmatically: `generate` wraps `generateTypes()`, and `db push` reuses the constraint/index logic behind `assertIndexesAndConstraints()`.

| Command | Purpose |
|---|---|
| `grafeo init` | Scaffold a project — or auto-detect an existing one — wiring config, schema, and an npm script |
| `grafeo generate` | Generate TypeScript types from your SDL — one-shot, `--watch`, or `--verify` CI gate |
| `grafeo db push` | Diff SDL-declared constraints/indexes against the live database and apply them |
| `grafeo db seed` | Run your seed script with a constructed, connected OGM |

### Configuration

All commands read `grafeo.config.ts` (or `.js` / `.json`) from the working directory — first found wins. Command-line flags override config values. `defineConfig` gives full type inference:

```typescript
// grafeo.config.ts
import { defineConfig } from 'grafeo-ogm';

export default defineConfig({
  schema: './schema.graphql',          // default: ./schema.graphql
  out: './src/generated/ogm-types.ts', // default: ./grafeo.generated.ts
  // generate: forwarded to generateTypes(). Set packageName ONLY if you
  // installed grafeo-ogm under an npm alias, e.g. { packageName: '@myorg/ogm' }
  database: {
    uri: process.env.NEO4J_URI,
    username: process.env.NEO4J_USERNAME,
    // password: from config or NEO4J_PASSWORD — never a CLI flag (see below)
  },
  seed: './scripts/seed.ts',
  vectorIndexes: {
    // @vector SDL carries no dimensions; db push reads them here, keyed by index name
    BookEmbedding: { dimensions: 1536, similarity: 'cosine' },
  },
});
```

**Database connection** resolves per setting in precedence order: CLI flag (`--uri`, `--username`, `--database`) > config `database` block > environment (`NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`). The **password is never accepted as a CLI flag** — argv leaks through process listings and shell history, so it must come from `NEO4J_PASSWORD` or the config file.

> **Config and seed files run as trusted code.** `grafeo.config.ts` and your seed script are executed in-process (via [jiti](https://github.com/unjs/jiti)) with your database credentials — the same trust model as Prisma/Drizzle. Only run `grafeo` in a directory whose config and seed files you control.

### `grafeo init`

Sets up a project in one step. In an **existing** grafeo project it auto-detects your schema (by its `@node`/`@relationship` directives) and a previously generated types file (by the generator's header marker), and writes a `grafeo.config.ts` wired to them. With **nothing to detect** (or `--fresh`), it scaffolds a starter `schema.graphql` — the Neo4j movie example — plus the config. Either way it adds a `"generate": "grafeo generate"` npm script.

```bash
npx grafeo init          # interactive: detect or scaffold, confirm the paths
npx grafeo init --yes    # non-interactive: accept detected values / defaults (CI)
```

| Flag | Description |
|---|---|
| `--schema <path>` | schema path (skip detection/prompt) |
| `--out <path>` | generated-types output path |
| `--seed` | also scaffold a `seed.ts` upsert stub |
| `--fresh` | ignore a detected setup and scaffold a new project |
| `--yes` | non-interactive: detected values / defaults, no prompts |
| `--force` | overwrite an existing `grafeo.config.ts` / `seed.ts` |

`init` is **non-destructive** — it never overwrites your config, schema, or seed without `--force` (or an interactive confirmation), and connection settings reference `NEO4J_*` env vars (it never prompts for a password).

On an interactive run, `init` opens with the grafeo wordmark splash. It's purely decorative and gates on a real terminal: when stdout is piped or redirected (`grafeo init > file`, `grafeo init | tee`), or in CI, the splash is suppressed so captured output stays clean. `NO_COLOR` is honored.

### `grafeo generate`

Compiles your SDL to TypeScript types (wraps `generateTypes()` — see [Type Generation](#type-generation) for the programmatic API and the full option list).

```bash
npx grafeo generate          # one-shot
npx grafeo generate --watch  # regenerate on schema change
npx grafeo generate --verify # CI gate: exit 1 if the file on disk is stale
```

| Flag | Description |
|---|---|
| `--schema <path>` | SDL path (overrides config; default `./schema.graphql`) |
| `--out <path>` | Output path (default `./grafeo.generated.ts`) |
| `--watch` | Debounced regeneration on change; a failed parse prints the error and keeps watching |
| `--verify` | Generate in memory, byte-compare against the file on disk, write nothing, exit 1 on drift |
| `--poll <ms>` | Use polling instead of `fs.watch` (fallback where native watching misfires) |

`--verify` is the CI staleness gate: commit your generated types, then run `grafeo generate --verify` in CI to fail the build if the schema changed without a regeneration.

### `grafeo db push`

Synchronizes the **constraints and indexes** your SDL declares (`@unique` → unique constraints, `@fulltext` → fulltext indexes, `@vector` → vector indexes) with the live database. Constraints and indexes only — **not data**. (`db push` is deliberately scoped; use a dedicated migration tool for data.) `@id` alone creates **no** constraint: it only generates a UUID on create. Add `@unique` (`id: ID! @id @unique`) to have the database enforce uniqueness.

```bash
npx grafeo db push --dry-run          # preview the plan — DO THIS FIRST
npx grafeo db push                    # apply (additive: creates only what's missing)
npx grafeo db push --force-drop --yes # also drop orphaned grafeo-managed items
```

`db push` introspects `SHOW CONSTRAINTS` / `SHOW INDEXES`, diffs against your SDL, and prints a plan in five buckets:

- **create** — declared in SDL, missing in the database
- **in sync** — already present with the declared definition. A unique constraint is also in sync when an equivalent constraint (same label and property) exists under another name, such as one a DBA created; push prints `X covered by <name>` instead of creating it. Before v2.4.8 push printed "created X" on every run while Neo4j created nothing.
- **changed** — an index present under the SDL name whose definition differs (fulltext fields or label, vector dimensions or similarity, index type). The output says the schema is **NOT in sync**; the index is **kept as-is** unless you pass `--force-drop`, which drops and recreates it under the same consent rules as orphans. Before v2.4.8 indexes were matched by name only, so a changed definition was reported as in sync and never applied.
- **orphans** — grafeo-named (`{Label}_{prop}_unique`) constraints no longer in your SDL; **reported and kept** unless you pass `--force-drop`
- **unmanaged** — constraints/indexes that don't follow grafeo's naming convention (hand-created DBA indexes, etc.); **never touched, never counted as drift**

If a plain RANGE index already covers a property you mark `@unique`, Neo4j refuses the constraint until that index is dropped. Push reports this as a warning (the index isn't grafeo's, so it is never dropped) and applies the rest of the plan; before v2.4.8 the push crashed with exit 1. "created X" is printed only when Neo4j reports that something was added.

It is **additive by default** and **idempotent** — a second run with no schema change is a no-op. Dropping orphans and recreating changed indexes is destructive and gated: `--force-drop` lists the exact drops (shown in `--dry-run` too) and requires interactive confirmation, or `--yes` in non-interactive sessions like CI.

| Flag | Description |
|---|---|
| `--dry-run` | Print the full plan (including the exact Cypher, drops included) and exit without writing |
| `--force-drop` | Permit dropping orphaned grafeo-managed constraints/indexes, and dropping + recreating indexes whose definition changed |
| `--yes` | Confirm destructive drops non-interactively (required with `--force-drop` in CI) |
| `--schema <path>`, `--uri`, `--username`, `--database` | Schema path and connection overrides |

> **Vector indexes** declare no dimensions in the SDL (the `@vector` directive only names the index and its embedding property), but Neo4j requires them at creation time. Supply them in `vectorIndexes` (keyed by index name) in your config. A `@vector` index without configured dimensions is reported and skipped — never silently created or dropped.

### `grafeo db seed`

Runs your seed script with a constructed, connected `OGM`. It resolves the entry point from config `seed`, then `./seed.ts`, then `./seed.js`. The module's default export receives the OGM; the CLI awaits it and **always closes the driver**, even if the seed throws.

```typescript
// seed.ts
import type { OGM } from 'grafeo-ogm';

export default async function seed(ogm: OGM) {
  const Book = ogm.model('Book');
  // Prefer upsert over create so repeated seeds converge instead of duplicating data.
  await Book.upsert({
    where: { id: '1' },
    create: { id: '1', title: 'Dune' },
    update: { title: 'Dune' },
  });
}
```

```bash
npx grafeo db seed
```

grafeo does not enforce idempotency — use `upsert` so re-running the seed is safe. Connection and schema resolve exactly as for `db push`, including the database (`--database` > `database.database` > `NEO4J_DATABASE`). Before v2.4.8 `db seed` ignored the database setting and always seeded the server's default database.

---

## Features Overview

| Feature | Description |
|---|---|
| **Prisma-like query API** | `find`, `findFirst`, `findUnique`, `findFirstOrThrow`, `findUniqueOrThrow`, `create`, `createMany`, `update`, `updateMany`, `delete`, `deleteMany`, `upsert`, `count`, `aggregate` |
| **GraphQL SDL schemas** | Define nodes, relationships, interfaces, unions, enums, and fulltext indexes using Neo4j GraphQL directives |
| **Full TypeScript type safety** | Code generation produces typed models, where inputs, create/update inputs, select fields, and connection types |
| **Pattern comprehensions** | Relationship traversal without Cartesian products -- O(1) rows per node |
| **Typed `select` API** | `select: { id: true, author: { select: { name: true } } }` with compile-time type checking |
| **Fulltext search** | Node and relationship indexes with phrase matching, score thresholds, and logical operators (`AND`, `OR`, `NOT`). Per-node typed inputs with literal-string autocomplete for index names |
| **Vector search** | `@vector` directive with `searchByVector` (top-k similarity) and `searchByPhrase` (via the Neo4j GenAI plugin). Typed results as `{ node, score }[]` |
| **Subgraph operations** | Clone and delete entire subgraphs via APOC with reference relationship re-attachment |
| **Runtime multi-label** | Add/remove/filter by labels at query time: `labels: ['Active']`, `setLabels()` |
| **Interface models** | Polymorphic read queries across all types implementing a shared interface, with `__typename` discrimination |
| **Connection types** | Cursor pagination with edge properties via `*Connection` fields |
| **Nested mutations** | Create, connect, disconnect, and cascade-delete related nodes in a single operation |
| **Transaction support** | `$transaction()` for atomic multi-operation writes with automatic commit/rollback |
| **Raw Cypher** | `$queryRaw()` and `$executeRaw()` for escape hatches |
| **7 security controls** | Parameterization, identifier validation, label validation, prototype pollution prevention, Lucene escaping, depth limiting, sort direction validation |
| **Testing utilities** | `CypherAssert`, `Neo4jRecordFactory`, `SelectionSetFactory` for unit testing without a database |
| **Backward compatible** | Drop-in replacement for `@neo4j/graphql-ogm` |

---

## Schema Definition

grafeo-ogm uses standard GraphQL SDL with Neo4j directives to define your graph model.

### Supported Directives

| Directive | Target | Description |
|---|---|---|
| `@node` | Type | Marks a type as a Neo4j node. Optional `labels` argument for multi-label nodes (implementors of an interface no longer need to include the interface name since v2.5.0, see [Interfaces](#interfaces)) |
| `@relationship` | Field | Defines a relationship with `type`, `direction` (exactly `IN` or `OUT`; anything else is a schema error), and optional `properties` |
| `@declareRelationship` | Interface field | Declares a relationship on an interface. Its `type`, `direction` and `properties` come from the implementors' `@relationship`, which must all agree |
| `@relationshipProperties` | Type | Marks a type as relationship properties (edge data) |
| `@id` | Field | Auto-generates a UUID on create (creates no constraint — add `@unique` for one) |
| `@unique` | Field | Creates a uniqueness constraint in Neo4j |
| `@cypher` | Field | Computed field resolved via a custom Cypher statement. Scalar return types are resolved at runtime in `select` / `selectionSet`, `where`, and `options.sort` (see [Computed Fields with @cypher](#computed-fields-with-cypher)); node/interface return types remain projection-only |
| `@default` | Field | Sets a default `value` on create (scalar, enum, or a list of them for list fields). A required field with a default is optional in the generated `CreateInput` |
| `@fulltext` | Type | Defines fulltext search indexes with `name` and `fields` |
| `@vector` | Type | Registers one or more Neo4j vector indexes on a node (see [Vector Search](#vector-search)) |

### Supported Scalar Types

| Type | Neo4j Mapping | Notes |
|---|---|---|
| `String` | String | |
| `Int` | Integer | |
| `Float` | Float | |
| `Boolean` | Boolean | |
| `ID` | String | Typically used with `@id` for UUID generation |
| `DateTime` | DateTime | ISO 8601 format |
| `Date` | Date | |
| `Time` | Time | |
| `LocalTime` | LocalTime | |
| `LocalDateTime` | LocalDateTime | |
| `Duration` | Duration | |
| `BigInt` | Integer | 64-bit integer |
| `Point` | Point | Geographical coordinates (WGS-84) |
| `CartesianPoint` | Point | 2D/3D Cartesian coordinates |

### Relationships

```graphql
type Book @node {
  # Singular relationship (one author per book)
  author: Author! @relationship(type: "WRITTEN_BY", direction: OUT)

  # Array relationship (many categories)
  categories: [Category!]! @relationship(type: "IN_CATEGORY", direction: OUT)

  # Relationship with edge properties
  reviews: [Review!]! @relationship(
    type: "HAS_REVIEW",
    direction: OUT,
    properties: "HasReview"
  )
}

type HasReview @relationshipProperties {
  createdAt: DateTime
  rating: Int
}
```

### Interfaces

```graphql
interface Entity {
  id: ID!
  name: String!
  resources: [Resource!]! @declareRelationship
}

# Directives go after `implements` — `type User @node implements Entity` is
# not valid GraphQL.
type User implements Entity @node(labels: ["User", "Entity"]) {
  id: ID! @id
  name: String!
  email: String!
  resources: [Resource!]! @relationship(type: "OWNS", direction: OUT)
}

type Organization implements Entity @node(labels: ["Organization", "Entity"]) {
  id: ID! @id
  name: String!
  website: String
  resources: [Resource!]! @relationship(type: "OWNS", direction: OUT)
}

type Resource @node {
  id: ID! @id
}
```

Interface types can be queried polymorphically via `ogm.interfaceModel('Entity')`. Results include `__typename` to discriminate concrete types.

- The interface model matches nodes by their **implementors' labels** (`MATCH (n:(User|Organization))`), so a node created with `ogm.model('User').create(...)` appears in interface queries with no extra labels. Since v2.5.0 an implementor does **not** need to carry the interface name; before v2.5.0 it had to list it in `@node(labels: [...])`, which still works.
- A `@declareRelationship` field takes its relationship `type`, `direction` and `properties` from the implementors. They must all declare the same ones; if they disagree, or an implementor has no `@relationship` on that field, `parseSchema` throws.

### Enums

```graphql
enum Status {
  DRAFT
  PUBLISHED
  ARCHIVED
}

type Book @node {
  status: Status
}
```

### Fulltext Indexes

```graphql
type Book @node
  @fulltext(indexes: [
    { name: "BookSearch", fields: ["title", "description"] }
  ]) {
  title: String!
  description: String
}
```

Relationship fulltext indexes are defined on `@relationshipProperties` types:

```graphql
type WrittenBy @relationshipProperties
  @fulltext(indexes: [{ name: "AuthorRoleSearch", fields: ["role"] }]) {
  role: String
}
```

---

## Query API

### Find Methods

```typescript
const Book = ogm.model('Book');

// find — returns all matching nodes
const books = await Book.find({
  where: { title_CONTAINS: 'Graph' },
  select: { id: true, title: true },
  options: { sort: [{ title: 'ASC' }], limit: 10, offset: 0 },
});

// findFirst — returns first match or null
const book = await Book.findFirst({
  where: { title_CONTAINS: 'Graph' },
  select: { id: true, title: true },
});

// findUnique — find by unique identifier or null
const book = await Book.findUnique({
  where: { isbn: '978-1491930892' },
  select: { id: true, title: true },
});

// findFirstOrThrow — throws RecordNotFoundError if no match
const book = await Book.findFirstOrThrow({
  where: { title: 'Exact Title' },
});

// findUniqueOrThrow — throws RecordNotFoundError if not found
const book = await Book.findUniqueOrThrow({
  where: { id: 'book-1' },
});
```

### WHERE Operators

**Comparison operators:**

| Operator | Cypher | Example |
|---|---|---|
| *(equality)* | `=` | `{ name: 'Wireless Mouse' }` |
| `_NOT` | `<>` | `{ name_NOT: 'x' }` |
| `_IN` | `IN` | `{ id_IN: ['a', 'b'] }` |
| `_NOT_IN` | `NOT IN` | `{ id_NOT_IN: ['a'] }` |
| `_GT` | `>` | `{ price_GT: 10 }` |
| `_GTE` | `>=` | `{ price_GTE: 10 }` |
| `_LT` | `<` | `{ price_LT: 50 }` |
| `_LTE` | `<=` | `{ price_LTE: 50 }` |

**String operators:**

| Operator | Cypher | Example |
|---|---|---|
| `_CONTAINS` | `CONTAINS` | `{ name_CONTAINS: 'alb' }` |
| `_NOT_CONTAINS` | `NOT CONTAINS` | `{ name_NOT_CONTAINS: 'x' }` |
| `_STARTS_WITH` | `STARTS WITH` | `{ name_STARTS_WITH: 'A' }` |
| `_NOT_STARTS_WITH` | `NOT STARTS WITH` | `{ name_NOT_STARTS_WITH: 'X' }` |
| `_ENDS_WITH` | `ENDS WITH` | `{ name_ENDS_WITH: 'ol' }` |
| `_NOT_ENDS_WITH` | `NOT ENDS WITH` | `{ name_NOT_ENDS_WITH: 'x' }` |
| `_MATCHES` | `=~` (regex) | `{ name_MATCHES: '^A.*' }` |

**List fields** (`tags: [String!]`) are compared as a whole list, so only these operators exist for them:

| Operator | Matches when | Example |
|---|---|---|
| *(equality)* | the stored list equals the given list | `{ tags: ['a', 'b'] }` |
| `_NOT` | the stored list differs from the given list | `{ tags_NOT: ['a'] }` |
| `_IN` | the stored list equals one of the given lists | `{ tags_IN: [['a'], ['b', 'c']] }` |
| `_NOT_IN` | the stored list equals none of the given lists | `{ tags_NOT_IN: [['a']] }` |

**Relationship quantifiers:**

| Operator | Meaning | Example |
|---|---|---|
| *(bare key)* or `_SOME` | At least one related node matches | `{ categories_SOME: { name: 'Tech' } }` |
| `_NONE` | No related node matches | `{ categories_NONE: { name: 'Fiction' } }` |
| `_ALL` | Every related node matches | `{ categories_ALL: { name: 'Tech' } }` |
| `_SINGLE` | Exactly one related node matches | `{ categories_SINGLE: { name: 'Tech' } }` |

With [Node-Level Security](#node-level-security), quantifiers range over the related nodes the caller may **see**: a related node hidden by its type's `read` policy neither satisfies nor falsifies `_SOME`, `_NONE`, `_ALL` or `_SINGLE`.

**Logical operators:**

```typescript
await Book.find({
  where: {
    OR: [
      { title_CONTAINS: 'Graph' },
      { title_CONTAINS: 'Neo4j' },
    ],
    NOT: { status: 'ARCHIVED' },
  },
});
```

**Null handling:**

```typescript
// Scalar null check
await Book.find({ where: { isbn: null } });        // WHERE n.isbn IS NULL
await Book.find({ where: { isbn_NOT: null } });    // WHERE n.isbn IS NOT NULL

// Relationship existence
await Book.find({ where: { author: null } });       // NOT EXISTS pattern
await Book.find({ where: { author_NOT: null } });   // EXISTS pattern
```

| Input | Compiles to |
|---|---|
| `field: null` | `field IS NULL` |
| `field_NOT: null` | `field IS NOT NULL` |
| `relationship: null` | `NOT EXISTS { MATCH … }` |
| `relationship_NOT: null` | `EXISTS { MATCH … }` |
| any other operator with `null` (`_IN`, `_GT`, `_CONTAINS`, `_SOME`, …) | throws `OGMError` |
| an unknown field with `null` | throws `OGMError`, even without `strictWhere` |

The same rules apply everywhere a `where` is accepted: policy `when` partials, nested `select` filters, and nested-write `where`. Before v2.3.0, `{ field_NOT: null }` compiled to the always-true `` n.`field_NOT` IS NULL ``, so a filter such as a policy restrictive `{ approvedAt_NOT: null }` silently matched every row.

**Connection filters (with edge properties):**

```typescript
await Book.find({
  where: {
    categoriesConnection_SOME: {
      node: { name: 'Technology' },
      edge: { isPrimary: true },
    },
  },
});
```

### Selection Modes

grafeo-ogm supports two mutually exclusive selection modes. Providing both `select` and `selectionSet` throws an error.

**Typed `select` API (recommended):**

```typescript
const books = await Book.find({
  select: {
    id: true,
    title: true,
    author: { select: { name: true } },                          // nested selection
    categories: { where: { name_STARTS_WITH: 'Tech' }, select: { name: true } }, // with filter
  },
});

// Simple relationship: true returns all scalar fields
const books = await Book.find({
  select: { id: true, author: true },
});
```

**String `selectionSet` (legacy, fully supported):**

```typescript
const books = await Book.find({
  selectionSet: `{
    id
    title
    author { name }
    categories { id name }
  }`,
});

// Or set a default on the model instance
Book.selectionSet = `{ id title }`;
```

Since v2.5.0, `selectionSet` field **arguments and aliases** take effect, as in the original `@neo4j/graphql-ogm`:

```typescript
const books = await Book.find({
  selectionSet: `{
    id
    t: title                                        # alias → key "t"
    recent: categories(where: { name_STARTS_WITH: "Tech" }, options: { limit: 3 }) { name }
    categoriesConnection(where: { node: { name: "Science" } }) { totalCount edges { node { name } } }
  }`,
});
```

Relationship fields accept `where` and `options` (`sort` needs APOC; `limit` / `offset`), connection fields accept `where`, and any other argument throws `OGMError` rather than being ignored. Under [Node-Level Security](#node-level-security) the target type's `read` policy applies, exactly as for a typed `select` with `where`. Connection `totalCount` is filtered by the same `where` and policy as `edges`.

**Default (no selection):** Returns all scalar fields of the matched node.

### Nested Sorting

Array relationships and connection edges accept an `orderBy` clause that compiles to `apoc.coll.sortMulti` (requires the APOC plugin on the Neo4j instance).

**Array relationships** — sort by target-node scalar fields. Priority follows array order:

```typescript
await Author.find({
  select: {
    books: {
      orderBy: [{ year: 'DESC' }, { title: 'ASC' }],
      select: { id: true, title: true },
    },
  },
});
```

Singular relationships do not accept `orderBy` — sorting a single value is meaningless.

**Connection edges** — sort by **node** scalars or **`@relationshipProperties`** scalars, or mix both. Each `orderBy` entry has exactly one key: `node` or `edge`.

```typescript
await Author.find({
  select: {
    booksConnection: {
      where: { node: { published: true } },
      orderBy: [
        { edge: { since: 'DESC' } },   // sort edges first by relationship property
        { node: { title: 'ASC' } },    // then by target-node field
      ],
      select: {
        edges: {
          node: { select: { id: true, title: true } },
          properties: { select: { since: true } },
        },
      },
    },
  },
});
```

Validation rules:
- `edge` is only accepted when the relationship is declared with `@relationshipProperties`
- Fields must be scalars on the target node (for `node`) or on the relationship properties type (for `edge`)
- Direction must be `'ASC'` or `'DESC'`

### Automatic `__typename` for Abstract Targets

When a relationship resolves to a **union** or **interface**, `__typename` is emitted automatically into the projection — you don't need to add `__typename: true` to the select (or `__typename` to the `selectionSet`). This prevents silent discrimination failures on the client side where type guards return `false` because the discriminator was never projected.

```typescript
// Union target: __typename is synthesized from labels, no need to request it
const chapters = await Book.find({
  select: {
    chapters: {                 // chapters targets ChapterType = StandardChapter | RangeChapter
      select: { id: true },
    },
  },
});
// Each chapter still has chapter.__typename === 'StandardChapter' | 'RangeChapter'
```

Explicitly requesting `__typename: true` (or including it in a `selectionSet`) is still supported and idempotent — it will not be emitted twice.

### Sorting and Pagination

```typescript
const books = await Book.find({
  where: { status: 'PUBLISHED' },
  options: {
    sort: [{ title: 'ASC' }, { published: 'DESC' }],
    limit: 20,
    offset: 40,
  },
});
// ORDER BY n.title ASC, n.published DESC
```

**Each sort entry carries exactly one ordering key.** `ORDER BY` precedence
comes from an entry's position in the array, never from key order inside an
object:

```typescript
// ✅ correct — precedence is unambiguous
sort: [{ title: 'ASC' }, { published: 'DESC' }];

// ❌ rejected — compile error, and throws at runtime
sort: [{ title: 'ASC', published: 'DESC' }];
```

Why not just honour both keys? Because object key order is not a reliable
carrier for precedence. When sort input arrives through a GraphQL layer,
`graphql-js` rebuilds input objects by iterating the schema's field
definitions, so the order a client wrote is already gone before the OGM sees
it. Array position survives that trip; key order does not.

Building a sort list conditionally works the same way — push entries rather
than assembling one object:

```typescript
const sort: BookSort[] = [];
if (byTitle) sort.push({ title: 'ASC' });
if (byDate) sort.push({ published: 'DESC' });

await Book.find({ options: { sort } });
```

---

## Mutation API

### Create

```typescript
const Book = ogm.model('Book');

// Create one or more nodes
const result = await Book.create({
  input: [{
    title: 'Graph Databases',
    isbn: '978-1491930892',
    author: { connect: { where: { node: { name: 'Jim Webber' } } } },
    categories: {
      create: [{ node: { name: 'Technology' }, edge: { isPrimary: true } }],
    },
  }],
});
// result: { info: { nodesCreated, relationshipsCreated }, books: [...] }
```

### Create Many

```typescript
// Bulk create (scalar properties only, no nested ops)
const { count } = await Book.createMany({
  data: [
    { title: 'Book A', isbn: '111' },
    { title: 'Book B', isbn: '222' },
  ],
  skipDuplicates: true, // uses MERGE on unique fields
});
```

- Items may have different keys: each item gets every field it supplies. A field an item omits gets what `create()` would give it — a generated `@id`, its `@default`, or nothing — and an explicit `null` stays `null`.
- With `skipDuplicates`, the `MERGE` key is the `@id` / `@unique` fields that **every** item supplies, and `count` is the number of nodes actually **created** (skipped duplicates aren't counted).
- Relationship fields are rejected in any item; use `create()` for nested writes.

### Update

```typescript
const result = await Book.update({
  where: { id: 'book-1' },
  update: { title: 'Updated Title' },
  connect: {
    categories: [{ where: { node: { name: 'Science' } } }],
  },
  disconnect: {
    categories: { where: { node: { name: 'Fiction' } } },
  },
});
```

- **Connect** links every target matching its `where`. A `where` that matches nothing is a no-op: the update still applies and the node is still returned (as in `@neo4j/graphql`).
- **Disconnect** with `{}` / `null` removes every relationship of that type — under [Node-Level Security](#node-level-security), only to targets the context can **read**.
- Every connect and disconnect returns the updated node exactly once, however many relationships it touched.
- A key that is neither a property nor a relationship of the type throws `OGMError` (`Unknown field …`) instead of being written as a stray property — at every depth.

### Update Many

```typescript
// Bulk update (returns count only, no connect/disconnect)
const { count } = await Book.updateMany({
  where: { published_LT: '2020-01-01' },
  data: { isbn: null },
});
```

### Delete

```typescript
// Simple delete
await Book.delete({ where: { id: 'book-1' } });

// Cascade delete related nodes
await Book.delete({
  where: { id: 'book-1' },
  delete: {
    categories: [{ where: { node: { name: 'Temp Category' } } }],
  },
});
```

Cascade semantics:

- Each item deletes only the related nodes matching its `where`. An empty item (`{}`) deletes every related node of that relationship.
- An item may be a single object or an array of items.
- With [Node-Level Security](#node-level-security), each cascaded node must also pass its own type's `delete` policy. Nodes the policy rejects are kept.
- A `delete` nested inside a cascade item (multi-level cascade) throws `OGMError`, as do unknown keys in a cascade item.

> **Behavior change in v2.3.0:** before v2.3.0 the per-item `where` was ignored and the cascade deleted **every** related node, including nodes shared with other records. If you relied on that, pass `{}` explicitly.

### Delete Many

```typescript
const { count } = await Book.deleteMany({
  where: { title_CONTAINS: 'Draft' },
});
```

### Upsert

```typescript
// Create if not found, update if exists (scalar properties only)
const book = await Book.upsert({
  where: { isbn: '978-1491930892' },
  create: { title: 'Graph Databases', isbn: '978-1491930892' },
  update: { title: 'Graph Databases, Updated' },
  select: { id: true, title: true },
});
```

- `where` must contain at least one `@id` / `@unique` field, and **only** such fields — it becomes the `MERGE` key. Any other key (a plain field, an operator like `name_CONTAINS`, `AND` / `OR`) or a `null` value throws. For a non-unique match, use `findFirst()` followed by `create()` / `update()`.
- On the create branch, `@id` fields are generated (unless supplied) and `@default` values applied, exactly as `create()` does.
- `upsert` writes scalars only: relationship fields in `create` / `update` throw.

### Label Management

```typescript
// Set, add, or remove labels on existing nodes
await Book.setLabels({
  where: { id: 'book-1' },
  addLabels: ['Published', 'Featured'],
  removeLabels: ['Draft'],
});

// Query with additional runtime labels
const activeBooks = await Book.find({
  where: { title_CONTAINS: 'Graph' },
  labels: ['Active'],  // MATCH (n:`Book`:`Active`)
});
```

### Nested Mutations

Create, connect, disconnect, and cascade-delete related nodes in a single operation:

```typescript
await Book.create({
  input: [{
    title: 'Graph Databases',
    categories: {
      create: [{
        node: { name: 'Technology' },
        edge: { isPrimary: true },  // relationship properties
      }],
    },
    author: {
      connect: {
        where: { node: { name: 'Jim Webber' } },
        edge: { role: 'Primary Author' },
      },
    },
  }],
});
```

Nested writes inside `update` take one item per operation group:

```typescript
await Book.update({
  where: { id: 'book-1' },
  update: {
    categories: [
      {
        disconnect: [{}],                                         // drop all current categories…
        create: [{ node: { name: 'New' }, edge: { isPrimary: true } }], // …and link a new one
      },
    ],
  },
});
```

- **Order within an item** (as in `@neo4j/graphql`): `delete`, `disconnect`, `connect`, `create`, `update`. So `disconnect: [{}]` + `create` replaces the relationship set.
- **Nested connect / disconnect** recurse: `connect: { posts: [{ where, connect: { tags: [...] } }] }` links the post *and* its tags (max 5 levels).
- **Interface and union relationships** work for every nested op. Key the input by member type (`pets: { Dog: { create: [...] } }`), or use the flat shape and name the implementer on create (`create: [{ node: { Dog: { name: 'Rex' } } }]`).
- With [Node-Level Security](#node-level-security), every target applies its own policy: `read` to connect / disconnect, `create` (+ `WITH CHECK`) to nested creates, `update` to nested updates, `delete` to nested deletes.

---

## Strict mode

```typescript
const ogm = new OGM({ typeDefs, driver, logger, strict: true });
```

Some input shapes compile to something other than what they say. A typo'd connect key widens the connect to every node. A fulltext `score` inside `OR` is ignored. Fixing these in place would change results that existing code may rely on, so 2.x keeps the old behaviour by default and adds an opt-in switch:

- **`strict` off (the 2.x default).** Every input compiles exactly as in v2.5.4, byte for byte (the one exception is the aggregate fix at the end of this section). The first time an OGM instance sees one of the shapes below, it logs one `warn` through `logger`, naming the problem and ending in "Enable `strict: true` (default in 3.0) to …". Each warning is logged once per OGM instance and shape, so hot paths don't spam the log.
- **`strict: true`.** The corrected behaviour: the shape throws `OGMError` or compiles to what the input means. Strict mode never warns.
- **3.0** makes `strict: true` the default. Turn it on now in new code, and use the warnings to find the call sites to fix in existing code.

Generated types are the same in both modes.

#### 1. Unknown keys in connect / disconnect items

A key the item is not compiled from is ignored, so a typo leaves the item with no filter.

```typescript
await users.update({ where: { id }, connect: { pets: [{ wehre: { node: { id: petId } } }] } });
// default: links EVERY Pet (and warns) · strict: OGMError: Unknown key(s) "wehre" in a connect item on "pets"
```

Allowed keys: `where`, `edge`, `overwrite`, `connect` (connect) and `where`, `disconnect` (disconnect). Connect-all `[{}]` and the blanket disconnect `null` / `{}` are not affected.

#### 2. Unknown edge-property keys

```typescript
await users.update({ where: { id }, connect: { posts: [{ where: { node: { id: postId } }, edge: { rolee: 'author' } }] } });
// default: stores a stray `rolee` property on the relationship (and warns) · strict: OGMError: Unknown field "rolee" in the edge input …
```

Applies to `edge` on connect, nested create and nested update.

#### 3. `upsert` with more than one unique key in `where`

```typescript
await users.upsert({ where: { id: 'u2', email: 'a@x.com' }, create: {}, update: { name: 'A' } });
// default: MERGE on {id, email} misses the existing node with that email → duplicate (and warns)
// strict: OGMError: upsert "where" must name exactly one @id / @unique field
```

#### 4. Blanket disconnect on a shared relationship type

```graphql
type User @node {
  pets: [Pet!]! @relationship(type: "HAS", direction: OUT)
  toys: [Toy!]! @relationship(type: "HAS", direction: OUT)
}
```

```typescript
await users.update({ where: { id }, disconnect: { pets: null } });
// default: OPTIONAL MATCH (n)-[r:HAS]->()     — unlinks the toys too (warned once when the OGM is built)
// strict:  OPTIONAL MATCH (n)-[r:HAS]->(:Pet) — only the pets
```

Abstract targets are restricted to their members' labels.

#### 5. `labels` on `upsert` / `createMany({ skipDuplicates })`

```typescript
await users.upsert({ where: { email }, create: {}, update: {}, labels: ['Vip'] });
// default: SET n:Vip after the MERGE — an existing user it matched becomes Vip too (and warns)
// strict:  ON CREATE SET …, n:Vip    — only a newly created user gets the label
```

#### 6. Fulltext `score` inside `OR` / `AND` / `NOT`

```typescript
await books.find({ fulltext: { OR: [{ BookTitle: { phrase: 'dune', score: 2 } }, { BookBody: { phrase: 'dune' } }] } });
// default: the branch score is ignored (and warns) · strict: only BookTitle hits scoring ≥ 2 are kept from that branch
```

#### 7. `@include` / `@skip` in a `selectionSet`

```typescript
await books.find({ selectionSet: '{ id title @include(if: false) }' });
// default: title is returned anyway (and warns) · strict: title is omitted
```

Only a literal `if: true | false` is supported. `$variables` are still rejected.

#### 8. `mode: 'insensitive'` with `_IN` / `_NOT_IN`

```typescript
await books.find({ where: { mode: 'insensitive', title_IN: ['DUNE'] } });
// default: case-sensitive, misses "Dune" (and warns) · strict: toLower(n.title) IN [...lowered list], matches "Dune"
```

String fields only. Other fields compare as-is in both modes.

#### 9. The same response key with different arguments

```typescript
await books.find({ selectionSet: '{ reviews(where: { stars: 5 }) { id } reviews(where: { stars: 1 }) { body } }' });
// default: the first selection wins, the second is dropped (and warns)
// strict: OGMError: Fields "reviews" conflict because they have differing arguments. Use different aliases …
```

Only selections that can apply to the same object conflict. Fragments on types that can never be the same node, such as `... on Dog { pals(where: A) { id } } ... on Cat { pals(where: B) { id } }`, are valid GraphQL. They never warn. In strict mode each type gets its own arguments; by default the first selection is used for both, as in 2.5.x.

#### 10. Differently aliased `edges`, `node` or `properties` in one connection

```typescript
await books.find({ selectionSet: '{ reviewsConnection { a: edges { node { id } } b: edges { node { body } } } }' });
// default: only `a`, holding both selections merged (and warns) · strict: `a` and `b`, each with its own selection

await books.find({ selectionSet: '{ reviewsConnection { edges { a: node { id } b: node { body } } } }' });
// default: each edge has only `a: { id, body }` (and warns) · strict: `a: { id }` and `b: { body }`
```

`properties` keys inside one `edges` work the same way.

#### 11. Reads of an interface / union field whose relationship type another field shares

```graphql
type User @node {
  resources: [Resource!]! @relationship(type: "HAS", direction: OUT) # interface Resource = Doc | Image
  vaults: [Vault!]! @relationship(type: "HAS", direction: OUT)
}
```

```typescript
await users.find({ select: { resources: { select: { id: true } } } });
// default: [(n)-[:HAS]->(n0) | …]                          — the vaults too, with __typename null (warned once when the OGM is built)
// strict:  [(n)-[:HAS]->(n0) WHERE (n0:Doc OR n0:Image) | …] — only the members
```

Every read path is restricted (since 2.6.2): nested lists, connection `edges` and `totalCount`, `resources_SOME` / `_NONE` / `_ALL` / `_SINGLE`, connection filters, `resources: null`, `count` and `aggregate`. Writes were restricted in 2.5.1.

#### Not behind the switch: `aggregate` on list fields

`avg` / `sum` on an `[Int]` / `[Float]` field made the server reject the whole aggregate query. Since 2.6.0, in both modes, those keys come back `null` and the rest of the aggregate works: `{ scores: { min, max, average: null, sum: null } }`.

---

## Advanced Features

### Fulltext Search

Requires a `@fulltext` directive on the node type and the index to exist in Neo4j. Use `assertIndexesAndConstraints` to create indexes automatically:

```typescript
await ogm.assertIndexesAndConstraints({ options: { create: true } });

const Book = ogm.model('Book');

// Basic search
const results = await Book.find({
  fulltext: {
    BookSearch: { phrase: 'graph databases' },
  },
  select: { id: true, title: true },
});

// With score threshold
const highRelevance = await Book.find({
  fulltext: {
    BookSearch: { phrase: 'graph', score: 1.0 },
  },
});

// Combined with where filters
const affordable = await Book.find({
  fulltext: {
    BookSearch: { phrase: 'art' },
  },
  where: { price_LT: 10 },
});

// Logical composition
const results = await Book.find({
  fulltext: {
    OR: [
      { BookSearch: { phrase: 'graph' } },
      { BookSearch: { phrase: 'database' } },
    ],
  },
});
```

**Typed index names (v1.3.0+).** The generated `<Node>FulltextInput` type now carries the list of valid index names as literal-keyed optional fields. Typos surface as TypeScript errors and IDEs autocomplete the available indexes.

```typescript
// Before v1.3.0 — any string key compiled, typos only failed at runtime
await Book.find({ fulltext: { BokSearch: { phrase: 'graph' } } }); // silently accepted at type-check

// v1.3.0+ — `BokSearch` is a compile-time error; `BookSearch` autocompletes
await Book.find({ fulltext: { BookSearch: { phrase: 'graph' } } });
```

The runtime compiler is unchanged; this is a purely ergonomic type-level improvement. The global `FulltextInput`, `FulltextLeaf`, and `FulltextIndexEntry` exports remain for writing generic helpers across models.

**One index per leaf (v2.0.0+).** A fulltext leaf references exactly one index. To search several, compose them with `AND` / `OR` — which is what those operators are for:

```typescript
// ✅ correct — both indexes are searched
fulltext: {
  AND: [
    { BookSearch: { phrase: 'graph' } },
    { BlurbSearch: { phrase: 'neo4j' } },
  ],
}

// ❌ rejected — compile error, and throws at runtime
fulltext: {
  BookSearch: { phrase: 'graph' },
  BlurbSearch: { phrase: 'neo4j' },
}
```

Before v2.0.0 the second form compiled to a search of `BookSearch` **only**; `BlurbSearch` and its phrase were dropped with no error, so the query returned a strictly *wider* result set than intended. `AND` compiles to correlated subqueries, `OR` to a `UNION` with `max(score)` deduplication.

**One operator per object (v2.0.0+).** The same rule applies to `AND` / `OR` / `NOT` — they nest, they don't stack:

```typescript
// ✅ correct — nest to combine
fulltext: {
  AND: [
    { OR: [{ BookSearch: { phrase: 'graph' } }, { BookSearch: { phrase: 'db' } }] },
    { NOT: { BlurbSearch: { phrase: 'draft' } } },
  ],
}

// ❌ rejected — two operators in one object
fulltext: {
  OR: [{ BookSearch: { phrase: 'graph' } }],
  AND: [{ BlurbSearch: { phrase: 'neo4j' } }],
}
```

The compiler reads `OR`, then `AND`, then `NOT`, and stops at the first one it finds. Before v2.0.0 the rest were dropped silently — and because `AND` is checked before `NOT`, writing `{ NOT: …, AND: … }` compiled the `AND` alone and **discarded the exclusion entirely**. Mixing an operator with a bare index key (`{ OR: [...], BookSearch: {...} }`) is rejected at runtime; TypeScript can't express that one.

### Subgraph Operations

Clone or delete entire subgraphs using APOC procedures. Requires the APOC plugin installed in Neo4j.

The traversal starts at the root and follows `ownedRelationships` into nodes carrying one of `ownedLabels`. A bare type such as `'HAS_CHAPTER'` is followed **outgoing only**; write `'<CHILD_OF'` to follow a relationship incoming, or `'<LINKED>'` to follow it both ways. Before v2.5.0 a bare type was followed both ways, so deleting one book could climb from a chapter it shared with another book up to that book and delete it too; add `<…>` to keep the old behavior for a type.

The root is matched as `(:rootLabel {id: rootId})`, with `rootLabel` defaulting to the first entry of `ownedLabels` (v2.5.0; before, a node of any label with that id was a root). Set `rootLabel` when the root is not of that label — a delete whose root isn't found deletes nothing and returns `deletedCount: 0`. `cloneSubgraph` maps every owned node by its `id`, so it refuses, before cloning anything, a subgraph in which an owned node has no `id` or shares one with another owned node.

```typescript
import { cloneSubgraph, deleteSubgraph } from 'grafeo-ogm';

// Clone a subgraph rooted at a node
const cloneResult = await cloneSubgraph(
  'source-node-id',
  {
    ownedLabels: ['Book', 'Chapter', 'Section'],
    ownedRelationships: ['HAS_CHAPTER', 'HAS_SECTION'],
    maxLevel: 5,
    referenceRelationships: [
      { fromLabel: 'Book', relationshipType: 'WRITTEN_BY', direction: 'OUT' },
    ],
  },
  transaction,
);
// cloneResult: {
//   clonedRootId,
//   nodeMapping: Map<originalId, newId>,
//   nodesByLabel: Map<label, newId[]>,   // v1.13.0+ — multi-label nodes appear under each label
// }

// v1.13.0+ — post-process only the nodes of one label, no broad-IN filtering:
const chapterIds = cloneResult.nodesByLabel.get('Chapter') ?? [];

// Delete a subgraph rooted at a Chapter: its sections, not its Book
const deleteResult = await deleteSubgraph(
  'chapter-node-id',
  {
    rootLabel: 'Chapter', // v2.5.0+ — defaults to ownedLabels[0]
    ownedLabels: ['Chapter', 'Section'],
    ownedRelationships: ['HAS_SECTION'], // outgoing; '<TYPE' incoming, '<TYPE>' both
    maxLevel: 5,
    referenceRelationships: [],
  },
  transaction,
);
```

### Computed Fields with @cypher

The `@cypher` directive declares a field whose value is produced by a custom Cypher statement at query time. Scalar `@cypher` fields are resolved in three scopes — `select` / `selectionSet`, `where`, and `options.sort` — so you can project, filter, and order by them just like stored properties.

#### Declaration

```graphql
type Book @node {
  id: ID! @id
  title: String!
  published: DateTime

  # Computed: lowercased title for case-insensitive sort/filter
  insensitiveTitle: String @cypher(
    statement: "RETURN toLower(this.title) AS result"
    columnName: "result"
  )

  # Computed: count of related reviews
  reviewCount: Int @cypher(
    statement: "MATCH (this)-[:HAS_REVIEW]->(r) RETURN count(r) AS count"
    columnName: "count"
  )

  # Computed: average review rating (aggregating relationship-property data)
  averageRating: Float @cypher(
    statement: "MATCH (this)-[:HAS_REVIEW]->(r) RETURN avg(r.rating) AS avg"
    columnName: "avg"
  )
}
```

`statement` is the Cypher body — `this` is bound to the matched node. `columnName` is the alias the OGM reads from the `RETURN` clause; if omitted it defaults to the field name.

**Row semantics (v2.4.0+).** A `@cypher` field always resolves to **one value per node**, in every scope (select, where, sort, nested selections):

- If the statement returns **no rows**, the field is `null` and the node is still returned. A filter like `where: { status: null }` matches it, and it sorts as `null`.
- If the statement returns **several rows**, the field takes the **first** row's `columnName` value, and the node is returned once. Add an `ORDER BY` to the statement when it matters which row is first.

Before v2.4.0, top-level fields dropped nodes whose statement returned no rows and duplicated nodes whose statement returned several. See the [2.4.0 changelog](CHANGELOG.md).

> **Security — `@cypher` SDL is trusted code, not data.** The `statement` argument is interpolated **verbatim** into the compiled Cypher (no parameterisation, no escaping). Treat `@cypher` directives the same way you treat `eval()` in your application code: the string MUST be a constant authored at development time, never built from runtime input. If your `typeDefs` are ever assembled from user input, environment variables, database records, or remote configuration, you have a Cypher-injection vector equivalent to RCE on the database (`MATCH (n) DETACH DELETE n RETURN '' AS x` in a `statement` will wipe the graph). The grafeo-ogm runtime cannot distinguish between developer-authored and user-derived SDL — that boundary is the application's responsibility.

#### Using @cypher in SELECT

```typescript
const books = await Book.find({
  select: {
    id: true,
    title: true,
    insensitiveTitle: true,
    reviewCount: true,
    averageRating: true,
  },
});

// Or via the legacy selectionSet API:
const books = await Book.find({
  selectionSet: '{ id title insensitiveTitle reviewCount averageRating }',
});
```

#### Using @cypher in WHERE

```typescript
// Case-insensitive prefix match
await Book.find({
  where: { insensitiveTitle_STARTS_WITH: 'the' },
});

// Combined with stored fields under AND/OR
await Book.find({
  where: {
    AND: [
      { insensitiveTitle_CONTAINS: 'graph' },
      { reviewCount_GT: 5 },
    ],
  },
});

// Nested inside a relationship quantifier
// Find authors who have at least one book with more than 5 reviews
await Author.find({
  where: { books_SOME: { reviewCount_GT: 5 } },
});
```

All standard operator suffixes are supported (`_EQ`, `_NOT`, `_IN`, `_NOT_IN`, `_LT`, `_LTE`, `_GT`, `_GTE`, `_CONTAINS`, `_NOT_CONTAINS`, `_STARTS_WITH`, `_ENDS_WITH`, `_MATCHES`).

#### Using @cypher in ORDER BY

```typescript
await Book.find({
  where: { insensitiveTitle_STARTS_WITH: 'g' },
  options: { sort: [{ insensitiveTitle: 'ASC' }] },
  select: { id: true, title: true, reviewCount: true },
});
```

#### Limitations

`@cypher` fields work at the top level and through relationships — nested selections (`select: { author: { select: { upper: true } } }`) and connection filters (`authorsConnection_SOME: { node: { upper: 'ANN' } }`) included. Two positions throw `OGMError` at compile time with a clear hint, rather than silently misbehaving:

- **An aggregating statement selected through a relationship** — e.g. `postCount: … RETURN count(p) AS postCount` in `{ author { postCount } }`. Nested fields are projected inline (`head(COLLECT { … })`), and Neo4j 5 rejects aggregation there. Select it at the top level (`Author.find({ select: { postCount: true } })`), where it is computed in a `CALL` subquery and works.
- **`_SINGLE` / `Connection_SINGLE` on a `@cypher` field.** Workaround: combine `_SOME` and `_NONE` to express "exactly one match."

These are Cypher-language constraints, not OGM bugs: a pattern comprehension cannot host a `CALL` subquery, and aggregation is not allowed inside one.

#### Performance

Each scope (`where`, `select`, sort) emits its own `CALL { WITH n; WITH n AS this; <statement> }` block per `@cypher` field reference. A query that references the same `@cypher` field in all three scopes emits three `CALL` blocks. This is functionally correct and parameter-isolated, but worth knowing if your statement is expensive (multi-hop traversals, aggregations over large fan-outs). For frequently-accessed computed values, consider materializing as a stored property updated on write instead.

### Node-Level Security

Node-Level Security (NLS) is a per-request filter layer that compiles into the existing WHERE pipeline. It is opt-in: an OGM constructed without the `policies` option emits byte-identical Cypher to a no-policy OGM. Policies return `<Node>Where` partials, so every operator, quantifier, connection filter, and nested traversal already supported by `WhereCompiler` is automatically available inside policies — no new DSL.

#### Declaration

```typescript
import { OGM, override, permissive, restrictive } from 'grafeo-ogm';

interface RequestCtx {
  userId: string;
  capabilities: string[];
  tierIds: string[];
}

const ogm = new OGM<ModelMap>({
  typeDefs,
  driver,
  policies: {
    Book: [
      // Compile-time short-circuit. When `when(ctx)` returns true, ALL
      // other policies for `Book.read` are dropped — query is byte-
      // identical to a no-policy query. Zero runtime cost for admins.
      override({
        operations: ['*'],
        when: (c: RequestCtx) => c.capabilities.includes('admin'),
        name: 'admin-bypass',
      }),

      // OR-grant. Multiple permissives compose with OR — any match grants.
      permissive({
        operations: ['read'],
        when: (c: RequestCtx) => ({ ownerId: c.userId }),
        name: 'owner-can-read',
      }),

      // Read-side restrictive — AND-row predicate. Compiles into the
      // WHERE clause and applies to read|delete|aggregate|count.
      // `when` receives only `ctx` and returns a where-partial (or
      // `false` for a hard deny).
      restrictive({
        operations: ['read'],
        when: (c: RequestCtx) => ({ tierIds_IN: c.tierIds }),
        name: 'tier-isolation',
      }),

      // Write-side restrictive — Postgres `WITH CHECK` semantics. Runs
      // at the application layer for create|update only; receives both
      // `ctx` and the user-submitted `input`. MUST return a boolean.
      // The OGM rejects mixed read+write `operations` arrays — split a
      // single restrictive into two if you need both read- and write-
      // side coverage.
      restrictive({
        operations: ['create', 'update'],
        when: (c, input) =>
          (input as { ownerId?: string }).ownerId === c.userId,
        name: 'cannot-set-other-owner',
      }),
    ],
  },
  policyDefaults: {
    onDeny: 'empty', // Or 'throw' — raises PolicyDeniedError pre-compile.
    auditMetadata: true,
  },
});

// Per request:
const Books = ogm.withContext({ userId, capabilities, tierIds }).model('Book');
const visible = await Books.find({ where: { published_GT: '2024-01-01' } });
```

The Cypher emitted for the call above is roughly:

```cypher
MATCH (n:`Book`)
WHERE (n.`published` > $param0) AND ((n.`ownerId` = $param1) AND n.`tierIds` IN $param2)
RETURN n { .id, .title, .ownerId, .tierIds, ... }
```

#### Hierarchical ACL example

Combine permissives to express "owner OR member of an allowed tier":

```typescript
policies: {
  Book: [
    permissive({
      operations: ['read'],
      when: (c) => ({ ownerId: c.userId }),
      name: 'owner-can-read',
    }),
    permissive({
      operations: ['read'],
      // Returns a where-partial that uses the existing _SOME quantifier.
      when: (c) => ({ tiers_SOME: { id_IN: c.tierIds } }),
      name: 'tier-can-read',
    }),
  ],
}
```

Both permissives OR together — a row passes if either branch matches.

#### Interface inheritance

Policies on an interface AND with policies on every implementing concrete type. Concrete types can only narrow restrictives, never broaden — predictable. `OR` composition for permissives lets concrete types add allow paths their interface didn't anticipate.

```typescript
policies: {
  Resource: [
    // Tenant isolation applies to every type that implements Resource.
    restrictive({ operations: ['read'], when: (c) => ({ tenantId: c.tenantId }) }),
  ],
  Book: [
    // Additional grant only for Book — composed via OR with any
    // Resource-level permissives.
    permissive({ operations: ['read'], when: (c) => ({ authorId: c.userId }) }),
  ],
}
```

#### Relationships and nested writes

Policies protect a **type**, wherever it is reached from. When a bound model reaches another type through a relationship, that type's own policies apply, whether or not the root type has any.

Reads:
- **Nested selection**: related nodes are filtered by their type's `read` policy.
- **Relationship filters** (`_SOME`, `_NONE`, `_ALL`, `_SINGLE`, `…Connection`): these range over the related nodes the caller may see. At any depth, a hidden node neither satisfies nor falsifies the quantifier.
- **Interface and union targets**: each related node is checked against the policy of its concrete type (`CASE WHEN n:Chart THEN <Chart policy> WHEN n:Drug THEN <Drug policy> … ELSE false END`).

Writes follow one principle: **a nested write enforces exactly what the equivalent direct write on the target type would.**

| Nested operation | Target-type policy applied |
|---|---|
| `connect` / `disconnect` (in `create` or `update`) | `read`: only visible nodes can be linked or unlinked |
| nested `update` | `update` row filter, plus its write restrictives (`WITH CHECK`) on the nested input |
| nested `create` (in `create` or `update`) | `create`: at least one permissive must apply, plus its write restrictives on the nested input |
| `delete` inside `update`, cascade `delete` | `delete` row filter |

Write restrictives and create default-deny are checked before the query runs, so a rejected nested write throws `PolicyDeniedError` and nothing is written.

**Mutation responses are reads.** The nodes that `create`, `update` and `upsert` return are filtered by the root type's `read` policy, checked against the node as it is after the write, just as `find` would filter them. A write to a node the context may update or create but not read still happens, but that node is left out of the response: it is missing from the `<plural>` array, and `upsert` returns `null`. The `info` counters still count it. Nested selections in the response were already filtered by their own target-type policies. Before v2.6.1 the root node came back in full, including fields its `read` policy hides.

> **A type without policies is open, but not a gateway.** Before v2.3.0, reading or writing through a type with no policies of its own skipped the policies of the types beyond it, and nested writes enforced no target-type policy at all. If a nested write into a protected type now gets filtered or denied, add the matching policy for that operation on the target type, or perform the write directly on its model.

#### Enforcement boundary

> **The OGM enforces policies at the compiler.** Policies do NOT apply to `ogm.$queryRaw`, `ogm.$executeRaw`, or to `@cypher` directive bodies that traverse from a stored field. If you need raw-Cypher enforcement, write the predicate into your raw Cypher manually or layer a Neo4j role/RBAC at the database.

#### Escape hatches

```typescript
// Disable policies for a single call. Logged via logger.warn.
await Books.find({ where: { id: 'b1' }, unsafe: { bypassPolicies: true } });

// Disable policies for a derived OGM (data migrations, admin scripts).
const adminOgm = ogm.unsafe.bypassPolicies();
```

Both paths emit byte-identical Cypher to a no-policy OGM.

#### Audit metadata

When `policies` is configured, every OGM-emitted query attaches transaction metadata:

```typescript
{
  ogmPolicySetVersion: '1.7.0',
  ctxFingerprint: '<sha256 of sorted ctx KEYS — never values>',
  modelType: 'Book',
  operation: 'read',
  policiesEvaluated: ['owner-can-read', 'tier-isolation'],
  bypassed: false,
}
```

Disable via `policyDefaults: { auditMetadata: false }`. The fingerprint is intentionally key-only — no ctx values are leaked.

> **Inside a transaction the per-call audit metadata does not reach the server.** neo4j-driver accepts transaction metadata only when a transaction begins, so it is attached on the OGM's own auto-commit sessions and on a caller-supplied `session`, but not to a call that runs in an already-open transaction (`$transaction`, an explicit `beginTransaction()` tx, or an `executeRead`/`executeWrite` managed tx). Since v2.4.8 each such call logs a `warn` instead of dropping the metadata silently; before v2.4.8 the docs claimed it was forwarded. To tag the transaction itself, pass metadata when it opens: `ogm.$transaction(fn, { metadata })`, `session.beginTransaction({ metadata })`, or `session.executeWrite(fn, { metadata })`.

`policiesEvaluated` lists only the policies that **applied** to the query. A restrictive whose `appliesWhen(ctx)` returned `false` is omitted (before v2.2.0 it was listed even though it contributed nothing). `explainPolicies` calls add `explain: true` and are always recorded, even with `auditMetadata: false`.

#### Explaining policy decisions

When a policy-bound read hides a node, `find` can only show *that* the node disappeared. `explainPolicies` shows *which* named clause decided it. It evaluates every `read` policy for the type separately, for each candidate node, without short-circuiting. Both `when:` and `cypher:` clauses are covered, and nodes the policies reject are returned too.

```typescript
const report = await ogm
  .withContext(ctx)
  .model('Chart')
  .explainPolicies({ where: { id_IN: candidateIds }, select: { id: true } });

// [{
//   node: { id: 'chart-8617' },
//   visible: false,                        // exactly what `find` would enforce
//   overriddenBy: null,
//   permissiveGranted: true,
//   failedRestrictives: ['chart.dose-translation-coverage'],
//   policies: [
//     { name: 'chart.read-grant', kind: 'permissive', source: 'Chart', applied: true, outcome: 'pass' },
//     { name: 'chart.weight-zone', kind: 'restrictive', source: 'Chart', applied: true, outcome: 'pass' },
//     { name: 'chart.text-field-scope', kind: 'restrictive', source: 'Chart', applied: false, outcome: 'not-applied' },
//     { name: 'chart.dose-translation-coverage', kind: 'restrictive', source: 'Chart', applied: true, outcome: 'fail' },
//   ],
// }]
```

| `outcome` | Meaning |
|---|---|
| `pass` | Applied, and its predicate evaluated to `true`. |
| `fail` | Applied, and it evaluated to `false`. This includes a restrictive hard deny (`when: () => false`). |
| `null` | Applied, and it evaluated to NULL (for example, a missing property). Enforcement treats NULL as not-true. It is reported separately from `fail` because the fix is different. |
| `abstain` | Applied, but it emitted no predicate. A permissive abstain grants nothing; a restrictive abstain restricts nothing. |
| `not-applied` | `appliesWhen(ctx)` returned `false` (for an override: `when(ctx)` returned `false`). The policy was not evaluated. |
| `skipped` | Not evaluated, because an earlier override fired. |

How it works:

- **Same predicates as `find`.** The explain query projects the exact compiled fragments `find` would enforce. `visible` is computed from the same composed predicate `find` puts in its `WHERE`. The verdict recomputed from the per-policy outcomes must agree with it; if it ever doesn't, the call throws instead of returning a wrong explanation.
- **Candidate selection.** `where` and `labels` select candidates exactly as in `find`, including target-type policies on relationship filters. The root type's policy clause is reported, not used as a filter. Candidates that don't match `where` are simply absent from the result.
- **Selection.** `select` / `selectionSet` accept everything `find` accepts. Relationships in the selection are still filtered by their own target-type policies. Only the root type's policies are explained.
- **Read-only.** When grafeo opens the session itself, it opens it in `READ` access mode, so the server rejects any write. If you pass your own `transaction` or `session`, it is used as-is, and you control its access mode.
- **Bounded.** `options.limit` defaults to 100, and values above 1,000 are rejected. Each candidate evaluates every policy, and the enforcement predicate is evaluated a second time for the cross-check, so explain costs more than a normal read. `sort` and `offset` are supported.
- **Unnamed policies** are reported as `<source>.<kind>[<index>]` with `named: false`. Give every policy a `name` if you want stable, readable output.
- **Default deny is reported, not thrown.** With `onDeny: 'throw'`, `explainPolicies` still returns rows with `visible: false` and `permissiveGranted: false`.

> **Security: `explainPolicies` bypasses policy filtering by design.** It returns nodes the bound context cannot see, together with their selected fields. Expose it only on admin-only diagnostic paths, and never let request input decide whether it runs. Every call logs a `warn` and is tagged `explain: true` in the transaction metadata. It is only available on policy-bound models (`ogm.withContext(ctx).model(...)`) and throws on a model with no policy binding or on a policy-bypassed OGM. In this release it covers `Model` and the `read` operation only: `InterfaceModel`, `count`, `aggregate`, and `delete` are not supported yet.

#### Limitations

- **`@cypher` scalar fields inside a policy `where`-partial throw when the policy is injected into nested-selection enforcement.** Refactor the policy to use stored properties or a relationship traversal.
- **`upsert`** enforces exactly what the equivalent direct calls would. When no node matches the `where`, it creates one under the `create` policy (default-deny and `WITH CHECK`). When a node matches, the type's `update` row filter applies to it, the same clause a direct `update` puts in its `WHERE`: the node is updated only if it passes, and if it fails nothing is written and `upsert` returns `null`, just as a direct `update` matches 0 rows. The update input is also checked against the update `WITH CHECK`. As with `update`, the matched node does not have to be readable. With `skipDuplicates`, `createMany` adds default-mode `labels` to an existing node it matches only if that node passes the `update` row filter. Before v2.6.1 only the `WITH CHECK` ran, so `upsert` could rewrite any existing node, including the owner field the update policy keys on.
- **Restrictives are split into read-side and write-side flavors.** A restrictive's `operations` array determines which `when` signature applies. Read-side ops (`read|delete|aggregate|count`) → `when(ctx)` returns a where-partial or boolean. Write-side ops (`create|update`) → `when(ctx, input)` returns a boolean only. Mixed arrays (e.g. `['read', 'create']`) are rejected at construction time — split into two restrictives. Each flavor is invoked exactly once per query (read-side at compile, write-side at the application layer). Use `isReadRestrictive` / `isWriteRestrictive` if you need to inspect a policy at runtime.
- **InterfaceModel branches.** Each implementer's `CASE` branch is exactly the policy clause that implementer's own model enforces, including the interface-level policies it inherits. An implementer with no policies of its own therefore gets only the interface-level ones. The OGM emits a `logger.warn` at construction time when an interface has policies and one of its implementers does not. Silence it by registering an explicit policy on each implementer.
- **`edge` filters in nested-write `where`** (connect, disconnect, nested update and delete) are not supported and throw.
- **`@cypher` fields in the policies of more than one member of an interface or union** cannot be combined in one query and throw. Refactor all but one to stored properties.
- **No AsyncLocalStorage integration.** Context is supplied via explicit `withContext()` only — create one wrapper per request, discard after.

### Raw Cypher

```typescript
// Read query
const results = await ogm.$queryRaw<{ name: string; count: number }>(
  'MATCH (a:Author)-[:WRITTEN_BY]-(b:Book) RETURN a.name AS name, count(b) AS count',
);

// Write operation
const { recordsAffected } = await ogm.$executeRaw(
  'MATCH (b:Book) WHERE b.published < $cutoff DELETE b',
  { cutoff: '2020-01-01' },
);
```

### Transactions

```typescript
// Callback style — interactive transaction
await ogm.$transaction(async (ctx) => {
  await Book.create({ input: [{ title: 'Book A' }], context: ctx });
  await Book.update({
    where: { id: 'book-1' },
    update: { title: 'Updated' },
    context: ctx,
  });
  // Committed on success, rolled back on error
});

// Sequential style — array of operations
const [books, authors] = await ogm.$transaction([
  (ctx) => Book.find({ select: { id: true }, context: ctx }),
  (ctx) => Author.find({ select: { id: true }, context: ctx }),
]);

// Transaction metadata (v2.4.8) — sent to the server when the tx begins,
// visible in SHOW TRANSACTIONS and the query log
await ogm.$transaction(
  async (ctx) => {
    /* ... */
  },
  { metadata: { job: 'nightly-import' } },
);
```

Per-call policy audit metadata cannot be attached once a transaction is open; see [Audit metadata](#audit-metadata).

### Interface Models

Query across all types implementing a shared interface:

```typescript
const Entity = ogm.interfaceModel('Entity');

// Returns both Users and Organizations with __typename
const entities = await Entity.find({
  where: { name_CONTAINS: 'Acme' },
  selectionSet: `{ id name }`,
});
// [{ id: '1', name: 'Acme Corp', __typename: 'Organization' }, ...]

// Count across all implementing types
const total = await Entity.count();

// Aggregate across all implementing types
const agg = await Entity.aggregate({
  aggregate: { count: true },
});
```

Interface models are **read-only**. Use `ogm.model('User')` or `ogm.model('Organization')` for mutations.

Since v2.5.0 they match nodes by their implementors' labels (`MATCH (n:(User|Organization))`), so nodes written with `ogm.model('User').create(...)` are found without carrying an `Entity` label. Each implementor's own read policy applies to its rows.

### Aggregation

```typescript
const Book = ogm.model('Book');

// Simple count
const total = await Book.count();
const published = await Book.count({ where: { status: 'PUBLISHED' } });

// Field aggregation (min, max, average)
const priceStats = await Book.aggregate({
  aggregate: { count: true, price: true },
});
// { count: 42, price: { min: 9.99, max: 59.99, average: 24.50 } }

// With where filter
const publishedStats = await Book.aggregate({
  where: { status: 'PUBLISHED' },
  aggregate: { count: true, price: true },
});
```

---

## Vector Search

grafeo-ogm supports Neo4j's native vector indexes via the `@vector` directive. The directive lives on `@node` types, mirrors the official `@neo4j/graphql` spec shape, and enables two typed query methods on the generated model: `searchByVector` (pass a pre-computed embedding) and `searchByPhrase` (encode text server-side via the Neo4j GenAI plugin). Results are returned as `Array<{ node, score }>`.

### Schema

Declare one or more vector indexes on a node type. Set `provider` only on indexes that should support phrase search; plain vector search is always available.

```graphql
type Article @node @vector(indexes: [
  {
    indexName: "article_content_idx"
    queryName: "similarArticles"
    embeddingProperty: "embedding"
    provider: "OpenAI"
  },
  {
    indexName: "article_title_idx"
    queryName: "similarTitles"
    embeddingProperty: "titleEmbedding"
    # no provider — only searchByVector is available for this index
  }
]) {
  id: ID! @id
  title: String!
  content: String!
  embedding: [Float!]!
  titleEmbedding: [Float!]!
  published: Boolean!
}
```

### Creating the index in Neo4j

The `grafeo db push` CLI creates `@vector` indexes for you — the directive carries no dimensions, so supply them in your config's `vectorIndexes` map (keyed by index name) and `db push` issues the `CREATE VECTOR INDEX`. See the [CLI → `grafeo db push`](#grafeo-db-push) section. The runtime `assertIndexesAndConstraints()` does **not** create vector indexes (only fulltext indexes and unique constraints).

You can also run the Cypher yourself as part of a migration:

```cypher
CREATE VECTOR INDEX article_content_idx FOR (n:Article) ON n.embedding
OPTIONS { indexConfig: { 'vector.dimensions': 1536, 'vector.similarity_function': 'cosine' } }
```

### `searchByVector` — top-k similarity with a pre-computed embedding

Use this when you already have an embedding vector (for example, computed via an external SDK in your application code). `k` is clamped to the range `[1, 1000]`.

```typescript
const Article = ogm.model('Article');

const vector = await myEmbedder.embed('distributed consensus algorithms');

const results = await Article.searchByVector({
  indexName: 'article_content_idx',
  vector,
  k: 10,
  where: { published: true },
  select: { id: true, title: true },
});
// results: Array<{ node: { id: string, title: string }, score: number }>
```

Compiles to:

```cypher
CALL db.index.vector.queryNodes($v_name, $v_k, $v_vector) YIELD node AS n, score
WHERE n.published = $param0
RETURN n { .id, .title } AS n, score
```

### `searchByPhrase` — server-side encoding via Neo4j GenAI

Use this when you want Neo4j to encode the phrase for you. This requires two things:

1. The index's `@vector` entry has a `provider` set (e.g. `"OpenAI"`, `"AzureOpenAI"`, `"VertexAI"` — whatever the GenAI plugin accepts).
2. The **Neo4j GenAI plugin** is installed on the database.

API credentials never appear in the schema. Pass them at query time via `providerConfig`:

```typescript
const results = await Article.searchByPhrase({
  indexName: 'article_content_idx',
  phrase: 'distributed consensus algorithms',
  k: 10,
  providerConfig: { token: process.env.OPENAI_API_KEY },
  where: { published: true },
  select: { id: true, title: true },
});
// results: Array<{ node: { id: string, title: string }, score: number }>
```

Compiles to:

```cypher
CALL genai.vector.encode($v_phrase, $v_provider, $v_providerConfig) YIELD vector AS __v_encoded
CALL db.index.vector.queryNodes($v_name, $v_k, __v_encoded) YIELD node AS n, score
WHERE n.published = $param0
RETURN n { .id, .title } AS n, score
```

Calling `searchByPhrase` on an index that does not have `provider` set throws at compile time with a descriptive error.

### Generated types

For the `Article` schema above, `generateTypes` emits typed helpers with literal-string index names:

```typescript
export type ArticleVectorResult = { node: Article; score: number };

export type ArticleVectorSearchByVectorInput = {
  indexName: 'article_content_idx' | 'article_title_idx';
  vector: number[];
  k: number;
  where?: ArticleWhere;
  selectionSet?: string;
  labels?: string[];
};

export type ArticleVectorSearchByPhraseInput = {
  indexName: 'article_content_idx'; // only indexes with provider set
  phrase: string;
  k: number;
  providerConfig?: Record<string, unknown>;
  where?: ArticleWhere;
  selectionSet?: string;
  labels?: string[];
};
```

`ArticleVectorSearchByPhraseInput` is only emitted when at least one `@vector` index declares `provider`. Index-name typos surface as TypeScript errors.

### Not supported (deferred)

The following were intentionally left out of this release:

- **`@embedded(from:, using:)` auto-write directive** — automatic embedding on create / update. Requires a pluggable embedder port and peer-dependency adapters.
- **Third-party embedder SDKs** (`grafeo-ogm/embedders/openai`, etc.) — tracked for a future release with optional peer dependencies.
- **Relationship-level `@vector` indexes** — the current Neo4j / official spec only supports node vector indexes.
- **Vector index creation via the runtime `assertIndexesAndConstraints`** — that method covers fulltext indexes and unique constraints only. Create vector indexes with the `grafeo db push` CLI (see [CLI](#cli)) or run `CREATE VECTOR INDEX` yourself.

---

## Type Generation

Generate TypeScript types from your schema for compile-time safety. **No Neo4j driver connection needed at build time.**

### Usage

```typescript
import { generateTypes } from 'grafeo-ogm';
import fs from 'fs';

const result = await generateTypes({
  typeDefs: fs.readFileSync('./schema.graphql', 'utf-8'),
  outFile: './src/generated/ogm-types.ts',
});

console.log(`Generated ${result.typeCount} types in ${result.durationMs}ms`);
```

### Using Generated Types

```typescript
import { OGM } from 'grafeo-ogm';
import type { ModelMap } from './generated/ogm-types';

const ogm = new OGM<ModelMap>({ typeDefs, driver });

// ogm.model('Book') is now fully typed:
const Book = ogm.model('Book');

// Book.find() returns typed Book objects
// Book.create() accepts typed BookCreateInput
// Book.find({ where: ... }) validates BookWhere
// Book.find({ select: ... }) validates BookSelectFields
```

### Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `typeDefs` | `string` | *(required)* | Raw GraphQL schema string |
| `outFile` | `string` | *(required)* | Output file path |
| `config.packageName` | `string` | `'grafeo-ogm'` | Package name in generated import statements |
| `config.stringMatchesFilter` | `boolean` | `true` | Enable `_MATCHES` regex operator in where types |
| `config.formatOutput` | `boolean` | `true` | Format output with Prettier |
| `config.prettierConfig` | `object` | `undefined` | Custom Prettier configuration |
| `config.header` | `string` | `undefined` | Custom header comment prepended to the file |

### Custom Package Name

If you install grafeo-ogm under an npm alias:

```typescript
await generateTypes({
  typeDefs,
  outFile: './src/generated/ogm-types.ts',
  config: { packageName: '@myorg/ogm' },
});
```

### What Gets Generated

The generator runs 16 specialized emitters to produce:

- **Node types** -- TypeScript interfaces for each `@node` type (e.g., `Book`, `Author`)
- **Where types** -- All operator suffixes per field (e.g., `BookWhere` with `title_CONTAINS`, `id_IN`)
- **CreateInput / UpdateInput** -- Typed mutation inputs with nested relationship operations
- **ConnectInput / DisconnectInput** -- Relationship operation inputs
- **SelectFields** -- Types for the programmatic `select: {}` API
- **SelectResult** -- Return types narrowed by selection
- **ConnectionWhere** -- Edge property filtering types
- **SortInput** -- Sort options with direction constraints
- **AggregateSelection** -- Aggregation return types
- **MutationResponse** -- Typed mutation return shapes
- **FulltextInput** -- Fulltext search input types
- **ModelMap / InterfaceModelMap** -- Generic maps for `ogm.model()` and `ogm.interfaceModel()`

---

## Testing Utilities

Import from `grafeo-ogm/testing`:

```typescript
import {
  CypherAssert,
  Neo4jRecordFactory,
  SelectionSetFactory,
} from 'grafeo-ogm/testing';
```

### CypherAssert

Assert on compiled Cypher and its parameters:

```typescript
// Equal after collapsing whitespace and renaming params to $p0, $p1, …
CypherAssert.assertStructurallyEqual(cypher, 'MATCH (n:`Book`) RETURN n');

// A clause is present and contains a fragment
CypherAssert.assertContainsClause(cypher, 'WHERE', 'n.price');

// A fragment is absent
CypherAssert.assertNotContainsClause(cypher, 'DELETE');

// Only the listed keys are checked. Object key order doesn't matter;
// bigints compare by value, and a neo4j Integer never equals a plain number.
CypherAssert.assertParams(params, { param0: 'Graph Databases' });
```

### Neo4jRecordFactory

Build mock Neo4j values for unit tests without a running database:

```typescript
const record = Neo4jRecordFactory.create({ title: 'Test Book', count: 2 });
const count = Neo4jRecordFactory.integer(42);

// Same fields and toString() as the driver's datetime($iso): the offset,
// all nine fractional digits and an [Area/City] zone id are kept (v2.4.8).
const dt = Neo4jRecordFactory.dateTime('2024-01-01T10:00:00.123456789+02:00');

// Properties are stored as given; use integer() where the driver would
// return an Integer. The third argument (v2.4.8) sets identity / elementId.
const node = Neo4jRecordFactory.node(
  ['Book'],
  { title: 'Mock', pages: Neo4jRecordFactory.integer(300) },
  { identity: 1, elementId: '4:test:1' },
);
```

### SelectionSetFactory

Build selection sets programmatically:

```typescript
SelectionSetFactory.gql(['id', 'title', { author: ['name'] }]);
// => '{ id title author { name } }'

SelectionSetFactory.select(['id', 'title', { author: ['name'] }]);
// => { id: true, title: true, author: { select: { name: true } } }
```

---

## Security

grafeo-ogm implements 7 layered security controls. Every user-provided value passes through validation before it reaches the Cypher string.

### 1. Parameterization

All user values become `$paramN` references. No value is ever string-interpolated into Cypher:

```typescript
// Input:  { name: "'; DROP DATABASE neo4j; //" }
// Cypher: n.name = $param0
// Params: { param0: "'; DROP DATABASE neo4j; //" }
```

### 2. Identifier Validation

Field names, sort fields, and aggregate fields are validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/`. Any identifier containing special characters is rejected before query compilation.

### 3. Label Validation

Labels used in `MATCH`, `SET`, and `REMOVE` are validated with the same regex, preventing label injection attacks.

### 4. Prototype Pollution Prevention

Keys `__proto__`, `constructor`, and `prototype` are blocked in all `where` and `update` inputs. The ResultMapper uses `Object.create(null)` for all output objects to prevent prototype chain attacks.

### 5. Lucene Escaping

Special Lucene characters (`+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /`) are escaped before being passed to fulltext queries.

### 6. Depth Limiting

- WhereCompiler: max recursion depth of 10
- SelectionCompiler: configurable max relationship traversal depth (default 5)

Prevents denial-of-service via deeply nested or circular inputs.

### 7. Sort Direction Validation

Sort directions are strictly validated as `"ASC"` or `"DESC"`. Any other value -- including injected Cypher fragments -- is rejected.

### Best Practices

- Always use the OGM's query methods instead of raw Cypher when possible
- Use `generateTypes()` for compile-time validation of inputs
- Set appropriate depth limits for your schema's relationship density
- Use `$transaction()` for multi-step operations to maintain consistency
- Keep `@unique` constraints on fields used for `findUnique` lookups

---

## Migration from @neo4j/graphql-ogm

grafeo-ogm is a **drop-in replacement** for the deprecated `@neo4j/graphql-ogm`. Existing code works without changes, and you can adopt new features incrementally.

### Step 1: Replace the dependency

```bash
npm uninstall @neo4j/graphql-ogm
npm install grafeo-ogm
```

### Step 2: Update imports

```typescript
// Before
import { OGM } from '@neo4j/graphql-ogm';

// After
import { OGM } from 'grafeo-ogm';
```

### Step 3: Update type generation

Replace your existing type generation script to use `generateTypes()` from grafeo-ogm. No Neo4j driver connection is needed at build time.

### Step 4 (optional): Adopt new features

These are incremental improvements you can adopt at your own pace:

| Old Pattern | New Alternative | Benefit |
|---|---|---|
| `selectionSet` strings | `select: { field: true }` | Compile-time type checking |
| `find()` + manual null check | `findFirstOrThrow()` | Throws `RecordNotFoundError` automatically |
| `find({ where, options: { limit: 1 } })` | `findFirst({ where })` | Cleaner API, returns `T \| null` |
| Manual bulk loops | `createMany()`, `updateMany()`, `deleteMany()` | Single query, returns `{ count }` |
| Manual label management | `setLabels()`, `labels` parameter | Built-in label add/remove/filter |

### What's the Same

- `OGM` constructor signature: `{ typeDefs, driver }` -- identical
- `ogm.model('Name')` -- same API
- `model.find()`, `model.create()`, `model.update()`, `model.delete()` -- same signatures
- `selectionSet` -- fully supported
- `init()` -- still works (now a no-op since schema parsing is synchronous)
- `assertIndexesAndConstraints()` -- same behavior

### What Changed (Under the Hood)

- Queries use **pattern comprehensions** instead of `OPTIONAL MATCH` -- better performance, same results
- Mutations use **CALL subquery isolation** -- prevents Cartesian products in connect/disconnect
- All identifiers are **validated and escaped** -- injection-safe by default
- Type generation is **modular and driver-free** -- smaller output, faster builds

### Deliberate divergence: `OR: []` matches nothing

This is the **one intentional behavioral difference** from `@neo4j/graphql-ogm`. The deprecated OGM silently dropped empty `OR` arrays from the WHERE clause, so `delete({ where: { OR: [] } })` compiled to an *unfiltered* `MATCH ... DETACH DELETE` — a full-label wipe. The realistic trigger is a dynamically built filter (`OR: ids.map((id) => ({ id }))`) receiving an empty list.

grafeo-ogm follows **Prisma semantics** instead: an `OR` with zero effective disjuncts compiles to `false` and matches **nothing** — at the top level, inside relationship quantifiers (`_SOME`/`_NONE`/...), in connection filters, and in nested `connect`/`disconnect` operations. `AND: []` still matches everything (the empty conjunction is true, also per Prisma). If you relied on `OR: []` behaving as "no filter", pass no `where` (or omit the `OR` key) instead.

When this happens at runtime, the compiler emits a `warn` through your configured `OGMConfig.logger`, so an accidentally empty filter shows up in your logs instead of failing silently.

---

## Comparisons

### grafeo-ogm vs. raw `neo4j-driver`

If you're writing Cypher strings by hand and concatenating user input, you have two problems: every query is unvalidated against your schema, and every query is a potential injection vector. grafeo-ogm gives you typed CRUD on top of the same driver — your existing `Driver` instance is what you pass to `new OGM(config)`. Raw Cypher is still available via `ogm.$queryRaw(...)` when you need it.

### grafeo-ogm vs. `@neo4j/graphql-ogm` (deprecated)

grafeo-ogm is a drop-in replacement: same constructor shape, same `model().find()` API, same selection set strings. The compiler under the hood is rewritten to use pattern comprehensions instead of `OPTIONAL MATCH` chains (eliminates Cartesian products), and the type generator is a modular emitter pipeline that doesn't need a live Neo4j driver at build time. See the [Migration section](#migration-from-neo4jgraphql-ogm) below.

### grafeo-ogm vs. Prisma (for graph users)

Prisma is the gold standard for relational ORMs but doesn't speak Cypher. grafeo-ogm gives you a **Prisma-like API for Neo4j** — `find`, `findFirst`, `findUnique`, `findFirstOrThrow`, `create`, `createMany`, `update`, `upsert`, `delete`, `deleteMany`, `count`, `aggregate` — with the same `where`, `select`, and ordering ergonomics. If you're moving from Postgres to Neo4j and miss Prisma, this is the closest equivalent.

### grafeo-ogm vs. Cypher query builders

Pure query builders (e.g. `cypher-query-builder`) help you compose Cypher fragments but don't model your schema, don't generate types, and don't validate identifiers against your data model. grafeo-ogm includes a query builder under the hood — but the public API is schema-aware, so you write `User.find({ where: { email_CONTAINS: 'foo' } })` instead of stringifying clauses by hand.

### grafeo-ogm vs. neogma

[neogma](https://github.com/themetalfleece/neogma) is an ODM-style library where you define models in JavaScript classes. grafeo-ogm is **schema-first**: you write your data model once in `.graphql`, and TypeScript types + runtime validation are generated from it. If you want to keep schema as the single source of truth shared with frontend GraphQL consumers, grafeo-ogm fits naturally.

---

## FAQ

### Is grafeo-ogm production-ready?

Yes. The library has over 2,100 unit tests covering compilers, mutations, fulltext, transactions, security, scalar type mapping, the CLI, and edge cases, plus opt-in **live suites** (`tests/integration/`, run with `NEO4J_URI` set) that execute every fix against a real Neo4j 5.26 and assert on database outcomes. It targets Neo4j 5.x and follows semver — see [CHANGELOG.md](CHANGELOG.md).

### Does grafeo-ogm work with Neo4j Aura?

Yes. grafeo-ogm uses the standard `neo4j-driver` package (`^5` or `^6`) — anywhere the official driver works, grafeo-ogm works. Aura, self-hosted Neo4j 5.x, Docker images, embedded — all supported. The generated Cypher is kept valid on **Neo4j 5.x**, including 5.26 LTS and Aura 5.27, which are stricter than 2025.x+ (for example, a `CALL` subquery may not directly follow a write clause); the live suites run against 5.26.

Optional server features:

| Feature | Needs |
|---|---|
| Nested `orderBy`, `selectionSet` `options.sort` | APOC (`apoc.coll.sortMulti`) |
| `cloneSubgraph` / `deleteSubgraph` | APOC |
| `searchByVector` | Neo4j 5.11+ (vector indexes) |
| `searchByPhrase` | Neo4j 5.11+ with the GenAI plugin |

### Do I need to know Cypher?

For most CRUD work, no. `find`, `create`, `update`, and the rest cover 95% of typical applications. For complex queries (custom scoring, multi-hop algorithms), use `@cypher` directives in your schema or `ogm.$queryRaw(...)` for ad-hoc Cypher. grafeo-ogm doesn't hide Cypher — it generates it transparently and you can log every query via `Executor.debug = true`.

### Can I use grafeo-ogm with a GraphQL server (Apollo, Yoga, etc.)?

Yes — grafeo-ogm is GraphQL-SDL-driven, so the same `typeDefs` you pass to `new OGM(config)` can be used as your GraphQL schema. Resolvers call `ogm.model(...)` methods. There is no built-in resolver auto-generation (unlike `@neo4j/graphql`) — you write your own resolvers and call into the OGM, giving you full control over auth, validation, and business logic.

### How is grafeo-ogm different from `@neo4j/graphql`?

`@neo4j/graphql` is a full **server framework** that auto-generates resolvers and exposes a GraphQL endpoint. grafeo-ogm is a **library** — you import it into any TypeScript app (Express, Fastify, Hono, NestJS, Next.js API routes, scripts, workers) and call typed methods. No HTTP layer, no auto-resolvers. If you want full control over your stack, choose grafeo-ogm. If you want a batteries-included GraphQL server, choose `@neo4j/graphql`.

### Does it support transactions?

Yes — `ogm.$transaction(async (ctx) => { ... })` runs multiple operations atomically. Pass the `ctx` object as the `context` field of any model method's params — `Book.create({ input, context: ctx })` — to run it in the active transaction. It must go *inside* the params object: a second argument is ignored, and the call then runs outside the transaction and is not rolled back. See [Advanced Features → Transactions](#transactions).

### Does it support multi-database / multi-tenant Neo4j setups?

Yes — instantiate one OGM per database with `new OGM({ typeDefs, driver, database: 'tenant-a' })` (v2.4.8); every session the OGM opens then targets that database. Alternatively, open the session or transaction yourself (`driver.session({ database })`) and pass it via `{ context: { session } }` / `{ context: { transaction } }`. (Before v2.4.8 this answer claimed a per-query `database` option on `ExecutionContext`; there is none.) Multi-label nodes (`@node(labels: [...])`) handle a different multi-tenant pattern where tenants share a graph but have isolated label sets.

### What's the performance overhead vs. raw Cypher?

Negligible. grafeo-ogm compiles each query once per shape (selection sets are cached), then sends a parameterized Cypher string + params to the driver. There is no runtime ORM hydration layer in the hot path — results come back from `neo4j-driver`, are converted from Neo4j types (Integer, DateTime, Point), and are returned as plain JS objects. For benchmark-sensitive workloads, the generated Cypher avoids `OPTIONAL MATCH` Cartesian products that the deprecated `@neo4j/graphql-ogm` produced, so it's typically *faster* than the official OGM in real-world queries.

### Is there a CLI / migration tool / studio?

There is a CLI — the `grafeo` binary ships with the package (`grafeo generate`, `grafeo db push`, `grafeo db seed`). See the [CLI](#cli) section. There is no studio. Data migrations are intentionally out of scope: `db push` syncs SDL-declared constraints and indexes only, never data. Neo4j's labels and properties are flexible enough that you typically migrate data via Cypher scripts (`MATCH (n:OldLabel) SET n:NewLabel REMOVE n:OldLabel`) which you can run via `ogm.$executeRaw(...)`.

### How do I report a bug or request a feature?

Open an issue on [GitHub](https://github.com/neomodular/grafeo-ogm/issues). For security issues, see [SECURITY.md](SECURITY.md).

---

## API Reference

### OGM

| Method | Description |
|---|---|
| `new OGM(config)` | Create an OGM instance with `{ typeDefs, driver, database?, logger?, features? }` |
| `model(name)` | Get a typed Model for a node type |
| `interfaceModel(name)` | Get a typed InterfaceModel for an interface type |
| `$queryRaw(cypher, params?)` | Execute a read query and return mapped results |
| `$executeRaw(cypher, params?)` | Execute a write operation and return affected counts |
| `$transaction(fn, options?)` | Execute operations in an atomic transaction; `options.metadata` is attached when it begins |
| `assertIndexesAndConstraints(options?)` | Create fulltext indexes and uniqueness constraints |
| `close()` | Clear caches and release references |

### Model

| Method | Returns | Description |
|---|---|---|
| `find(options?)` | `T[]` | Find all nodes matching filters |
| `findFirst(options?)` | `T \| null` | Find first matching node |
| `findUnique(options)` | `T \| null` | Find by unique identifier |
| `findFirstOrThrow(options?)` | `T` | Find first match or throw `RecordNotFoundError` |
| `findUniqueOrThrow(options)` | `T` | Find by unique identifier or throw |
| `create(options)` | `MutationResponse` | Create one or more nodes with optional relationships |
| `createMany(options)` | `{ count }` | Bulk create nodes |
| `update(options)` | `MutationResponse` | Update matched nodes with connect/disconnect |
| `updateMany(options)` | `{ count }` | Bulk update matched nodes |
| `delete(options)` | `DeleteInfo` | Delete matched nodes with optional cascade |
| `deleteMany(options)` | `{ count }` | Bulk delete matched nodes |
| `upsert(options)` | `T` | Create if not found, update if exists |
| `count(options?)` | `number` | Count matching nodes |
| `aggregate(options)` | `AggregateResult` | Aggregate values (min, max, avg, count) |
| `setLabels(options)` | `void` | Add or remove labels on matching nodes |
| `explainPolicies(options?)` | `PolicyExplanation<T>[]` | Per-clause `read` policy outcomes per candidate, including hidden nodes (policy-bound models only; see [Explaining policy decisions](#explaining-policy-decisions)) |

### InterfaceModel

| Method | Returns | Description |
|---|---|---|
| `find(options?)` | `T[]` | Find nodes across all implementing types |
| `findFirst(options?)` | `T \| null` | Find first match |
| `findUnique(options)` | `T \| null` | Find by unique identifier |
| `findFirstOrThrow(options?)` | `T` | Find first match or throw |
| `findUniqueOrThrow(options)` | `T` | Find by unique identifier or throw |
| `count(options?)` | `number` | Count matching nodes |
| `aggregate(options)` | `AggregateResult` | Aggregate across implementing types |

### generateTypes(options)

| Option | Type | Default | Description |
|---|---|---|---|
| `typeDefs` | `string` | *(required)* | Raw GraphQL schema string |
| `outFile` | `string` | *(required)* | Output file path |
| `config.packageName` | `string` | `'grafeo-ogm'` | Package name in generated imports |
| `config.stringMatchesFilter` | `boolean` | `true` | Enable `_MATCHES` operator |
| `config.formatOutput` | `boolean` | `true` | Format with Prettier |
| `config.prettierConfig` | `object` | — | Custom Prettier config |
| `config.header` | `string` | — | Custom header comment |

Returns `GenerateTypesResult`:

| Field | Type | Description |
|---|---|---|
| `outputPath` | `string` | Absolute path of the written file |
| `typeCount` | `number` | Number of exported types/interfaces/enums |
| `fileSize` | `number` | File size in bytes |
| `durationMs` | `number` | Generation duration in milliseconds |
| `warnings` | `GeneratorWarning[]` | Non-fatal warnings encountered |

For detailed usage examples, see the [`examples/`](./examples/) directory.

---

## Contributing

Contributions are welcome. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
# Clone and install
git clone https://github.com/aleguzman/grafeo-ogm.git
cd grafeo-ogm
pnpm install

# Run tests
pnpm test

# Lint and format
pnpm run lint
pnpm run format

# Build
pnpm run build
```

---

## License

[MIT](LICENSE)
