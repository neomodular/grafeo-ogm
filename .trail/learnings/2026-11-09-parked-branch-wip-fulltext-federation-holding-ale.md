---
title: "Parked branch wip/fulltext-federation holding rescued, unfinished fulltext-federation…"
author: Ale
date: 2026-11-09
id: l-827388c1
scope: repo
status: active
touches:
  - src/compilers/fulltext.compiler.ts
  - src/model.ts
  - src/schema/parser.ts
  - src/schema/types.ts
  - src/errors.ts
  - src/index.ts
  - src/generator/type-emitters/fulltext-emitter.ts
---

## Decided
There is an in-flight, unfinished **fulltext-federation** feature parked on branch `wip/fulltext-federation` (commit `35bafe0`, unsigned).

It was rescued on 2026-06-13 from a dead/locked agent worktree (`agent-a4fbb826f860d1436`, stale lock pid 92350 from May 2) whose working tree held ~5,383 lines of uncommitted changes that existed on no branch. The worktree has since been removed.

Scope of the WIP: modifications to `src/compilers/fulltext.compiler.ts`, `src/model.ts`, `src/schema/parser.ts`, `src/schema/types.ts`, `src/errors.ts`, `src/index.ts`, `src/generator/type-emitters/fulltext-emitter.ts`, plus new test suites (`tests/fulltext.compiler.federation*.spec.ts`, `tests/emitters/fulltext-emitter.federation.spec.ts`, `tests/integration/federation.spec.ts`, `tests/schema/federation-parser.spec.ts`, `tests/fulltext.compiler.regression.spec.ts`).

## Watch out
The branch is based on an ancient v1.7.0-beta.3 commit (`bb12888`). Before resuming, rebase onto current `main` (v1.11.0+) — expect conflicts. The rescue commit is just a state snapshot; the feature is incomplete and unverified. Relates to project-roadmap-v2.

_From Claude Code's memory of this repo, last updated Jun 13._
