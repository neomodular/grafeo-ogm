# grafeo-ogm Examples

Ready-to-run TypeScript examples demonstrating the full API surface of grafeo-ogm.

## Prerequisites

- Node.js 18+
- Neo4j 5.x running locally (examples 01-12 require a database)
- Build the project first: `pnpm run build`

## Running

```bash
# From the project root
npx tsx examples/01-basic-crud.ts
```

## Environment Variables

| Variable         | Default                 | Description            |
| ---------------- | ----------------------- | ---------------------- |
| `NEO4J_URI`      | `bolt://localhost:7687` | Neo4j connection URI   |
| `NEO4J_USER`     | `neo4j`                 | Neo4j username         |
| `NEO4J_PASSWORD`  | `password`              | Neo4j password         |

## Example Index

| #  | File                        | Feature                  | Neo4j Required |
| -- | --------------------------- | ------------------------ | -------------- |
| 01 | `01-basic-crud.ts`          | find, create, update, delete | Yes |
| 02 | `02-prisma-like-queries.ts` | findFirst, findUnique, *OrThrow, createMany, updateMany, deleteMany, upsert | Yes |
| 03 | `03-typed-select.ts`        | select: {} API vs selectionSet, nested select | Yes |
| 04 | `04-where-filters.ts`       | Comparison, string, logical, null, relationship filters | Yes |
| 05 | `05-nested-mutations.ts`    | Create/connect/disconnect with edge properties, cascade delete | Yes |
| 06 | `06-fulltext-search.ts`     | @fulltext queries with phrase and score | Yes |
| 07 | `07-transactions.ts`        | $transaction callback + sequential forms | Yes |
| 08 | `08-raw-cypher.ts`          | $queryRaw, $executeRaw | Yes |
| 09 | `09-interface-models.ts`    | interfaceModel(), __typename, read-only constraint | Yes |
| 10 | `10-multi-label.ts`         | labels param on queries/mutations, setLabels() | Yes |
| 11 | `11-aggregation.ts`         | count(), aggregate() with min/max/avg | Yes |
| 12 | `12-error-handling.ts`      | RecordNotFoundError, OGMError | Yes |
| 13 | `13-code-generation.ts`     | generateTypes() script | No |
| 14 | `14-testing-utilities.ts`   | CypherAssert, Neo4jRecordFactory, SelectionSetFactory | No |

## Schema

All examples share `schema.graphql` — a bookstore domain with authors, books, categories, reviews, and publishers. It covers interfaces, enums, fulltext indexes, relationship properties, and @unique fields.

## Warning

These examples create, modify, and delete data. Use a dedicated test database, not a production instance.
