## ADDED Requirements

### Requirement: Opt-in live verification of NLS enforcement
The repository SHALL contain an integration suite that runs against a real Neo4j only when `NEO4J_URI` is set, and is skipped otherwise. It SHALL use dedicated labels and a per-run identifier, and SHALL remove all data it created.

#### Scenario: Skipped without a database
- **WHEN** `pnpm run test` runs without `NEO4J_URI`
- **THEN** the integration suite is reported as skipped, and the run passes

#### Scenario: Self-cleaning
- **WHEN** the suite finishes, whether it passed or failed
- **THEN** no node carrying the run identifier remains in the database

### Requirement: Every enforcement gap has an end-to-end regression test
The suite SHALL contain, for each gap closed by this change (unprotected-root reads/traversal/connect, connect in create, cascade `where`, cascade and nested-delete target policy, nested update row filter and write restrictive, nested create permissive and write restrictive, traversal in nested-write `where`, `field_NOT: null`, and interface gated permissives), a test that asserts the database outcome: rows returned, nodes remaining, relationships created, or the error raised.

#### Scenario: Cascade where regression
- **WHEN** the cascade-delete test runs the README example against seeded data
- **THEN** it asserts that the non-matching shared category still exists

#### Scenario: Gateway regression
- **WHEN** the gateway test reads a protected chart through an unprotected tag
- **THEN** it asserts that the hidden chart is absent from the result
