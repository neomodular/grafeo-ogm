---
name: gortex-policy-3-dirs
description: "Work in the policy +3 dirs area — 101 symbols across 9 files (74% cohesion)"
---

# policy +3 dirs

101 symbols | 9 files | 74% cohesion

## When to Use

Use this skill when working on files in:
- `src/compilers/mutation.compiler.ts`
- `src/compilers/where.compiler.ts`
- `src/interface-model.ts`
- `src/model.ts`
- `src/policy/types.ts`
- `tests/policy/cypher-fragment.spec.ts`
- `tests/policy/nested-selection.spec.ts`
- `tests/policy/where-injection.spec.ts`
- `tests/policy/where-relationship-traversal.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/compilers/mutation.compiler.ts` | RelationshipSuffix |
| `src/compilers/where.compiler.ts` | tryCompileRelationship, relDef, compileUnionRelationship, innerPreludeFragment, targetNodeDef, ... |
| `src/interface-model.ts` | m, typeName, memberPolicy, bundle, result, ... |
| `src/model.ts` | resolveForType, typeName, targetOp |
| `src/policy/types.ts` | PolicyContextBundle |
| `tests/policy/cypher-fragment.spec.ts` | policyBundle, args |
| `tests/policy/nested-selection.spec.ts` | result.resolveForType, args, out.resolveForType, policyContext.resolveForType, b.resolveForType, ... |
| `tests/policy/where-injection.spec.ts` | defaults, ctx, overrides, bundle |
| `tests/policy/where-relationship-traversal.spec.ts` | defaults, resolveByType, ctx, opts, buildBundle |

## Entry Points

- `src/compilers/where.compiler.ts::WhereCompiler.compileUnionRelationship`
- `src/compilers/where.compiler.ts::WhereCompiler.tryCompileRelationship`

## Connected Communities

- **src +3 dirs · aggregate** (5 cross-edges)
- **compilers +2 dirs · buildUpdateRelationships** (4 cross-edges)
- **src +4 dirs** (1 cross-edges)
- **compilers +3 dirs** (1 cross-edges)
- **schema +1 dirs · parseVectorIndexes** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-57"
smart_context with task: "understand policy +3 dirs", format: "gcx"
find_usages with id: "src/compilers/where.compiler.ts::WhereCompiler.compileUnionRelationship", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
