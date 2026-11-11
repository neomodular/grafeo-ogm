---
name: gortex-compilers-2-dirs-buildupdaterelationships
description: "Work in the compilers +2 dirs · buildUpdateRelationships area — 499 symbols across 3 files (90% cohesion)"
---

# compilers +2 dirs · buildUpdateRelationships

499 symbols | 3 files | 90% cohesion

## When to Use

Use this skill when working on files in:
- `src/compilers/mutation.compiler.ts`
- `src/schema/utils.ts`
- `src/utils/validation.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/compilers/mutation.compiler.ts` | targetLabelStr, keys, policyPredicate, prefix, conditions, ... |
| `src/schema/utils.ts` | rawLabel, opts, sourcePart, targetPart, schema, ... |
| `src/utils/validation.ts` | context, assertSafePropertyName, name, escapeIdentifier, identifier, ... |

## Entry Points

- `src/compilers/mutation.compiler.ts::MutationCompiler.buildConnects`
- `src/compilers/mutation.compiler.ts::MutationCompiler.buildUpdateRelationships`
- `src/compilers/mutation.compiler.ts::MutationCompiler.buildCreateRelationshipsForTarget`
- `src/compilers/mutation.compiler.ts::MutationCompiler.buildDisconnects`

## Connected Communities

- **src +3 dirs · aggregate** (7 cross-edges)
- **schema +1 dirs · parseVectorIndexes** (7 cross-edges)
- **src +4 dirs** (6 cross-edges)
- **compilers +3 dirs** (4 cross-edges)
- **policy +3 dirs** (1 cross-edges)
- **tests +5 dirs** (1 cross-edges)
- **compilers +2 dirs · compileConditions** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-79"
smart_context with task: "understand compilers +2 dirs · buildUpdateRelationships", format: "gcx"
find_usages with id: "src/compilers/mutation.compiler.ts::MutationCompiler.buildConnects", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
