---
name: gortex-tests-5-dirs
description: "Work in the tests +5 dirs area — 123 symbols across 22 files (73% cohesion)"
---

# tests +5 dirs

123 symbols | 22 files | 73% cohesion

## When to Use

Use this skill when working on files in:
- `src/compilers/mutation.compiler.ts`
- `src/generator/type-emitters/fulltext-emitter.ts`
- `src/schema/types.ts`
- `tests/edge-cases.spec.ts`
- `tests/emitters/aggregation-emitter.spec.ts`
- `tests/emitters/node-type-emitter.spec.ts`
- `tests/emitters/where-emitter.spec.ts`
- `tests/error-paths.spec.ts`
- `tests/fulltext-advanced.spec.ts`
- `tests/interface-model.spec.ts`
- `tests/model.spec.ts`
- `tests/multi-label.spec.ts`
- `tests/mutation.compiler.spec.ts`
- `tests/policy/where-injection.spec.ts`
- `tests/policy/where-relationship-traversal.spec.ts`
- `tests/selection.compiler.cypher-fields.spec.ts`
- `tests/sort-entry-arity.spec.ts`
- `tests/tier1-features.spec.ts`
- `tests/tier2-features.spec.ts`
- `tests/vector.compiler.spec.ts`
- `tests/where.compiler.cypher-fields.spec.ts`
- `tests/where.compiler.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/compilers/mutation.compiler.ts` | memberKey, sourceVar, memberEntries, ancestorVars, key, ... |
| `src/generator/type-emitters/fulltext-emitter.ts` | toCamelCase, node, schema, props, getRelationshipFulltextEntries, ... |
| `src/schema/types.ts` | NodeDefinition |
| `tests/edge-cases.spec.ts` | overrides, makeNodeDef |
| `tests/emitters/aggregation-emitter.spec.ts` | props, makeNode, overrides, rels, typeName |
| `tests/emitters/node-type-emitter.spec.ts` | makeNodeDef, overrides, typeName |
| `tests/emitters/where-emitter.spec.ts` | rels, typeName, props, overrides, makeNodeDef |
| `tests/error-paths.spec.ts` | typeName, props, rels, nodeDef, overrides |
| `tests/fulltext-advanced.spec.ts` | createMockNodeDef, overrides |
| `tests/interface-model.spec.ts` | rels, nodeDef, typeName, props, overrides |
| `tests/model.spec.ts` | typeName, rels, nodeDef, overrides, props |
| `tests/multi-label.spec.ts` | overrides, props, typeName, nodeDef, rels |
| `tests/mutation.compiler.spec.ts` | props, rels, overrides, typeName, nodeDef |
| `tests/policy/where-injection.spec.ts` | makeNodeDef, over |
| `tests/policy/where-relationship-traversal.spec.ts` | over, makeNodeDef |
| `tests/selection.compiler.cypher-fields.spec.ts` | rels, props, makeNode, typeName |
| `tests/sort-entry-arity.spec.ts` | overrides, props, nodeDef, typeName |
| `tests/tier1-features.spec.ts` | props, typeName, nodeDef, overrides, rels |
| `tests/tier2-features.spec.ts` | nodeDef, rels, props, overrides, typeName |
| `tests/vector.compiler.spec.ts` | makeNodeDef |
| `tests/where.compiler.cypher-fields.spec.ts` | makeNodeDef, overrides |
| `tests/where.compiler.spec.ts` | makeNodeDef, overrides |

## Connected Communities

- **compilers +2 dirs · buildUpdateRelationships** (1 cross-edges)
- **generator/type-emitters · emitFulltextLeaf** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-28"
smart_context with task: "understand tests +5 dirs", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
