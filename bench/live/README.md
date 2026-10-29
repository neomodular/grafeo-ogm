# Live Cypher performance harness

Server-side measurements of the Cypher the compilers emit, on a real Neo4j
(the in-process `pnpm run bench` suite only times compilation). Not part of
the published package (`package.json` `files`), of `pnpm run lint` or of the
`src` typecheck; `npx tsc --noEmit -p bench/tsconfig.json` checks it.

Use a **throwaway container** on a non-default port, never a database you
care about. `seed.ts` deletes every `Pf*`-labelled node before seeding.

## 1. Container

Neo4j Community runs the slotted runtime (pipelined is Enterprise-only).
APOC is needed for the nested-sort shapes.

```bash
docker run -d --name grafeo-perf -p 17733:7687 \
  -e NEO4J_AUTH=neo4j/livetest-pw-526 -e 'NEO4J_PLUGINS=["apoc"]' \
  -e NEO4J_server_memory_heap_max__size=2G neo4j:5.26
```

Every script reads `NEO4J_URI` (default `bolt://localhost:17733`) and
`NEO4J_PASSWORD` (default `livetest-pw-526`).

## 2. Seed

```bash
npx ts-node -T bench/live/seed.ts
```

10k `PfUser` in fan-out buckets (100 users with 100 posts, 900 with 10, 9000
with 1 → 28k `PfPost`), 1k `PfTag` (84k edges with a `weight` property), 28k
`PfComment`, 1k `PfNote`, and a unique constraint per `@unique` (as
`grafeo db push` creates them). `SCALE=2` doubles the users. Schema and seed
statements: `schema.ts`.

## 3. Run: one tree, every shape

```bash
RUNS=15 npx ts-node -T bench/live/run.ts [nameFilter] [--print]
```

For each shape in `shapes.ts` the OGM call runs inside a rolled-back
transaction that captures the statements it sends. Each statement is then
re-run in fresh rolled-back transactions with `CYPHER runtime=slotted`:
`PROFILE` for db hits / rows / `GlobalMemory`, `RUNS` warm runs for the median
time, and one cache-busted run (`cold`, plan + run). `--print` dumps the
Cypher and params; `OUT=file.json` writes rows, Cypher and results.

## 4. A/B: two source trees, interleaved

```bash
git worktree add --detach /tmp/base <ref>
ln -s "$PWD/node_modules" /tmp/base/node_modules
BASE_SRC=/tmp/base/src RUNS=21 COLD=7 npx ts-node -T bench/live/ab.ts [nameFilter]
git worktree remove --force /tmp/base
```

For each shape: whether the Cypher changed, whether both trees return
identical rows, db hits, memory, median warm ms and median cold ms, with the A
and B runs alternated so host noise hits both. `PRINT=1` prints both
statements when they differ. Absolute times are noisy on a shared host; db
hits and memory are exact.

## 5. Clean up

```bash
docker rm -f grafeo-perf
```
