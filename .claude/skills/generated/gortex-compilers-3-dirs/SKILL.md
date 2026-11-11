---
name: gortex-compilers-3-dirs
description: "Work in the compilers +3 dirs area — 171 symbols across 5 files (78% cohesion)"
---

# compilers +3 dirs

171 symbols | 5 files | 78% cohesion

## When to Use

Use this skill when working on files in:
- `src/compilers/selection.compiler.ts`
- `src/compilers/where.compiler.ts`
- `src/model.ts`
- `src/schema/utils.ts`
- `src/utils/cypher-field-projection.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/compilers/selection.compiler.ts` | caseCypher, children, memberList, node, maxDepth, ... |
| `src/compilers/where.compiler.ts` | nodeDef, edgeVar, targetNodeDef, whereClause, depth, ... |
| `src/model.ts` | cypher, policyContext, selection, applySelectionSetToMutation, replacement, ... |
| `src/schema/utils.ts` | target, cached, result, mergedProperties, unionMembers, ... |
| `src/utils/cypher-field-projection.ts` | CypherFieldScope, emit, aliases, nodeVar, carriedAliases, ... |

## Entry Points

- `src/compilers/where.compiler.ts::WhereCompiler.tryCompileConnection`

## Connected Communities

- **compilers +2 dirs · buildUpdateRelationships** (7 cross-edges)
- **schema +1 dirs · parseVectorIndexes** (4 cross-edges)
- **src +3 dirs · aggregate** (3 cross-edges)
- **compilers +1 dirs · compileConnection** (3 cross-edges)
- **compilers +1 dirs · normalizeRelationship** (2 cross-edges)
- **compilers +2 dirs · compileConditions** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-74"
smart_context with task: "understand compilers +3 dirs", format: "gcx"
find_usages with id: "src/compilers/where.compiler.ts::WhereCompiler.tryCompileConnection", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
