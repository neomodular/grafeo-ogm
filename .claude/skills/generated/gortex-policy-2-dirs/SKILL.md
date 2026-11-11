---
name: gortex-policy-2-dirs
description: "Work in the policy +2 dirs area — 66 symbols across 17 files (82% cohesion)"
---

# policy +2 dirs

66 symbols | 17 files | 82% cohesion

## When to Use

Use this skill when working on files in:
- `src/interface-model.ts`
- `src/policy/resolver.ts`
- `src/policy/types.ts`
- `tests/policy/audit-metadata.spec.ts`
- `tests/policy/escape-hatch-logging.spec.ts`
- `tests/policy/identifier-injection.spec.ts`
- `tests/policy/interface-inheritance.spec.ts`
- `tests/policy/model-find.spec.ts`
- `tests/policy/model-mutation-connect-target.spec.ts`
- `tests/policy/model-mutation.spec.ts`
- `tests/policy/parameter-injection-attack.spec.ts`
- `tests/policy/permissive-abstain-default-deny.spec.ts`
- `tests/policy/plan-cache.spec.ts`
- `tests/policy/restrictive-read-write-split.spec.ts`
- `tests/policy/throw-vs-empty.spec.ts`
- `tests/policy/where-relationship-traversal.spec.ts`
- `tests/policy/with-context.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/interface-model.ts` | op, binding, resolved, resolveInterfacePolicy, unsafe |
| `src/policy/resolver.ts` | resolve, operations, list, matching, operationMatches, ... |
| `src/policy/types.ts` | Operation |
| `tests/policy/audit-metadata.spec.ts` | records, createMockDriver, session, Recorded |
| `tests/policy/escape-hatch-logging.spec.ts` | session, createMockDriver, records |
| `tests/policy/identifier-injection.spec.ts` | records, session, createMockDriver |
| `tests/policy/interface-inheritance.spec.ts` | session, createMockDriver, records |
| `tests/policy/model-find.spec.ts` | records, createMockDriver, session |
| `tests/policy/model-mutation-connect-target.spec.ts` | records, session, createMockDriver |
| `tests/policy/model-mutation.spec.ts` | records, session, createMockDriver |
| `tests/policy/parameter-injection-attack.spec.ts` | records, createMockDriver, session |
| `tests/policy/permissive-abstain-default-deny.spec.ts` | session, createMockDriver, records |
| `tests/policy/plan-cache.spec.ts` | createMockDriver, session, records |
| `tests/policy/restrictive-read-write-split.spec.ts` | session, createMockDriver, records |
| `tests/policy/throw-vs-empty.spec.ts` | records, session, createMockDriver |
| `tests/policy/where-relationship-traversal.spec.ts` | resolveForType, op, typeName |
| `tests/policy/with-context.spec.ts` | createMockDriver, session, records |

## Connected Communities

- **src +6 dirs** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-64"
smart_context with task: "understand policy +2 dirs", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
