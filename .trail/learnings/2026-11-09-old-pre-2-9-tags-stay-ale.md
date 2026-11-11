---
title: "Old pre-2.9 tags stay without GitHub Releases, and new releases always get one"
author: Ale
date: 2026-11-09
standing: true
id: l-33f28778
scope: repo
status: active
src: init-sessions
---

## Decided
- 75 old tags had no release and the backlog was offered for backfill. The team chose to leave them and only create releases going forward.
- In the code: Do not offer to backfill GitHub Releases for tags v1.0.0 to v2.9.0. Every new tag gets `gh release create`. Security patches use `--latest=false` when a newer feature release is the latest.

_From past Claude sessions here, Oct 24._
