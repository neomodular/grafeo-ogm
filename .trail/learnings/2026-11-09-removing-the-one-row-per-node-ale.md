---
title: Removing the one-row-per-node wrapper queries was rejected because it gained almost nothing
author: Ale
date: 2026-11-09
standing: true
id: l-0891f2a5
scope: repo
status: active
src: init-sessions
---

## Tried and ruled out
- A performance investigation found the generated queries are already lean on Neo4j Community's slotted runtime. Removing the CALL and count wrappers saved under 10%, and those wrappers protect result cardinality.
- In the code: Do not strip the `CALL { … RETURN count(*) }` wrappers in the compilers to speed things up. Real wins were elsewhere: multi-input create planning and computing @cypher fields only for the returned page. Benchmark with the harness in `bench/live/` on neo4j:5.26 Community.

_From past Claude sessions here, Oct 24._
