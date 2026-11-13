---
title: "Every README code example must compile, and we extend the sample schema rather than skip examples"
author: Ale
date: 2026-11-13
branch: main
cost: { minutes: 55, tokens: 200031 }
id: l-83607c61
scope: repo
status: active
src: agent
touches:
  - CHANGELOG.md
  - package.json
  - README.md
  - src/ogm.ts
  - src/policy/resolver.ts
  - src/policy/types.ts
  - src/testing/compile-only.ts
  - tests/policy/model-find.spec.ts
  - tests/policy/plan-cache.spec.ts
  - tests/policy/typed-context.typecheck.spec.ts
---

## Decided
README and llms-full TypeScript examples are compiled in CI against the real library and generated types. When an example uses a model or field the sample schema lacks, extend the sample schema or shared setup instead of rewriting or skipping the example. Examples meant to show a type error carry `@ts-expect-error`, so CI proves the error still exists. Pseudo-code with `...` placeholders is turned into real code. The first pass ended with zero skips.

## Tried and ruled out
Casts (`as any`, `as never`) in examples: a doc example must be code a reader can paste. Skipping blocks wholesale: it hid real doc bugs, such as `'ASC'` and `'PUBLISHED'` strings where the generated types are enums.

## Watch out
The check found a real API gap, not just doc typos: policy callbacks could not be typed with your own context, so `when: (c: RequestCtx) => …` never compiled. That became the third OGM generic in v2.31.0. Treat a failing example as a possible library bug before "fixing" the doc.

In the code:
- `pnpm run docs:typecheck` (scripts/docs/typecheck-examples.mjs), CI step in the test job
- sample schema and shared setup: scripts/docs/examples/schema.graphql, scripts/docs/examples/prelude.ts
- opt-out: `<!-- typecheck: skip — reason -->` on the line before the fence; the reason is required
