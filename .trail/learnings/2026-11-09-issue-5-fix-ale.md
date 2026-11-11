---
title: "Issue #5 fix"
author: Ale
date: 2026-11-09
id: l-a43ecc03
scope: repo
status: active
touches:
  - src/utils/write-coercion.ts
---

## Decided
Fixed GitHub issue #5 (2026-08-13): mutation compiler bound raw JS numbers, and neo4j-driver packs EVERY JS `number` as Bolt FLOAT64 (verified in 5.28.3 packstream — `disableLosslessIntegers` is read-side only), so OGM-written `Int`/`BigInt` fields landed as Doubles; mixed Long/Double populations crash `apoc.coll.sortMulti`.

Fix: `coerceWriteValue()` in `src/utils/write-coercion.ts`, applied at all **14** binding sites in `mutation.compiler.ts` (issue listed only 5 — the nested create/connect edge-prop loops and the UNWIND list params in `compileCreateMany`/`buildConnects` are the easy-to-miss ones), plus `getEdgePropDef()` for edge-prop types via `schema.relationshipProperties`.

Behavior notes for the next release (v1-14-0-security-release precedent):
- Non-integral number for an Int/BigInt field now **throws OGMError** instead of silently storing a Double — breaking-ish, needs a release note.
- WHERE params intentionally NOT coerced (Cypher numeric equality is cross-type).
- Jest tip: neo4j Integer own props are only `{low, high}`, so `toMatchObject`/`toHaveProperty` with `neo4j.int(n)` works.

Changes left uncommitted; suite 1687/1687 green.

_From Claude Code's memory of this repo, last updated Aug 13._
