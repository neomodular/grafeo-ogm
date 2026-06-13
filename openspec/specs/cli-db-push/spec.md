# cli-db-push Specification

## Purpose
TBD - created by archiving change add-grafeo-cli. Update Purpose after archive.
## Requirements
### Requirement: Schema-to-database diff
`grafeo db push` SHALL parse the SDL into `SchemaMetadata`, introspect the live database via `SHOW CONSTRAINTS` and `SHOW INDEXES`, and compute a plan with three sections: constraints/indexes to CREATE (declared in SDL via `@id`/`@unique`/`@fulltext`/`@vector` but absent in the database), items already in sync, and ORPHANS (present in the database, matching grafeo naming, but absent from the SDL).

#### Scenario: Missing unique constraint detected
- **WHEN** the SDL declares `id: ID! @id @unique` on `Book` and the database has no corresponding constraint
- **THEN** the plan lists a `CREATE CONSTRAINT` for `Book.id` under the CREATE section

#### Scenario: Fulltext and vector indexes covered
- **WHEN** the SDL declares `@fulltext` or `@vector` indexes absent from the database
- **THEN** the plan lists the corresponding `CREATE FULLTEXT INDEX` / `CREATE VECTOR INDEX` statements

#### Scenario: In-sync schema produces empty plan
- **WHEN** every declared constraint and index already exists
- **THEN** the plan reports "No changes" and the CLI exits 0 without executing any write

### Requirement: Dry-run mode
`grafeo db push --dry-run` SHALL print the full plan, including the exact Cypher that would run, and SHALL NOT execute any of it.

#### Scenario: Dry run makes no changes
- **WHEN** `grafeo db push --dry-run` runs against a database missing two constraints
- **THEN** the two `CREATE CONSTRAINT` statements are printed and the database is unmodified

### Requirement: Additive by default, destructive only with force
Applying the plan SHALL create missing items only. Orphans SHALL be reported but NOT dropped unless `--force-drop` is passed; with `--force-drop`, the CLI SHALL list the drops and require an interactive confirmation unless `--yes` is also passed.

#### Scenario: Orphan reported but kept
- **WHEN** the database has a grafeo-named constraint not present in the SDL and `grafeo db push` runs without `--force-drop`
- **THEN** missing items are created, the orphan is listed as "kept (use --force-drop to remove)", and the CLI exits 0

#### Scenario: Force-drop requires confirmation
- **WHEN** `grafeo db push --force-drop` runs non-interactively without `--yes`
- **THEN** the CLI exits non-zero stating that destructive changes require `--yes` in non-interactive mode

### Requirement: Idempotency
Running `grafeo db push` twice in a row SHALL result in the second run producing an empty plan.

#### Scenario: Second push is a no-op
- **WHEN** `grafeo db push` succeeds and is immediately run again
- **THEN** the second run reports "No changes" and executes nothing

