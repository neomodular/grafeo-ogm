---
title: "Fixes ship as one release per batch, with security fixes split into their own patch"
author: Ale
date: 2026-11-09
standing: true
id: l-bd0d4175
scope: repo
status: active
src: init-sessions
touches:
  - package.json
---

## Decided
- Bug batches go out as grouped releases. A security fix found inside a feature lane was pulled out and shipped alone as a patch, with a draft advisory, before the rest.
- In the code: Code comments use a `vNEXT` placeholder until release, then get relabeled to the version. Release flow: full gate (mock + live with APOC), signed commit and tag, CHANGELOG and package.json bump, then a GitHub Release. Security fixes go as patch releases first, plus a GHSA advisory and a CVE request.

_From past Claude sessions here, Oct 24._
