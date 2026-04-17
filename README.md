<p align="center">
  <img src="./assets/logo.jpg" alt="grafeo-ogm — Type-safe OGM for Neo4j" width="640" />
</p>

<p align="center"><strong>A type-safe Object-Graph Mapper for Neo4j, driven by GraphQL SDL.</strong></p>

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
- [Features Overview](#features-overview)
- [Schema Definition](#schema-definition)
- [Query API](#query-api)
- [Mutation API](#mutation-api)
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

### 2. Initialize the OGM

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

### 3. Basic CRUD

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

### 4. Transactions

```typescript
await ogm.$transaction(async (ctx) => {
  await Book.create({ input: [{ title: 'Book A' }] }, { context: ctx });
  await Book.create({ input: [{ title: 'Book B' }] }, { context: ctx });
  // Both committed atomically, or both rolled back on error
});
```

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
| `@node` | Type | Marks a type as a Neo4j node. Optional `labels` argument for multi-label nodes |
| `@relationship` | Field | Defines a relationship with `type`, `direction` (`IN`/`OUT`), and optional `properties` |
| `@relationshipProperties` | Type | Marks a type as relationship properties (edge data) |
| `@id` | Field | Auto-generates a UUID on create |
| `@unique` | Field | Creates a uniqueness constraint in Neo4j |
| `@cypher` | Field | Computed field resolved via a custom Cypher statement |
| `@default` | Field | Sets a default value on create |
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
interface Entity @node {
  id: ID! @id
  name: String!
}

type User @node implements Entity {
  id: ID! @id
  name: String!
  email: String!
}

type Organization @node implements Entity {
  id: ID! @id
  name: String!
  website: String
}
```

Interface types can be queried polymorphically via `ogm.interfaceModel('Entity')`. Results include `__typename` to discriminate concrete types.

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

**Relationship quantifiers:**

| Operator | Meaning | Example |
|---|---|---|
| *(bare key)* or `_SOME` | At least one related node matches | `{ categories_SOME: { name: 'Tech' } }` |
| `_NONE` | No related node matches | `{ categories_NONE: { name: 'Fiction' } }` |
| `_ALL` | Every related node matches | `{ categories_ALL: { name: 'Tech' } }` |
| `_SINGLE` | Exactly one related node matches | `{ categories_SINGLE: { name: 'Tech' } }` |

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

// Relationship existence
await Book.find({ where: { author: null } });       // NOT EXISTS pattern
```

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

### Subgraph Operations

Clone or delete entire subgraphs using APOC procedures. Requires the APOC plugin installed in Neo4j.

```typescript
import { cloneSubgraph, deleteSubgraph } from 'grafeo-ogm';

// Clone a subgraph rooted at a node
const cloneResult = await cloneSubgraph(
  'source-node-id',
  {
    ownedLabels: ['Book', 'Chapter', 'Section'],
    ownedRelationships: ['HAS_CHAPTER', 'HAS_SECTION'],
    referenceRelationships: [
      { fromLabel: 'Book', relationshipType: 'WRITTEN_BY', direction: 'OUT' },
    ],
  },
  transaction,
);
// cloneResult: { clonedRootId, idMapping: Map<original, cloned> }

// Delete a subgraph
const deleteResult = await deleteSubgraph(
  'root-node-id',
  {
    ownedLabels: ['Book', 'Chapter'],
    ownedRelationships: ['HAS_CHAPTER'],
    referenceRelationships: [],
  },
  transaction,
);
```

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
  await Book.create({ input: [{ title: 'Book A' }] }, { context: ctx });
  await Book.update(
    { where: { id: 'book-1' }, update: { title: 'Updated' } },
    { context: ctx },
  );
  // Committed on success, rolled back on error
});

// Sequential style — array of operations
const [books, authors] = await ogm.$transaction([
  (ctx) => Book.find({ select: { id: true } }, { context: ctx }),
  (ctx) => Author.find({ select: { id: true } }, { context: ctx }),
]);
```

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

grafeo-ogm does **not** create vector indexes for you in this release. Run the `CREATE VECTOR INDEX` Cypher yourself as part of your migration:

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
- **Automatic index creation via `assertIndexesAndConstraints`** — you must run `CREATE VECTOR INDEX` yourself.

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

Assert Cypher queries contain expected patterns:

```typescript
// Check that a Cypher string contains a fragment
CypherAssert.assertContains(cypher, 'MATCH (n:`Book`)');

// Check parameter values
CypherAssert.assertParams(params, { param0: 'Graph Databases' });
```

### Neo4jRecordFactory

Build mock Neo4j records for unit tests without a running database:

```typescript
const records = Neo4jRecordFactory.create([
  { id: '1', title: 'Test Book', published: '2024-01-01' },
  { id: '2', title: 'Another Book', published: '2024-06-15' },
]);
```

### SelectionSetFactory

Build selection sets programmatically:

```typescript
const selectionSet = SelectionSetFactory.build(`{
  id
  title
  author { name }
}`);
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

Yes. The library has 892 unit tests covering compilers, mutations, fulltext, transactions, security, scalar type mapping, and edge cases. It targets Neo4j 5.x and follows semver — see [CHANGELOG.md](CHANGELOG.md).

### Does grafeo-ogm work with Neo4j Aura?

Yes. grafeo-ogm uses the standard `neo4j-driver` package — anywhere the official driver works, grafeo-ogm works. Aura, self-hosted Neo4j 5.x, Docker images, embedded — all supported. The only optional dependency is the **APOC plugin**, used for nested `orderBy` (via `apoc.coll.sortMulti`) and subgraph operations (via `apoc.refactor.cloneSubgraph`).

### Do I need to know Cypher?

For most CRUD work, no. `find`, `create`, `update`, and the rest cover 95% of typical applications. For complex queries (custom scoring, multi-hop algorithms), use `@cypher` directives in your schema or `ogm.$queryRaw(...)` for ad-hoc Cypher. grafeo-ogm doesn't hide Cypher — it generates it transparently and you can log every query via `Executor.debug = true`.

### Can I use grafeo-ogm with a GraphQL server (Apollo, Yoga, etc.)?

Yes — grafeo-ogm is GraphQL-SDL-driven, so the same `typeDefs` you pass to `new OGM(config)` can be used as your GraphQL schema. Resolvers call `ogm.model(...)` methods. There is no built-in resolver auto-generation (unlike `@neo4j/graphql`) — you write your own resolvers and call into the OGM, giving you full control over auth, validation, and business logic.

### How is grafeo-ogm different from `@neo4j/graphql`?

`@neo4j/graphql` is a full **server framework** that auto-generates resolvers and exposes a GraphQL endpoint. grafeo-ogm is a **library** — you import it into any TypeScript app (Express, Fastify, Hono, NestJS, Next.js API routes, scripts, workers) and call typed methods. No HTTP layer, no auto-resolvers. If you want full control over your stack, choose grafeo-ogm. If you want a batteries-included GraphQL server, choose `@neo4j/graphql`.

### Does it support transactions?

Yes — `ogm.$transaction(async (ctx) => { ... })` runs multiple operations atomically. Pass the `ctx` object to any model method via `{ context: ctx }` to opt into the active transaction. See [Advanced Features → Transactions](#transactions).

### Does it support multi-database / multi-tenant Neo4j setups?

Yes — pass a `database` option per query via the `ExecutionContext`, or instantiate one OGM per database. Multi-label nodes (`@node(labels: [...])`) handle a different multi-tenant pattern where tenants share a graph but have isolated label sets.

### What's the performance overhead vs. raw Cypher?

Negligible. grafeo-ogm compiles each query once per shape (selection sets are cached), then sends a parameterized Cypher string + params to the driver. There is no runtime ORM hydration layer in the hot path — results come back from `neo4j-driver`, are converted from Neo4j types (Integer, DateTime, Point), and are returned as plain JS objects. For benchmark-sensitive workloads, the generated Cypher avoids `OPTIONAL MATCH` Cartesian products that the deprecated `@neo4j/graphql-ogm` produced, so it's typically *faster* than the official OGM in real-world queries.

### Is there a CLI / migration tool / studio?

Not yet. The library focuses on the runtime API and type generation. Schema migrations are intentionally out of scope — Neo4j's labels and properties are flexible enough that you typically migrate via Cypher scripts (`MATCH (n:OldLabel) SET n:NewLabel REMOVE n:OldLabel`) which you can run via `ogm.$executeRaw(...)`.

### How do I report a bug or request a feature?

Open an issue on [GitHub](https://github.com/neomodular/grafeo-ogm/issues). For security issues, see [SECURITY.md](SECURITY.md).

---

## API Reference

### OGM

| Method | Description |
|---|---|
| `new OGM(config)` | Create an OGM instance with `{ typeDefs, driver, logger?, features? }` |
| `model(name)` | Get a typed Model for a node type |
| `interfaceModel(name)` | Get a typed InterfaceModel for an interface type |
| `$queryRaw(cypher, params?)` | Execute a read query and return mapped results |
| `$executeRaw(cypher, params?)` | Execute a write operation and return affected counts |
| `$transaction(fn)` | Execute operations in an atomic transaction |
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
