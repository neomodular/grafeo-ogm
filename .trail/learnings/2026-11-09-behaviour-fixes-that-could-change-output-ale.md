---
title: "Behaviour fixes that could change output ship behind an opt-in strict flag, warning once by default"
author: Ale
date: 2026-11-09
standing: true
id: l-b42df486
scope: repo
status: active
src: init-review
---

## Decided
- Fixes that change generated queries were gated so existing users see no change. Default mode warns once and strict mode applies the fix; strict becomes the default in 3.0.
- In the code: When fixing a behaviour that changes compiled Cypher, gate it on `strict: true` and emit a one-time deprecation warning in default mode. Default-mode Cypher must stay byte-identical to the previous release. Pure crashes or security bugs are fixed in both modes.

_From PRs #27, #18 here, Oct 19._
