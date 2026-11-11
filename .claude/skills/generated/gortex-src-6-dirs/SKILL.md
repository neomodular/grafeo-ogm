---
name: gortex-src-6-dirs
description: "Work in the src +6 dirs area — 132 symbols across 11 files (77% cohesion)"
---

# src +6 dirs

132 symbols | 11 files | 77% cohesion

## When to Use

Use this skill when working on files in:
- `bench/policy.bench.ts`
- `src/compilers/where.compiler.ts`
- `src/execution/executor.ts`
- `src/interface-model.ts`
- `src/model.ts`
- `src/ogm.ts`
- `src/policy/resolver.ts`
- `src/policy/types.ts`
- `src/subgraph/subgraph-operations.ts`
- `tests/policy/resolver.spec.ts`
- `tests/policy/with-context.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `bench/policy.bench.ts` | c, c, cypher.params, c, c, ... |
| `src/compilers/where.compiler.ts` | schema, constructor, options, WhereCompilerOptions |
| `src/execution/executor.ts` | NOOP_LOGGER.debug, OGMLogger |
| `src/interface-model.ts` | InterfaceModelCompilers |
| `src/model.ts` | logger, nodeDef, driver, policyBinding, MutationCompilers, ... |
| `src/ogm.ts` | config, policyResolver, model, registry, policyDefaults, ... |
| `src/policy/resolver.ts` | constructor, ifacePolicies, own, PolicyResolver, ifaceName, ... |
| `src/policy/types.ts` | RestrictivePolicy, PoliciesByModel, WriteRestrictivePolicy, ResolvedPolicies, ReadOperation, ... |
| `src/subgraph/subgraph-operations.ts` | logger, logger, NOOP_LOGGER.debug |
| `tests/policy/resolver.spec.ts` | buildResolver, schema, map, v, k, ... |
| `tests/policy/with-context.spec.ts` | buildWrapper, ogm |

## Entry Points

- `src/ogm.ts::OGM.constructor`

## Connected Communities

- **src +3 dirs · aggregate** (1 cross-edges)
- **schema +1 dirs · parseSchema** (1 cross-edges)
- **utils +1 dirs · cloneAndFreeze** (1 cross-edges)
- **policy +1 dirs · permissive** (1 cross-edges)
- **policy +2 dirs** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-58"
smart_context with task: "understand src +6 dirs", format: "gcx"
find_usages with id: "src/ogm.ts::OGM.constructor", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
