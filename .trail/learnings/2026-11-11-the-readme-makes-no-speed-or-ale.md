---
title: "The README makes no speed or row-count claim against the old Neo4j OGM, because it was never true"
author: Ale
date: 2026-11-11
branch: main
cost: { minutes: 1, tokens: 16739 }
id: l-58c403f9
scope: repo
status: active
src: agent
touches:
  - README.md
---

## Decided
The README no longer says the deprecated @neo4j/graphql-ogm built reads from chained OPTIONAL MATCH with Cartesian products, and the "150x fewer rows" table is gone. The old OGM also returns one row per node: upstream v5 uses a CALL { ... RETURN collect(...) } subquery per relationship (its TCK projection tests show this), and v1-v3 used pattern comprehensions. The "why switch" table now leads with a claim that was checked: the old OGM peer-depends on neo4j-driver ^5.8.0, so it cannot move to driver 6, and grafeo supports 5 and 6.

## Tried and ruled out
- Rewording the 150x section into a softer comparison: there is no row-count difference to compare, so any number would still be false.

## Watch out
- Check every "the old OGM did X" claim against upstream source or `npm view @neo4j/graphql-ogm` before it goes into docs or posts. The empty `OR: []` full-label-wipe claim IS true and is kept.
- The other rows of the "Why grafeo-ogm?" table ("no identifier validation", "monolithic multi-MB output") have not been checked against upstream yet.

In the code: README.md "Why grafeo-ogm?" table and "Relationship Projections" section; commit 143be15.
