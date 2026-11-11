---
title: "Security fixes that change results for users without policies ship as a minor, not a patch"
author: Ale
date: 2026-11-11
branch: main
cost: { minutes: 16, tokens: 175043 }
id: l-831dae0a
scope: repo
status: active
src: agent
touches:
  - CHANGELOG.md
  - package.json
  - tests/integration/connect-fast-path-coercion.spec.ts
  - tests/integration/write-regressions.spec.ts
  - tests/interface-model.spec.ts
  - README.md
  - src/utils/validation.ts
  - tests/integration/where-matches-astral.spec.ts
  - tests/redos-guard.spec.ts
  - src/compilers/fulltext.compiler.ts
---

## Decided
The 2.29.0 audit batch (two node-level security bypasses, a `_MATCHES` ReDoS guard bypass, and a where key named `mode` being dropped) shipped as one minor release with a "Behavior changes" section and one draft security advisory covering the three security issues.
The deciding fact: the relationship-fulltext fix changes results for users WITHOUT policies too (a match must be on the field's own relationship type and reach the target label), so it is not a pure security tightening.

## Tried and ruled out
- A patch (2.28.1): the security-patch exception is meant for fixes that only tighten security. Fixes that change what non-policy callers get back follow the normal rule: minor, with "Behavior changes".
- One advisory per issue (the earlier pattern): the issues were found and fixed together, so they share one advisory.

## Watch out
- When a security fix touches a compile path that every user hits (not just policy users), check whether its Cypher or results change without policies before choosing patch vs minor.

In the code: CHANGELOG 2.29.0 section; advisory GHSA-q35w-x34v-x342 (draft); tag v2.29.0.
