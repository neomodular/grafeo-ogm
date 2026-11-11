---
title: "Access policies must hold for every matching label, not first match"
author: Ale
date: 2026-11-09
standing: true
id: l-4df96f37
scope: repo
status: active
src: init-review
---

## Watch out
- A node carrying two implementer labels was authorised by whichever policy matched first, a security hole. Likewise upsert and mutation responses skipped row filters and read policies.
- In the code: Multi-label policy CASE must require every member's policy to pass. Upsert applies the update row filter to a matched node, and mutation responses apply the root read policy. Keep policy-free Cypher unchanged.

_From PRs #20, #17 here, Oct 19._
