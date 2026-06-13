# Design: add-grafeo-cli

## Context

grafeo-ogm v1.8.x is a library-only package: codegen via `generateTypes()`, schema sync via `OGM.assertIndexesAndConstraints()` (create-only, no plan/diff), no seeding story. The package ships dual CJS/ESM from `dist/`, has a deliberately minimal runtime dependency footprint (`graphql`, peer `neo4j-driver`), strict TypeScript, and Jest with mock-driver test conventions. The CLI is the centerpiece of v1.9 and the foundation for later roadmap items (`--verify` CI gates now; TypedCypher generation and `db pull` will become subcommands later).

## Goals / Non-Goals

**Goals:**
- `npx grafeo generate|db push|db seed` working zero-config in a typical project
- Reuse existing library machinery — the CLI orchestrates, it does not re-implement compilation or introspection logic
- Keep the dependency footprint minimal and auditable
- Every command testable without a real Neo4j (mock driver injection seam)

**Non-Goals:**
- Versioned data migrations (Morpheus owns that space; `db push` is constraints/indexes only)
- `db pull` introspection-to-SDL (separate roadmap item; design must not preclude it)
- Watch-mode for `db push`/`db seed`
- Windows-specific shell integrations beyond what Node's `bin` shim provides

## Decisions

1. **Argument parsing: `node:util` `parseArgs` — no `commander`.**
   The surface is three commands with a handful of flags. `parseArgs` (stable since Node 18.3) is zero-dependency and sufficient. A thin `src/cli/args.ts` router maps `argv[2]`/`argv[3]` to command modules. *Alternative considered:* `commander`/`yargs` — better help generation, but a new runtime dependency for a package that markets a minimal footprint; help text is hand-written once and stable.

2. **TypeScript config loading: `jiti` as the ONLY new dependency.**
   `grafeo.config.ts` must load from a CJS CLI without requiring the user's project to be pre-compiled. `jiti` is the ecosystem standard (used by Nuxt, Tailwind, ESLint flat config tooling), small, and handles TS/ESM/CJS configs uniformly. *Alternatives considered:* `tsx` (heavier, spawns a process), dynamic `import()` only (fails on `.ts`), requiring users to write `.js` configs (worse DX than Prisma/Drizzle — unacceptable for the flagship feature).

3. **Watch mode: `fs.watch` with debounce — no `chokidar`.**
   We watch ONE schema file (or a small glob resolved at startup), not a tree. A 100 ms debounce wrapper over `fs.watch` covers the editor-save double-fire problem. *Alternative considered:* `chokidar` — more robust cross-platform semantics, but it is a heavyweight dependency for single-file watching; revisit only if issue reports show platform flake.

4. **`db push` diffing: extract a pure planner, reuse OGM execution.**
   New `src/cli/push-planner.ts` exports `planSchemaSync(schema: SchemaMetadata, liveConstraints, liveIndexes) → Plan` as a PURE function (no driver) — unit-testable with fixtures, reusable later by a programmatic `ogm.planIndexesAndConstraints()`. The CLI fetches `SHOW CONSTRAINTS`/`SHOW INDEXES` via a driver session and feeds the planner. `assertIndexesAndConstraints` stays untouched for backwards compatibility; its create-statement generation is factored into a shared module both call sites use (single source of truth for constraint naming).

5. **Orphan detection is name-convention-scoped.**
   The planner only flags as orphans the constraints/indexes whose names match grafeo's naming convention. Hand-created DBA constraints with custom names are reported under "unmanaged (ignored)" — never dropped, never counted as drift. This keeps `--force-drop` safe in brownfield databases.

6. **Binary wiring: `"bin": { "grafeo": "dist/cjs/cli/index.js" }` with `#!/usr/bin/env node`.**
   CJS build only for the bin (no dual-format need). `src/cli/index.ts` is the entry; command modules are lazy-`require`d so `generate` does not load `neo4j-driver`.

7. **Connection secrets: env-var or config only — `--password` is rejected.**
   Passwords in argv leak via process listings and shell history. `NEO4J_PASSWORD` / config-file value (which may itself read `process.env`) are the supported paths. Matches the spec's cli-config requirement.

8. **Exit codes:** `0` success / no-drift; `1` any failure INCLUDING `--verify` staleness and parse errors; `2` reserved for future "drift detected" differentiation if CI users request it. Keep the initial contract simple.

## Risks / Trade-offs

- [`jiti` adds a runtime dependency] → It is the single new dependency, widely vetted, and only loaded by the CLI entry — library consumers importing `grafeo-ogm` never touch it.
- [`fs.watch` flake on some platforms/editors] → Debounce + re-stat on event; documented fallback `--poll <ms>` flag using `fs.watchFile`; upgrade to chokidar only on evidence.
- [`SHOW CONSTRAINTS`/`SHOW INDEXES` output shape varies across Neo4j 5.x minors] → Planner consumes a normalized record shape; normalization isolated in one adapter function with fixtures for the known variants; CI matrix note in docs.
- [Orphan misclassification could suggest dropping a wanted index] → Mitigated by decision 5 (name-convention scoping) + `--force-drop` requiring explicit confirmation + dry-run-first documentation.
- [Seed scripts run arbitrary user code with a live connection] → That is their purpose; the CLI prints the resolved seed path before running and never auto-runs seed as part of `push` (explicit invocation only — unlike Prisma's auto-seed-on-migrate, which surprises people).

## Migration Plan

Purely additive — no existing API changes. Ship in v1.9.0; README quickstart switches to `npx grafeo generate`; the hand-written-script path remains documented for programmatic use. Rollback = users simply don't use the bin.

## Open Questions

- Should `--verify` compare formatted output byte-for-byte or AST-normalized? (Initial: byte-for-byte after running the same Prettier step codegen uses — deterministic because the formatter is pinned.)
- Does `db push` need `--database` multi-DB iteration in v1.9, or single-database per invocation? (Initial: single; flag accepts one database name.)
- Scaffold command (`grafeo init` writing config + example schema) — in scope for v1.9 or the starter-template train? (Leaning: separate change proposal.)
