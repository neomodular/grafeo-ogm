---
name: gortex-src-3-dirs-compilerelationshipindex
description: "Work in the src +3 dirs · compileRelationshipIndex area — 86 symbols across 6 files (71% cohesion)"
---

# src +3 dirs · compileRelationshipIndex

86 symbols | 6 files | 71% cohesion

## When to Use

Use this skill when working on files in:
- `examples/grafeo.generated.ts`
- `src/compilers/fulltext.compiler.ts`
- `src/compilers/select-normalizer.ts`
- `src/errors.ts`
- `src/model.ts`
- `src/utils/validation.ts`

## Key Files

| File | Symbols |
|------|---------|
| `examples/grafeo.generated.ts` | FulltextIndexEntry, BookFulltextLeaf |
| `src/compilers/fulltext.compiler.ts` | nodeDef, nodeVar, nodeDef, lines, result, ... |
| `src/compilers/select-normalizer.ts` | scope, orderByInput, targetDef, scopeKey, direction, ... |
| `src/errors.ts` | OGMError, message, constructor |
| `src/model.ts` | isFulltextIndexEntry, value, FulltextRelationshipEntry, FulltextIndexEntry, FulltextLeaf |
| `src/utils/validation.ts` | assertSortDirection, subject, suggestion, assertSingleFulltextKey, direction, ... |

## Entry Points

- `src/compilers/select-normalizer.ts::SelectNormalizer.normalizeConnectionOrderBy`

## Connected Communities

- **schema +1 dirs · parseVectorIndexes** (5 cross-edges)
- **examples +3 dirs** (2 cross-edges)
- **compilers +1 dirs · compileConnection** (1 cross-edges)
- **utils · singleKeyPrefix** (1 cross-edges)
- **compilers +2 dirs · compileConditions** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-22"
smart_context with task: "understand src +3 dirs · compileRelationshipIndex", format: "gcx"
find_usages with id: "src/compilers/select-normalizer.ts::SelectNormalizer.normalizeConnectionOrderBy", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
