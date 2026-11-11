---
name: gortex-schema-1-dirs-parseschema
description: "Work in the schema +1 dirs · parseSchema area — 106 symbols across 3 files (92% cohesion)"
---

# schema +1 dirs · parseSchema

106 symbols | 3 files | 92% cohesion

## When to Use

Use this skill when working on files in:
- `src/schema/parser.ts`
- `src/schema/types.ts`
- `tests/emitters/fulltext-emitter.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/schema/parser.ts` | node, prop, current, getDirectiveArgStringValue, document, ... |
| `src/schema/types.ts` | FulltextIndex, RelationshipPropertiesDefinition |
| `tests/emitters/fulltext-emitter.spec.ts` | makeRelProps, typeName, fulltextIndexes |

## Connected Communities

- **examples +3 dirs** (3 cross-edges)
- **schema +1 dirs · parseVectorIndexes** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-69"
smart_context with task: "understand schema +1 dirs · parseSchema", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
