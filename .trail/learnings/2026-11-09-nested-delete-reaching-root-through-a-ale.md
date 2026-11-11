---
title: "Nested delete reaching root through a cycle is retried once, only when we own the transaction"
author: Ale
date: 2026-11-09
standing: true
id: l-0692aaf9
scope: repo
status: active
src: init-review
---

## Decided
- The Cypher for such a delete can fail with EntityNotFound. The OGM re-runs once when it owns the transaction, but cannot safely retry inside a caller's transaction.
- In the code: In a caller-owned transaction the error is still thrown with a one-time warning. The first attempt keeps the 2.7.0 Cypher; strict mode adds a compile-time guard.

_From PR #27 here, Oct 19._
