---
name: gortex-policy-1-dirs-permissive
description: "Work in the policy +1 dirs · permissive area — 146 symbols across 17 files (96% cohesion)"
---

# policy +1 dirs · permissive

146 symbols | 17 files | 96% cohesion

## When to Use

Use this skill when working on files in:
- `src/policy/types.ts`
- `tests/policy/audit-metadata.spec.ts`
- `tests/policy/byte-identical.spec.ts`
- `tests/policy/cypher-fragment.spec.ts`
- `tests/policy/escape-hatch-logging.spec.ts`
- `tests/policy/identifier-injection.spec.ts`
- `tests/policy/interface-inheritance.spec.ts`
- `tests/policy/model-find.spec.ts`
- `tests/policy/model-mutation-connect-target.spec.ts`
- `tests/policy/model-mutation.spec.ts`
- `tests/policy/nested-selection.spec.ts`
- `tests/policy/parameter-injection-attack.spec.ts`
- `tests/policy/resolver.spec.ts`
- `tests/policy/restrictive-read-write-split.spec.ts`
- `tests/policy/where-injection.spec.ts`
- `tests/policy/where-relationship-traversal.spec.ts`
- `tests/policy/with-context.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/policy/types.ts` | W, permissive, spec, C |
| `tests/policy/audit-metadata.spec.ts` | Book.when, Book.when, Book.when, Book.when, Book.when, ... |
| `tests/policy/byte-identical.spec.ts` | Book.when, Book.when |
| `tests/policy/cypher-fragment.spec.ts` | permissives.when, permissives.when, permissives.when |
| `tests/policy/escape-hatch-logging.spec.ts` | Book.when, Book.when, Book.when, Book.when |
| `tests/policy/identifier-injection.spec.ts` | Book.when |
| `tests/policy/interface-inheritance.spec.ts` | Book.when, Resource.when, Book.when, Resource.when, Article.when, ... |
| `tests/policy/model-find.spec.ts` | Doc.when, Book.when, Book.when, Book.when, Book.when, ... |
| `tests/policy/model-mutation-connect-target.spec.ts` | User.when, policyOgm, User.when, recorded |
| `tests/policy/model-mutation.spec.ts` | Book.when, Book.when, Book.when, Book.when, Book.when, ... |
| `tests/policy/nested-selection.spec.ts` | op, typeName, typeName, typeName, policyContext.resolveForType, ... |
| `tests/policy/parameter-injection-attack.spec.ts` | Book.when |
| `tests/policy/resolver.spec.ts` | Book.when, Book.when, Book.when, Book.when, Resource.when, ... |
| `tests/policy/restrictive-read-write-split.spec.ts` | Book.when, Book.when, Book.when, Book.when, Book.when, ... |
| `tests/policy/where-injection.spec.ts` | permissives.when, permissives.when, permissives.when, permissives.when, permissives.when, ... |
| `tests/policy/where-relationship-traversal.spec.ts` | typeName, permissives.when, policyContext.resolveForType |
| `tests/policy/with-context.spec.ts` | Book.when |

## Connected Communities

- **policy +1 dirs · override** (2 cross-edges)
- **policy +1 dirs · restrictive** (1 cross-edges)
- **policy +2 dirs** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-174"
smart_context with task: "understand policy +1 dirs · permissive", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
