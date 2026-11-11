---
title: "Behavior changes that could break users ship only under strict mode, with default mode unchanged"
author: Ale
date: 2026-11-09
standing: true
id: l-e3d6dc1f
scope: repo
status: active
src: init-sessions
---

## Decided
- Fixes that change results, such as paged sorting order for ties or a bare model() call on an OGM with policies, were added as numbered strict items. Default mode keeps its old behavior and only warns.
- In the code: Add new behavior changes as strict items in the strict-mode docs and tests, in numbered order. Default mode must stay byte-identical and warn. Bigger breaking changes go into the 3.0 plan doc instead of 2.x.

_From past Claude sessions here, Oct 24._
