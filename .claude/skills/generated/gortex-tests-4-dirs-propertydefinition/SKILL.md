---
name: gortex-tests-4-dirs-propertydefinition
description: "Work in the tests +4 dirs · PropertyDefinition area — 133 symbols across 29 files (89% cohesion)"
---

# tests +4 dirs · PropertyDefinition

133 symbols | 29 files | 89% cohesion

## When to Use

Use this skill when working on files in:
- `bench/fixtures.ts`
- `src/schema/types.ts`
- `tests/cypher-field-projection.spec.ts`
- `tests/cypher-sort-projection.spec.ts`
- `tests/edge-cases.spec.ts`
- `tests/emitters/aggregation-emitter.spec.ts`
- `tests/emitters/connection-emitter.spec.ts`
- `tests/emitters/input-emitter.spec.ts`
- `tests/emitters/interface-emitter.spec.ts`
- `tests/emitters/node-type-emitter.spec.ts`
- `tests/emitters/select-fields-emitter.spec.ts`
- `tests/emitters/sort-options-emitter.spec.ts`
- `tests/emitters/where-emitter.spec.ts`
- `tests/error-paths.spec.ts`
- `tests/interface-model.cypher-fields.spec.ts`
- `tests/interface-model.spec.ts`
- `tests/model.cypher-fields.spec.ts`
- `tests/model.spec.ts`
- `tests/multi-label.spec.ts`
- `tests/mutation.compiler.spec.ts`
- `tests/policy/cypher-fragment.spec.ts`
- `tests/policy/nested-selection.spec.ts`
- `tests/policy/where-injection.spec.ts`
- `tests/policy/where-relationship-traversal.spec.ts`
- `tests/selection.compiler.cypher-fields.spec.ts`
- `tests/sort-entry-arity.spec.ts`
- `tests/tier1-features.spec.ts`
- `tests/tier2-features.spec.ts`
- `tests/where.compiler.cypher-fields.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `bench/fixtures.ts` | overrides, name, prop, type, rels, ... |
| `src/schema/types.ts` | PropertyDefinition |
| `tests/cypher-field-projection.spec.ts` | columnName, name, cypherProp, statement |
| `tests/cypher-sort-projection.spec.ts` | statement, cypherProp, result.propertyLookup, name, type, ... |
| `tests/edge-cases.spec.ts` | makeProp, overrides |
| `tests/emitters/aggregation-emitter.spec.ts` | makeProp, overrides, name |
| `tests/emitters/connection-emitter.spec.ts` | name, makeProp, typeName, props, rels, ... |
| `tests/emitters/input-emitter.spec.ts` | makeNodeDef, typeName, props, name, rels, ... |
| `tests/emitters/interface-emitter.spec.ts` | makeProp, overrides, name |
| `tests/emitters/node-type-emitter.spec.ts` | makeProp, overrides, name |
| `tests/emitters/select-fields-emitter.spec.ts` | props, makeProp, type, typeName, makeNodeDef, ... |
| `tests/emitters/sort-options-emitter.spec.ts` | props, overrides, name, type, makeNode, ... |
| `tests/emitters/where-emitter.spec.ts` | makeProp, type, overrides, name |
| `tests/error-paths.spec.ts` | overrides, name, prop |
| `tests/interface-model.cypher-fields.spec.ts` | props, cypherProp, statement, type, storedProp, ... |
| `tests/interface-model.spec.ts` | prop, overrides, name |
| `tests/model.cypher-fields.spec.ts` | props, typeName, rels, prop, nodeDef, ... |
| `tests/model.spec.ts` | overrides, name, prop |
| `tests/multi-label.spec.ts` | overrides, name, prop |
| `tests/mutation.compiler.spec.ts` | name, prop, overrides |
| `tests/policy/cypher-fragment.spec.ts` | over, name, prop |
| `tests/policy/nested-selection.spec.ts` | name, over, prop |
| `tests/policy/where-injection.spec.ts` | prop, over |
| `tests/policy/where-relationship-traversal.spec.ts` | over, prop |
| `tests/selection.compiler.cypher-fields.spec.ts` | type, overrides, cypherProp, name, columnName, ... |
| `tests/sort-entry-arity.spec.ts` | name, overrides, prop |
| `tests/tier1-features.spec.ts` | name, overrides, prop |
| `tests/tier2-features.spec.ts` | prop, overrides, name |
| `tests/where.compiler.cypher-fields.spec.ts` | overrides, type, statement, columnName, storedProp, ... |

## How to Explore

```
get_communities with id: "community-112"
smart_context with task: "understand tests +4 dirs · PropertyDefinition", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
