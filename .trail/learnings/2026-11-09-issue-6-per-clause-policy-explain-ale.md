---
title: "Issue #6 per-clause policy explain"
author: Ale
date: 2026-11-09
id: l-4aad0adc
scope: repo
status: active
touches:
  - tests/policy/explain-refactor-golden.spec.ts
---

## Decided
GitHub issue #6 shipped in **v2.2.0** on 2026-09-23 as `Model.explainPolicies()`. It went out as 4 signed commits on main (`ee36949` refactor, `d02ad83` fix, `20f474c` feat with Closes #6, `1741962` release). npm `latest` is 2.2.0, with provenance. The OpenSpec change `add-policy-explain` (37/37) is still under `openspec/changes/` and has not been archived.

User decisions: a dedicated method, not a `find` flag. It is always available on policy-bound models, with a warn log and an audit tag. Full select, including relationships. v1 covers Model + `read` only.

**Why:** explain is a deliberate policy bypass. The non-negotiable is a single source of truth: explain reuses the enforcement path's compiled fragments and computes `visible` from the literal composed predicate, with a JS cross-check.

## Watch out
before touching the policy compile code, run the 17-case golden suite `tests/policy/explain-refactor-golden.spec.ts`. D7 invariant: `resolve()` never drops non-applying restrictives from `restrictives`; only `evaluated` is filtered. Follow-ups: InterfaceModel explain, count/aggregate, and the reporter's 62-clause corpus. The three pre-existing bypasses are tracked in project-nls-bypasses-2026-09.

_From Claude Code's memory of this repo, last updated Sep 23._
