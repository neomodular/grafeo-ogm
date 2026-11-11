---
title: "Memgraph and ArcadeDB measured worse than desk research predicted, so no dialect work yet"
author: Ale
date: 2026-11-09
standing: true
id: l-11f1d9aa
scope: repo
status: active
src: init-sessions
---

## Tried and ruled out
- Running the live suite on both showed silent wrong results, such as unparseable datetimes on Memgraph and collapsed map projections on ArcadeDB. Memgraph's score fell from 7.95 to 7.18.
- In the code: Do not start a Memgraph or ArcadeDB dialect from the paper ranking. See the measured report at `scratchpad/research/compat-measured.md`, with pinned images memgraph-mage:3.14.0 and arcadedb:26.10.2. The blocker is that grafeo emits `RETURN n { … }` without an alias, which both engines name differently from Neo4j.

_From past Claude sessions here, Oct 24._
