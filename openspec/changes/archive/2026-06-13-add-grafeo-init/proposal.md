# Proposal: add-grafeo-init

## Why

A new grafeo-ogm user has to assemble the wiring by hand: write `grafeo.config.ts`, point it at a schema, pick an output path, and learn the connection conventions — exactly the friction `prisma init` / `drizzle-kit` remove. Worse, an EXISTING grafeo user who adopts the v1.9 CLI already has all the pieces (a schema, a generated types file, `NEO4J_*` env) but no config tying them together, and must reverse-engineer the right paths. `grafeo init` should detect that existing setup and write a ready-to-use config with zero guesswork, and scaffold a sensible starting point for greenfield projects.

## What Changes

- New `grafeo init` command — interactive by default; `--yes`/flags for non-interactive/CI.
- **Auto-detection for existing projects**: scans the working directory for an existing grafeo SDL schema (a `.graphql` carrying grafeo directives) and a previously generated types file (identified by the generator's header marker), and pre-fills `grafeo.config.ts` with the detected paths — "it just hooks itself up."
- **Interactive confirmation**: shows what it detected and lets the user accept or adjust each path; offers an explicit "start fresh / new project" branch even when an existing setup is found.
- **New-project scaffolding**: when nothing is detected (or the user chooses fresh), writes a starter `schema.graphql`, a `grafeo.config.ts` with defaults, and an optional `seed.ts` stub.
- **Non-destructive**: never overwrites an existing `grafeo.config.*` or schema without explicit confirmation; re-running `init` on a configured project is safe.
- Connection settings reference `NEO4J_*` env vars (no secret prompting), consistent with the CLI's password policy.

## Capabilities

### New Capabilities

- `cli-init`: Project initialization — existing-project autodetection (schema + generated types + config), interactive setup with a fresh-start option, new-project scaffolding, and non-destructive, CI-safe writes.

### Modified Capabilities

<!-- none — cli-config conventions are reused, not changed -->

## Impact

- **New code**: `src/cli/commands/init.ts` (command + interactive flow), `src/cli/detect.ts` (schema/types/config discovery), router wiring + help text in `src/cli/index.ts`.
- **Existing code consumed, not modified**: `src/cli/config.ts` (`GrafeoConfig`, `defineConfig`), the generator's header marker (for types-file detection), the `CliIO` interactive/`confirm` seam.
- **Dependencies**: no new runtime dependency — prompts use `node:readline/promises` (already used by the `db push` consent gate). A branded TUI / logo animation is explicitly out of scope (a separate, optional, TTY-only layer).
- **Docs/CI**: README quickstart leads with `npx grafeo init`; help text gains the `init` command.
