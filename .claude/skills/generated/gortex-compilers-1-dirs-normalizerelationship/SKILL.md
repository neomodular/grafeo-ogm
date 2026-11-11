---
name: gortex-compilers-1-dirs-normalizerelationship
description: "Work in the compilers +1 dirs · normalizeRelationship area — 66 symbols across 3 files (80% cohesion)"
---

# compilers +1 dirs · normalizeRelationship

66 symbols | 3 files | 80% cohesion

## When to Use

Use this skill when working on files in:
- `src/compilers/select-normalizer.ts`
- `src/compilers/selection.compiler.ts`
- `src/interface-model.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/compilers/select-normalizer.ts` | connectionNode, targetDef, nodes, normalizeOrderBy, normalizeRelationship, ... |
| `src/compilers/selection.compiler.ts` | SelectionNode |
| `src/interface-model.ts` | nodes, prop, defaultInterfaceSelection |

## Connected Communities

- **compilers +2 dirs · compileConditions** (3 cross-edges)
- **compilers +3 dirs** (2 cross-edges)
- **compilers +1 dirs · compileConnection** (2 cross-edges)
- **src +3 dirs · compileRelationshipIndex** (2 cross-edges)
- **schema +1 dirs · parseVectorIndexes** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-19"
smart_context with task: "understand compilers +1 dirs · normalizeRelationship", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
