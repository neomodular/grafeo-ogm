# cli-db-seed — Delta Spec

## ADDED Requirements

### Requirement: Seed script resolution and execution
`grafeo db seed` SHALL resolve the seed entry point from the config file's `seed` setting, falling back to `./seed.ts` then `./seed.js` in the working directory. The seed module SHALL export a default async function receiving a constructed, connected `OGM` instance. The CLI SHALL await it and close the driver afterwards, even on failure.

#### Scenario: Config-declared seed runs
- **WHEN** `grafeo.config.ts` sets `seed: './scripts/seed.ts'` and `grafeo db seed` runs
- **THEN** the exported function is invoked with a connected OGM and the CLI exits 0 when it resolves

#### Scenario: Seed failure propagates
- **WHEN** the seed function throws
- **THEN** the CLI exits non-zero, prints the error per the cli-config convention, and the driver is still closed

#### Scenario: No seed found
- **WHEN** no `seed` config entry exists and neither `./seed.ts` nor `./seed.js` is present
- **THEN** the CLI exits non-zero with a message showing the expected locations and a minimal seed-file example

### Requirement: Idempotency guidance in scaffold output
The no-seed-found error message and documentation SHALL recommend upsert-based seeding (grafeo's `upsert`) so repeated runs converge instead of duplicating data. The CLI itself SHALL NOT enforce idempotency.

#### Scenario: Example promotes upsert
- **WHEN** the no-seed-found message is displayed
- **THEN** the embedded example uses `model.upsert` rather than `model.create`
