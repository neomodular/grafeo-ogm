---
name: gortex-compilers-1-dirs-compileconnection
description: "Work in the compilers +1 dirs · compileConnection area — 85 symbols across 2 files (78% cohesion)"
---

# compilers +1 dirs · compileConnection

85 symbols | 2 files | 78% cohesion

## When to Use

Use this skill when working on files in:
- `src/compilers/selection.compiler.ts`
- `src/utils/validation.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/compilers/selection.compiler.ts` | params, whereCompiler, relDef, edgeNotFragment, edgeVar, ... |
| `src/utils/validation.ts` | value, isPlainObject |

## Entry Points

- `src/compilers/selection.compiler.ts::SelectionCompiler.compileConnection`

## Connected Communities

- **compilers +2 dirs · buildUpdateRelationships** (5 cross-edges)
- **src +3 dirs · aggregate** (5 cross-edges)
- **schema +1 dirs · parseVectorIndexes** (3 cross-edges)
- **compilers +3 dirs** (2 cross-edges)
- **policy +3 dirs** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-80"
smart_context with task: "understand compilers +1 dirs · compileConnection", format: "gcx"
find_usages with id: "src/compilers/selection.compiler.ts::SelectionCompiler.compileConnection", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
