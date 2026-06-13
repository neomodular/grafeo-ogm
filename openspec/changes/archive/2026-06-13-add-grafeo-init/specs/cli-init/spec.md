# cli-init — Delta Spec

## ADDED Requirements

### Requirement: Existing-project autodetection
`grafeo init` SHALL detect an existing grafeo setup in the working directory and propose a ready-to-use configuration without manual path entry. It SHALL locate the SDL schema (a `.graphql`/`.gql` file containing grafeo directives such as `@node`/`@relationship`), the previously generated types file (identified by the generator's header marker), and any existing `grafeo.config.*`, and pre-fill the config's `schema` and `out` paths from what it finds.

#### Scenario: Existing schema and generated types detected
- **WHEN** `grafeo init` runs in a project that already contains a `.graphql` schema with `@node` types and a generated types file carrying the grafeo header marker
- **THEN** the proposed `grafeo.config.ts` has `schema` and `out` set to the detected paths, and the user is shown those paths to confirm

#### Scenario: Multiple schema candidates
- **WHEN** more than one `.graphql` file containing grafeo directives is found
- **THEN** the CLI prompts the user to choose which is the schema rather than guessing

#### Scenario: No grafeo artifacts present
- **WHEN** no grafeo schema or generated types file is found
- **THEN** the command proceeds as a new-project setup

### Requirement: Interactive setup with a fresh-start option
Interactively (TTY), `grafeo init` SHALL show detected values and let the user accept or override each path, and SHALL offer an explicit "start fresh / new project" choice even when an existing setup is detected.

#### Scenario: Accept the detected setup
- **WHEN** the user confirms the detected schema and output paths
- **THEN** `grafeo.config.ts` is written with those values and the command exits 0

#### Scenario: Choose a fresh setup despite detection
- **WHEN** an existing setup is detected but the user selects "start fresh"
- **THEN** the CLI follows the new-project scaffolding flow (prompting for or defaulting paths) instead of the detected values

### Requirement: New-project scaffolding
When there is nothing to detect (or the user chose a fresh setup), `grafeo init` SHALL scaffold a starting point: a `grafeo.config.ts` with default paths, a starter `schema.graphql` containing the Neo4j movie example (`Movie`/`Person` with `ACTED_IN`/`DIRECTED` relationships) in grafeo SDL, and (optionally) a `seed.ts` stub that uses `upsert`.

#### Scenario: Greenfield scaffold
- **WHEN** `grafeo init` runs in an empty directory and the user accepts defaults
- **THEN** `grafeo.config.ts` and a starter `schema.graphql` (the movie example) are created with consistent paths, and the user is told the next step is `npx grafeo generate`

### Requirement: npm script wiring
When a `package.json` exists in the working directory, `grafeo init` SHALL add a `"generate": "grafeo generate"` entry to its `scripts` so codegen is runnable via `npm run generate`. An existing `generate` script SHALL be left untouched and reported, never overwritten.

#### Scenario: generate script added
- **WHEN** `grafeo init` runs in a project whose `package.json` has no `generate` script
- **THEN** a `"generate": "grafeo generate"` script is added to `package.json` and the user is told they can run `npm run generate`

#### Scenario: existing generate script preserved
- **WHEN** the `package.json` already defines a `generate` script
- **THEN** `grafeo init` leaves it unchanged and reports that it was kept

### Requirement: Non-destructive writes
`grafeo init` SHALL NOT overwrite an existing `grafeo.config.*`, `schema.graphql`, or seed file without explicit confirmation. Re-running `init` on an already-configured project SHALL be safe.

#### Scenario: Existing config is not clobbered
- **WHEN** `grafeo init` runs in a project that already has a `grafeo.config.ts`
- **THEN** the CLI reports the existing config and requires explicit confirmation before overwriting it, and never overwrites it in non-interactive mode without `--force`

### Requirement: Non-interactive mode
`grafeo init --yes` (and explicit path flags) SHALL run without prompts, using detected values or defaults, so it is usable in scripts and CI. It SHALL NOT prompt for secrets; database credentials are referenced from `NEO4J_*` env vars in the generated config.

#### Scenario: CI-safe non-interactive init
- **WHEN** `grafeo init --yes` runs in a non-interactive session
- **THEN** the config is written from detected/default values with no prompts, secrets are not requested, and the command exits 0 (exiting non-zero only if it would have to overwrite an existing file without `--force`)
