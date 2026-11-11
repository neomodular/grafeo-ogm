---
title: "Issue #7 (WITH before @cypher CALL after writes) fixed but uncommitted as of 2026-10-18"
author: Ale
date: 2026-11-09
id: l-ee259fe4
scope: repo
status: active
touches:
  - src/model.ts
  - tests/integration/mutation-cypher-projection.spec.ts
  - tests/integration/mutation-row-cardinality.spec.ts
---

## Decided
Issue #7: `stitchMutationProjection` in src/model.ts now emits `WITH n` before `@cypher` CALL preludes in create, update and upsert. It is covered by unit tests and by the live suite `tests/integration/mutation-cypher-projection.spec.ts`. Without the fix, all 7 live tests fail on 5.26.32, and with it they pass. SHIPPED as v2.3.1 on 2026-10-18 (commit e7d51cd; #7 closed).

#8 SHIPPED as v2.3.2 on 2026-10-18: disconnects are now wrapped in `CALL { … RETURN count(*) AS _<relVar> }`. The live suite is `tests/integration/mutation-row-cardinality.spec.ts`. Note: Docker Desktop quits on its own between turns. Check `docker info`, then run `docker start grafeo-live-526`.

#10 SHIPPED as v2.3.3 on 2026-10-18. A top-level connect (both the UNWIND path and the single path) is now wrapped in `CALL { … RETURN count(*) AS _conn_<field> }`, and a missing target is a no-op. That matches upstream, which I verified from the @neo4j/graphql 5.12.15 tarball (create-connect-and-params.js uses CALL+OPTIONAL MATCH+collect).

SHIPPED on 2026-10-18:
- v2.3.4: #11 fulltext AND, plus a newly found NOT bug. Both use an uncorrelated inner CALL through the `joinBranchOn` helper.
- v2.3.5: #12 multi-create (`WITH [n,n_1..] AS __created UNWIND`).
- v2.3.6: #13 genai encode, now evaluated in a WITH. Proven on `neo4j:5.26` with `NEO4J_PLUGINS=["genai"]`: an empty providerConfig fails locally with "'token' is expected", with no network call.
…

## Watch out
re-run the repro scripts against a 5.26 container before fixing. Never use the port-7687 work DB.

_From Claude Code's memory of this repo, last updated Oct 18._
