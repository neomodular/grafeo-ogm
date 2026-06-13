# Tasks: add-grafeo-cli

## 1. Foundation

- [x] 1.1 Add `jiti` dependency; add `"bin": { "grafeo": "dist/cjs/cli/index.js" }` to package.json; create `src/cli/index.ts` entry with shebang and lazy command routing via `node:util` `parseArgs`
- [x] 1.2 Implement `src/cli/config.ts`: discovery (`grafeo.config.ts`/`.js`/`.json`), jiti-based TS loading, flag-precedence merge, connection resolution with `--password` rejection; export a typed `GrafeoConfig`
- [x] 1.3 Implement `src/cli/errors.ts`: stderr rendering for `OGMError`/generator errors (no stack by default, `--debug` includes it), exit-code helpers
- [x] 1.4 Unit tests for config discovery, precedence, connection resolution, and error rendering (temp-dir fixtures, no DB)

## 2. grafeo generate

- [x] 2.1 Implement `src/cli/commands/generate.ts`: one-shot run wrapping `generateTypes()`, summary line (path, counts, duration)
- [x] 2.2 Implement `--verify`: in-memory generation + byte comparison against disk (same Prettier step), exit 1 on stale/missing, zero writes
- [x] 2.3 Implement `--watch`: debounced `fs.watch` wrapper, error-resilient loop, `--poll <ms>` fallback
- [x] 2.4 Tests: success, parse-failure (no write), verify up-to-date/stale/missing, watch regenerates and survives a syntax error (temp-dir, fake timers where possible)

## 3. grafeo db push

- [x] 3.1 Extract shared constraint/index statement generation from `assertIndexesAndConstraints` into a module both the OGM method and the planner consume (no behavior change to the existing method — sibling-sweep check included)
- [x] 3.2 Implement `src/cli/push-planner.ts`: pure `planSchemaSync()` over `SchemaMetadata` + normalized live records → `{ create, inSync, orphans, unmanaged }`; name-convention scoping for orphans
- [x] 3.3 Implement `SHOW CONSTRAINTS`/`SHOW INDEXES` introspection adapter with output normalization; fixtures for known Neo4j 5.x shape variants
- [x] 3.4 Implement `src/cli/commands/db-push.ts`: plan rendering, `--dry-run`, additive apply, `--force-drop` + `--yes` confirmation gate, idempotent re-run
- [x] 3.5 Tests: planner unit suite (fixtures: missing constraint, fulltext, vector, in-sync, orphan kept, unmanaged ignored), command tests with mock driver (dry-run executes nothing, force-drop without --yes fails non-interactively, second push no-op)

## 4. grafeo db seed

- [x] 4.1 Implement `src/cli/commands/db-seed.ts`: seed resolution (config → `./seed.ts` → `./seed.js`), jiti load, OGM construction/injection, guaranteed driver close, upsert-promoting no-seed-found message
- [x] 4.2 Tests: config-declared seed runs, failure propagates with driver closed, no-seed-found message content

## 5. Packaging, docs, CI

- [ ] 5.1 Verify the bin works from a packed tarball (`pnpm pack` + `npx` smoke test in a temp project) for both fresh and existing projects
- [ ] 5.2 README: new "CLI" section, quickstart switched to `npx grafeo generate`, `db push` dry-run-first guidance, seed convention; help text finalized
- [ ] 5.3 Add `grafeo generate --verify` self-test to repository CI using the examples/ schema
- [ ] 5.4 Full suite + lint + format gates green (DONE — 1462 tests + eslint + prettier all green); CHANGELOG entry drafted for v1.9.0 (pending)
