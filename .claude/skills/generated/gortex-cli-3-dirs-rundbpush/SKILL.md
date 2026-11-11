---
name: gortex-cli-3-dirs-rundbpush
description: "Work in the cli +3 dirs · runDbPush area — 97 symbols across 12 files (81% cohesion)"
---

# cli +3 dirs · runDbPush

97 symbols | 12 files | 81% cohesion

## When to Use

Use this skill when working on files in:
- `src/cli/commands/db-push.ts`
- `src/cli/commands/db-seed.ts`
- `src/cli/config.ts`
- `src/cli/display.ts`
- `src/cli/driver.ts`
- `src/cli/introspect.ts`
- `src/cli/types.ts`
- `src/ogm.ts`
- `tests/cli/db-seed.spec.ts`
- `tests/cli/generate.spec.ts`
- `tests/cli/init.spec.ts`
- `tests/cli/logo.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/cli/commands/db-push.ts` | argv, io, message, plan, io, ... |
| `src/cli/commands/db-seed.ts` | parseDbSeedFlags, runDbSeed, io, flags, driver, ... |
| `src/cli/config.ts` | password, username, resolveConnection, uri, env, ... |
| `src/cli/display.ts` | value, safeDisplay |
| `src/cli/driver.ts` | io, connection, createDriver |
| `src/cli/introspect.ts` | fetchLiveSchema, session, database, driver, constraintsResult, ... |
| `src/cli/types.ts` | ResolvedConnection, CliIO |
| `src/ogm.ts` | init |
| `tests/cli/db-seed.spec.ts` | TestIO |
| `tests/cli/generate.spec.ts` | TestIO |
| `tests/cli/init.spec.ts` | TestIO |
| `tests/cli/logo.spec.ts` | stdout, opts, makeIO |

## Entry Points

- `src/cli/commands/db-push.ts::renderPlan`

## Connected Communities

- **cli · runGenerate** (2 cross-edges)
- **. +3 dirs · runInit** (2 cross-edges)
- **. +3 dirs · verifyOnce** (2 cross-edges)
- **schema +1 dirs · parseSchema** (1 cross-edges)
- **. +2 dirs** (1 cross-edges)
- **cli +3 dirs · join** (1 cross-edges)
- **cli +1 dirs** (1 cross-edges)
- **src +2 dirs · close** (1 cross-edges)
- **. +4 dirs** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-8"
smart_context with task: "understand cli +3 dirs · runDbPush", format: "gcx"
find_usages with id: "src/cli/commands/db-push.ts::renderPlan", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
