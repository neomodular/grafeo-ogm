---
title: Live database tests were silently skipped in CI and before every publish
author: Ale
date: 2026-11-09
standing: true
id: l-1ee1378e
scope: repo
status: active
src: init-review
touches:
  - ".github/workflows/live.yml"
  - scripts/ci/assert-live-suites-ran.cjs
---

## Watch out
- Every integration suite only runs when an env var is set, and CI never set them, so all of them skipped without failing. Releases went out untested against a real database.
- In the code: CI runs .github/workflows/live.yml (neo4j:5.26, APOC+GenAI) via `jest tests/integration --runInBand`; release.yml publish `needs: live`. scripts/ci/assert-live-suites-ran.cjs fails if any live test skips. New integration suites must be wired to an env gate that the guard checks.

_From PR #15 here, Oct 19._
