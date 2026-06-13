# Tasks: add-grafeo-init

## 1. Detection

- [x] 1.1 Implement `src/cli/detect.ts`: shallow directory scan (excluding `node_modules`/`dist`/`.git`) for (a) `.graphql`/`.gql` files containing grafeo directives, (b) generated types files via the header marker, (c) existing `grafeo.config.*` and `.env`/`NEO4J_*`
- [x] 1.2 Unit tests for detection: single schema, multiple candidates, `.graphql` without grafeo directives (ignored), generated-types marker match, no artifacts (temp-dir fixtures, no DB)

## 2. grafeo init command

- [x] 2.1 Implement `src/cli/commands/init.ts`: interactive flow (detected vs fresh), per-path confirmation/override, non-destructive writes, `--yes`/`--force`/path flags
- [x] 2.2 Config + scaffold emitters: write `grafeo.config.ts` (schema/out/database-from-env/seed), a starter `schema.graphql` (Neo4j movie example: `Movie`/`Person`, `ACTED_IN`/`DIRECTED`), and an optional `seed.ts` upsert stub
- [x] 2.3 npm script wiring: add `"generate": "grafeo generate"` to `package.json` `scripts` when present; preserve an existing `generate` script (report, never clobber)
- [x] 2.4 Router + help: wire `init` into `src/cli/index.ts` lazy dispatch; add focused per-command help
- [x] 2.5 Tests: detected-accept, fresh-start-over-detection, greenfield scaffold (movie schema), npm-script added + existing-script preserved, existing-config-not-clobbered (interactive confirm + `--force`), non-interactive `--yes`, no-secret-prompt (fake `CliIO` + temp dirs)

## 3. Packaging, docs, CI

- [ ] 3.1 README: lead the quickstart with `npx grafeo init`; document detection behavior and flags
- [ ] 3.2 CHANGELOG entry; full suite + lint + format gates green
