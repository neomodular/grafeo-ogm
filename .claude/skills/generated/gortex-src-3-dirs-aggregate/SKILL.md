---
name: gortex-src-3-dirs-aggregate
description: "Work in the src +3 dirs · aggregate area — 277 symbols across 8 files (76% cohesion)"
---

# src +3 dirs · aggregate

277 symbols | 8 files | 76% cohesion

## When to Use

Use this skill when working on files in:
- `src/compilers/selection.compiler.ts`
- `src/compilers/where.compiler.ts`
- `src/execution/executor.ts`
- `src/execution/result-mapper.ts`
- `src/model.ts`
- `src/ogm.ts`
- `src/utils/cypher-field-projection.ts`
- `src/utils/validation.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/compilers/selection.compiler.ts` | parseSelectionSet, dummyField, result, cached, doc, ... |
| `src/compilers/where.compiler.ts` | compile, result, nodeDef, paramCounter, stitchUserAndPolicy, ... |
| `src/execution/executor.ts` | debug, params, tx, Executor, driver, ... |
| `src/execution/result-mapper.ts` | returnKey, mapRecords, records |
| `src/model.ts` | aggregate, paramCounter, params, policyContext, buildSelectResult, ... |
| `src/ogm.ts` | bypassPolicies |
| `src/utils/cypher-field-projection.ts` | carried |
| `src/utils/validation.ts` | target, mergeParams, source |

## Entry Points

- `src/model.ts::Model.runVectorSearch`

## Connected Communities

- **compilers +3 dirs** (15 cross-edges)
- **compilers +2 dirs · buildUpdateRelationships** (12 cross-edges)
- **. +4 dirs** (9 cross-edges)
- **src +4 dirs** (6 cross-edges)
- **policy +2 dirs** (2 cross-edges)
- **src +2 dirs · compileNode** (2 cross-edges)
- **compilers +2 dirs · compileConditions** (2 cross-edges)
- **compilers · compileByPhrase** (2 cross-edges)
- **policy +1 dirs · evaluateCreatePolicies** (2 cross-edges)
- **src +2 dirs · ModelInterface** (1 cross-edges)
- **compilers · convertSelectionSet** (1 cross-edges)
- **compilers +1 dirs · normalizeRelationship** (1 cross-edges)
- **schema +1 dirs · parseVectorIndexes** (1 cross-edges)
- **src +1 dirs · compileSortClause** (1 cross-edges)
- **src +6 dirs** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-54"
smart_context with task: "understand src +3 dirs · aggregate", format: "gcx"
find_usages with id: "src/model.ts::Model.runVectorSearch", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
