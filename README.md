# grafeo-ogm

**A type-safe Object-Graph Mapper for Neo4j, driven by GraphQL SDL.**

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
- [Quick Start](#quick-start)
- [Features Overview](#features-overview)
- [Schema Definition](#schema-definition)
- [Query API](#query-api)
- [Mutation API](#mutation-api)
- [Advanced Features](#advanced-features)
- [Type Generation](#type-generation)
- [Testing Utilities](#testing-utilities)
- [Security](#security)
- [Migration from @neo4j/graphql-ogm](#migration-from-neo4jgraphql-ogm)
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
| **Fulltext search** | Node and relationship indexes with phrase matching, score thresholds, and logical operators (`AND`, `OR`, `NOT`) |
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
