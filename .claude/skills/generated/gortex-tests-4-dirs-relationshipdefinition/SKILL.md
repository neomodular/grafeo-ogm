---
name: gortex-tests-4-dirs-relationshipdefinition
description: "Work in the tests +4 dirs · RelationshipDefinition area — 238 symbols across 26 files (86% cohesion)"
---

# tests +4 dirs · RelationshipDefinition

238 symbols | 26 files | 86% cohesion

## When to Use

Use this skill when working on files in:
- `bench/fixtures.ts`
- `src/generator/type-emitters/aggregation-emitter.ts`
- `src/generator/type-emitters/connection-emitter.ts`
- `src/generator/type-emitters/helpers.ts`
- `src/generator/type-emitters/input-emitter.ts`
- `src/generator/type-emitters/interface-emitter.ts`
- `src/generator/type-emitters/node-type-emitter.ts`
- `src/generator/type-emitters/select-fields-emitter.ts`
- `src/schema/types.ts`
- `tests/edge-cases.spec.ts`
- `tests/emitters/connection-emitter.spec.ts`
- `tests/emitters/fulltext-emitter.spec.ts`
- `tests/emitters/input-emitter.spec.ts`
- `tests/emitters/interface-emitter.spec.ts`
- `tests/emitters/node-type-emitter.spec.ts`
- `tests/emitters/select-fields-emitter.spec.ts`
- `tests/emitters/where-emitter.spec.ts`
- `tests/model.cypher-fields.spec.ts`
- `tests/model.spec.ts`
- `tests/multi-label.spec.ts`
- `tests/mutation.compiler.spec.ts`
- `tests/selection.compiler.cypher-fields.spec.ts`
- `tests/tier1-features.spec.ts`
- `tests/tier2-features.spec.ts`
- `tests/where.compiler.cypher-fields.spec.ts`
- `tests/where.compiler.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `bench/fixtures.ts` | overrides, target, rel, type, fieldName |
| `src/generator/type-emitters/aggregation-emitter.ts` | parent, emitRelationshipAggregateInput, lines, lines, typeName, ... |
| `src/generator/type-emitters/connection-emitter.ts` | pascalField, _members, sortedRels, rel, connectionName, ... |
| `src/generator/type-emitters/helpers.ts` | fieldName, toPascalCase |
| `src/generator/type-emitters/input-emitter.ts` | emitUpdateFieldInput, prefix, members, m, pascal, ... |
| `src/generator/type-emitters/interface-emitter.ts` | rel, pascalField, emitConnectionField, connectionType, interfaceName |
| `src/generator/type-emitters/node-type-emitter.ts` | pascalField, typeName, pascalField, typeName, connectionType, ... |
| `src/generator/type-emitters/select-fields-emitter.ts` | rel, buildEdgeSelectFieldsName, ownerTypeName |
| `src/schema/types.ts` | RelationshipDefinition |
| `tests/edge-cases.spec.ts` | makeRelDef, overrides |
| `tests/emitters/connection-emitter.spec.ts` | overrides, makeRel |
| `tests/emitters/fulltext-emitter.spec.ts` | propertiesType, fieldName, makeRel, target |
| `tests/emitters/input-emitter.spec.ts` | makeRel, overrides |
| `tests/emitters/interface-emitter.spec.ts` | makeRel, target, overrides, fieldName |
| `tests/emitters/node-type-emitter.spec.ts` | fieldName, overrides, target, makeRel |
| `tests/emitters/select-fields-emitter.spec.ts` | overrides, makeRel |
| `tests/emitters/where-emitter.spec.ts` | overrides, makeRel |
| `tests/model.cypher-fields.spec.ts` | overrides, target, rel, type, fieldName |
| `tests/model.spec.ts` | type, overrides, rel, target, fieldName |
| `tests/multi-label.spec.ts` | target, fieldName, type, rel, overrides |
| `tests/mutation.compiler.spec.ts` | target, overrides, rel, fieldName, type |
| `tests/selection.compiler.cypher-fields.spec.ts` | makeRelDef, overrides |
| `tests/tier1-features.spec.ts` | fieldName, type, rel, target, overrides |
| `tests/tier2-features.spec.ts` | type, rel, overrides, target, fieldName |
| `tests/where.compiler.cypher-fields.spec.ts` | overrides, makeRelDef |
| `tests/where.compiler.spec.ts` | makeRelDef, overrides |

## Entry Points

- `src/generator/type-emitters/connection-emitter.ts::emitInterfaceConnectionWhere`
- `src/generator/type-emitters/connection-emitter.ts::emitUnionConnectionWheres`
- `src/generator/type-emitters/input-emitter.ts::emitUpdateFieldInput`

## How to Explore

```
get_communities with id: "community-25"
smart_context with task: "understand tests +4 dirs · RelationshipDefinition", format: "gcx"
find_usages with id: "src/generator/type-emitters/connection-emitter.ts::emitInterfaceConnectionWhere", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
