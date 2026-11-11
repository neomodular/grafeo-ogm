---
title: "Full test gate needs a fresh database container, since a dead one looks like code failures"
author: Ale
date: 2026-11-09
standing: true
id: l-76274120
scope: repo
status: active
src: init-sessions
---

## Watch out
- A security patch failed its live suite with many 'Failed to connect' errors. The verification container had died partway through the run, and a fresh container passed everything.
- In the code: If many live tests fail with 'Failed to connect to server', check `docker ps` and the container logs first. Rerun on a fresh APOC container before blaming the code. Keep Docker disk free, because low disk is what kills containers.

_From past Claude sessions here, Oct 24._
