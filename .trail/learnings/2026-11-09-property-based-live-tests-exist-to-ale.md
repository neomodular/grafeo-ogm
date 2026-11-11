---
title: Property-based live tests exist to catch compiler bugs; known findings are excluded by ID
author: Ale
date: 2026-11-09
standing: true
id: l-63fbdad2
scope: repo
status: active
src: init-review
---

## Decided
- Six fast-check properties were shown to catch earlier real regressions (a security bug and an interface-delete regression). Known unfixed findings are filtered at the generator so the suite stays green.
- In the code: Properties live in tests/integration/properties/ (valid Cypher, row cardinality, write scope, policy containment, allow-all equivalence, round-trip). Exclude known findings in the generator with their finding ID rather than weakening the property.

_From PR #19 here, Oct 19._
