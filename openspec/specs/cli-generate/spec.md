# cli-generate Specification

## Purpose
TBD - created by archiving change add-grafeo-cli. Update Purpose after archive.
## Requirements
### Requirement: One-shot type generation
`grafeo generate` SHALL run the existing `generateTypes()` against the resolved schema path and write the generated TypeScript to the resolved output path, exiting 0 on success with a summary line (output path, node/interface counts, duration).

#### Scenario: Successful generation
- **WHEN** `grafeo generate` runs with a valid SDL schema
- **THEN** the output file is written and the CLI exits 0 with a one-line summary

#### Scenario: Generation failure
- **WHEN** the schema is invalid (parse error, empty schema)
- **THEN** no output file is written and the CLI exits non-zero per the cli-config error convention

### Requirement: Watch mode
`grafeo generate --watch` SHALL watch the schema file and re-run generation on change. A failed regeneration SHALL print the error and keep watching — it SHALL NOT terminate the watcher.

#### Scenario: Schema change triggers regeneration
- **WHEN** the watcher is running and the schema file is saved with a valid change
- **THEN** the output file is regenerated and a timestamped success line is printed

#### Scenario: Error does not kill the watcher
- **WHEN** the schema file is saved containing a syntax error
- **THEN** the error is printed, the previous output file is left untouched, and the watcher continues running

### Requirement: Verify gate
`grafeo generate --verify` SHALL generate types in memory and compare them to the file on disk WITHOUT writing. A match SHALL exit 0; a mismatch or missing file SHALL exit 1 with a message instructing to run `grafeo generate`. This is the CI staleness gate.

#### Scenario: Types up to date
- **WHEN** `grafeo generate --verify` runs and the disk file matches the in-memory generation
- **THEN** the CLI exits 0 and writes nothing

#### Scenario: Types stale
- **WHEN** the schema has changed since the disk file was generated
- **THEN** the CLI exits 1, writes nothing, and stderr says the generated types are out of date

#### Scenario: Output file missing
- **WHEN** the configured output file does not exist
- **THEN** the CLI exits 1 with the same instruction

