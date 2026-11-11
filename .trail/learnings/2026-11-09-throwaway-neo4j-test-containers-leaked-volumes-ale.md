---
title: Throwaway Neo4j test containers leaked volumes until we always removed them with their data
author: Ale
date: 2026-11-09
standing: true
id: l-eda75efc
scope: repo
status: active
src: init-sessions
---

## Watch out
- Every test container the lanes ran left two anonymous volumes behind. 48 volumes, about 13 GB, pushed Docker to 97% full and made live test runs flaky.
- In the code: Run throwaway Neo4j containers with `docker run --rm` and remove them with `docker rm -v`. The neo4j image declares /data and /logs volumes. Never prune the host. The lane briefs forbid host cleanup.

_From past Claude sessions here, Oct 24._
