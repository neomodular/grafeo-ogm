---
name: gortex-examples-3-dirs
description: "Work in the examples +3 dirs area — 204 symbols across 17 files (82% cohesion)"
---

# examples +3 dirs

204 symbols | 17 files | 82% cohesion

## When to Use

Use this skill when working on files in:
- `examples/01-basic-crud.ts`
- `examples/02-prisma-like-queries.ts`
- `examples/03-typed-select.ts`
- `examples/04-where-filters.ts`
- `examples/05-nested-mutations.ts`
- `examples/06-fulltext-search.ts`
- `examples/07-transactions.ts`
- `examples/08-raw-cypher.ts`
- `examples/09-interface-models.ts`
- `examples/10-multi-label.ts`
- `examples/11-aggregation.ts`
- `examples/12-error-handling.ts`
- `examples/shared/setup.ts`
- `src/errors.ts`
- `src/interface-model.ts`
- `src/model.ts`
- `src/testing/neo4j-record-factory.ts`

## Key Files

| File | Symbols |
|------|---------|
| `examples/01-basic-crud.ts` | Author, updateResult, ogm, filtered, authors, ... |
| `examples/02-prisma-like-queries.ts` | main, driver, cheapest, ogm, upserted, ... |
| `examples/03-typed-select.ts` | Book, withSelectionSet, withNestedSelect, main, driver, ... |
| `examples/04-where-filters.ts` | allPositive, expensive, withDescription, complexFilter, byAuthorName, ... |
| `examples/05-nested-mutations.ts` | Book, ogm, main, deleteResult, driver, ... |
| `examples/06-fulltext-search.ts` | affordableResults, results, Book, ogm, highScoreResults, ... |
| `examples/07-transactions.ts` | err, booksFound, driver, ogm, Author, ... |
| `examples/08-raw-cypher.ts` | bulkResult, Author, writeResult, paths, driver, ... |
| `examples/09-interface-models.ts` | byName, Author, total, err, Publisher, ... |
| `examples/10-multi-label.ts` | main, firstFeatured, afterRemoval, ogm, driver, ... |
| `examples/11-aggregation.ts` | priceAgg, main, ogm, publishedPrices, countAgg, ... |
| `examples/12-error-handling.ts` | main, err, err, ogm, driver, ... |
| `examples/shared/setup.ts` | createOGM, user, cleanup, driver, ogm, ... |
| `src/errors.ts` | whereStr, RecordNotFoundError, where, where, model, ... |
| `src/interface-model.ts` | syntheticNodeDef, validatedLabels, findUnique, sortOrderBy, returnClause, ... |
| `src/model.ts` | createMany, cypher, count, params, findFirst, ... |
| `src/testing/neo4j-record-factory.ts` | create, values, data, keys |

## Entry Points

- `examples/04-where-filters.ts::main`
- `examples/09-interface-models.ts::main`
- `examples/10-multi-label.ts::main`
- `examples/12-error-handling.ts::main`
- `examples/02-prisma-like-queries.ts::main`

## Connected Communities

- **src +3 dirs · aggregate** (11 cross-edges)
- **. +4 dirs** (4 cross-edges)
- **compilers +3 dirs** (3 cross-edges)
- **compilers +2 dirs · buildUpdateRelationships** (3 cross-edges)
- **policy +3 dirs** (2 cross-edges)
- **src +2 dirs · close** (1 cross-edges)
- **src +1 dirs · compileSortClause** (1 cross-edges)
- **policy +1 dirs · evaluateCreatePolicies** (1 cross-edges)
- **compilers +1 dirs · normalizeRelationship** (1 cross-edges)
- **policy +2 dirs** (1 cross-edges)
- **src +2 dirs · ModelInterface** (1 cross-edges)
- **src +4 dirs** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-7"
smart_context with task: "understand examples +3 dirs", format: "gcx"
find_usages with id: "examples/04-where-filters.ts::main", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
