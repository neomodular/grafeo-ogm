# Proposal: add-grafeo-cli

## Why

grafeo-ogm's code generation is library-only: users must hand-write a script that imports `generateTypes()` and wire it into their build. Schema synchronization (`assertIndexesAndConstraints()`) is create-only with no visibility into what it will do, and there is no seeding convention at all. This is the single biggest "feels less polished than Prisma" friction for new adopters — every comparable tool (Prisma, Drizzle, Kysely) ships a CLI, and a CLI is the prerequisite for the rest of the v1.9 roadmap (typed Cypher files, `--verify` CI gates, future `db pull`).

## What Changes

- New `grafeo` binary (`"bin"` entry in package.json) implemented under `src/cli/`, wrapping existing library machinery — the CLI is plumbing, not new compilation logic.
- `grafeo generate` — runs the existing `generateTypes()` from a config file or flags; `--watch` re-runs on schema change; `--verify` exits non-zero when the generated file on disk is stale (CI gate, no write).
- `grafeo db push` — diffs the SDL-declared constraints/indexes (`@id`/`@unique`/`@fulltext`/`@vector`) against the live database (`SHOW CONSTRAINTS` / `SHOW INDEXES`), prints a plan, applies it. `--dry-run` prints the plan only. Additive by default; destructive operations (dropping orphans) require an explicit `--force-drop` flag.
- `grafeo db seed` — runs the project's seed script (`grafeo.config.ts` `seed` entry or `seed.ts` convention) with a constructed OGM instance.
- New `grafeo.config.ts` (with `.js`/`.json` fallbacks) resolving schema path, output path, and database connection for all commands; flags override config; sensible zero-config defaults.
- No breaking changes: `generateTypes()` and `assertIndexesAndConstraints()` remain public and unchanged; the CLI consumes them.

## Capabilities

### New Capabilities

- `cli-config`: Configuration resolution shared by all CLI commands — config file discovery (`grafeo.config.ts`/`.js`/`.json`), flag precedence, connection/env-var handling, exit-code and error-output conventions.
- `cli-generate`: Type generation command — one-shot run, `--watch` mode, and `--verify` staleness gate.
- `cli-db-push`: Schema synchronization command — introspect live constraints/indexes, diff against SDL, plan rendering, `--dry-run`, additive-by-default apply, `--force-drop` for destructive ops.
- `cli-db-seed`: Seeding command — seed script resolution, OGM instance injection, idempotency guidance (upsert-based).

### Modified Capabilities

<!-- none — existing library APIs are consumed, not changed -->

## Impact

- **New code**: `src/cli/` (command parsing, config loader, watch loop, diff planner, output formatting); `"bin": { "grafeo": "dist/cjs/cli/index.js" }` in package.json.
- **Existing code consumed, not modified**: `src/generator/generate-types.ts` (`generateTypes`), `src/ogm.ts` (`assertIndexesAndConstraints` logic will be reused/extracted for diffing), `src/schema/parser.ts` (`SchemaMetadata` is the diff source of truth).
- **Dependencies**: requires a decision on arg-parsing/watch dependencies (zero-dep vs `commander`/`chokidar`) — package currently has a minimal runtime dependency footprint; decision belongs in design.md.
- **Packaging**: `files` whitelist already includes `dist`; CLI ships in the existing tarball. README gains a CLI section; `npx grafeo generate` becomes the documented quickstart path.
- **CI**: repository CI gains a self-test using `--verify`.
