---
name: gortex-compilers-2-dirs-compileconditions
description: "Work in the compilers +2 dirs · compileConditions area — 146 symbols across 3 files (80% cohesion)"
---

# compilers +2 dirs · compileConditions

146 symbols | 3 files | 80% cohesion

## When to Use

Use this skill when working on files in:
- `src/compilers/where.compiler.ts`
- `src/policy/types.ts`
- `src/utils/validation.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/compilers/where.compiler.ts` | op, relVar, paramName, permClause, cypher, ... |
| `src/policy/types.ts` | p, C, isReadRestrictive, op |
| `src/utils/validation.ts` | key, context, assertSafeKey |

## Entry Points

- `src/compilers/where.compiler.ts::WhereCompiler.compilePolicyClause`

## Connected Communities

- **src +3 dirs · aggregate** (13 cross-edges)
- **schema +1 dirs · parseVectorIndexes** (4 cross-edges)
- **compilers +2 dirs · buildUpdateRelationships** (2 cross-edges)
- **compilers +1 dirs · compileConnection** (2 cross-edges)
- **compilers +3 dirs** (2 cross-edges)
- **policy +3 dirs** (2 cross-edges)
- **utils +1 dirs · refuse** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-81"
smart_context with task: "understand compilers +2 dirs · compileConditions", format: "gcx"
find_usages with id: "src/compilers/where.compiler.ts::WhereCompiler.compilePolicyClause", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
