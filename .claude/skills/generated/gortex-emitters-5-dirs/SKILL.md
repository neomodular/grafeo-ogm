---
name: gortex-emitters-5-dirs
description: "Work in the emitters +5 dirs area — 87 symbols across 16 files (64% cohesion)"
---

# emitters +5 dirs

87 symbols | 16 files | 64% cohesion

## When to Use

Use this skill when working on files in:
- `src/compilers/mutation.compiler.ts`
- `src/generator/type-emitters/input-emitter.ts`
- `src/schema/types.ts`
- `src/schema/utils.ts`
- `tests/emitters/aggregation-emitter.spec.ts`
- `tests/emitters/enum-emitter.spec.ts`
- `tests/emitters/fulltext-emitter.spec.ts`
- `tests/emitters/input-emitter.spec.ts`
- `tests/emitters/node-type-emitter.spec.ts`
- `tests/emitters/select-fields-emitter.spec.ts`
- `tests/emitters/vector-emitter.spec.ts`
- `tests/emitters/where-emitter.spec.ts`
- `tests/error-paths.spec.ts`
- `tests/fulltext-advanced.spec.ts`
- `tests/policy/resolver.spec.ts`
- `tests/security.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/compilers/mutation.compiler.ts` | schema, options, constructor |
| `src/generator/type-emitters/input-emitter.ts` | schema, prefix, blocks, members, sorted, ... |
| `src/schema/types.ts` | SchemaMetadata |
| `src/schema/utils.ts` | BuildRelPatternOptions |
| `tests/emitters/aggregation-emitter.spec.ts` | overrides, makeSchema |
| `tests/emitters/enum-emitter.spec.ts` | makeSchema, enums |
| `tests/emitters/fulltext-emitter.spec.ts` | relationshipProperties, makeSchema, nodes |
| `tests/emitters/input-emitter.spec.ts` | makeSchema, overrides |
| `tests/emitters/node-type-emitter.spec.ts` | nodes, overrides, makeSchema |
| `tests/emitters/select-fields-emitter.spec.ts` | nodes, extras, makeSchema |
| `tests/emitters/vector-emitter.spec.ts` | makeSchema, nodes |
| `tests/emitters/where-emitter.spec.ts` | nodes, extras, makeSchema |
| `tests/error-paths.spec.ts` | nodes, createSchema |
| `tests/fulltext-advanced.spec.ts` | nodeDef, createMockSchema, relProps |
| `tests/policy/resolver.spec.ts` | n, i, makeSchema, interfaces, nodes, ... |
| `tests/security.spec.ts` | overrides, makeSchema |

## Connected Communities

- **tests +4 dirs · RelationshipDefinition** (5 cross-edges)
- **generator/type-emitters · emitUnionRelUpdateFieldInput** (2 cross-edges)

## How to Explore

```
get_communities with id: "community-33"
smart_context with task: "understand emitters +5 dirs", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
