# cli-config Specification

## Purpose
TBD - created by archiving change add-grafeo-cli. Update Purpose after archive.
## Requirements
### Requirement: Config file discovery
The CLI SHALL discover its configuration by checking, in order: `grafeo.config.ts`, `grafeo.config.js`, `grafeo.config.json` in the current working directory. The first file found wins. All commands SHALL share this resolution.

#### Scenario: TypeScript config found
- **WHEN** `grafeo generate` runs in a directory containing `grafeo.config.ts`
- **THEN** the CLI loads schema path, output path, and database settings from that file

#### Scenario: No config file, flags provided
- **WHEN** no config file exists and the user runs `grafeo generate --schema ./schema.graphql --out ./src/generated.ts`
- **THEN** the command runs using only the flag values

#### Scenario: No config file and no flags
- **WHEN** no config file exists and required inputs are not provided via flags
- **THEN** the CLI exits non-zero with a message naming the missing input and showing a minimal `grafeo.config.ts` example

### Requirement: Flag precedence
Command-line flags SHALL override config-file values for the same setting.

#### Scenario: Flag overrides config output path
- **WHEN** `grafeo.config.ts` sets `out: './src/generated.ts'` and the user passes `--out ./tmp/types.ts`
- **THEN** the CLI writes to `./tmp/types.ts`

### Requirement: Database connection resolution
Commands that contact Neo4j (`db push`, `db seed`) SHALL resolve the connection from, in precedence order: CLI flags (`--uri`, `--username`, `--database`), config-file `database` settings, then the environment variables `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`. The password SHALL NOT be accepted as a CLI flag.

#### Scenario: Connection from environment
- **WHEN** `grafeo db push` runs with `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD` set and no config `database` block
- **THEN** the CLI connects using the environment values

#### Scenario: Password flag rejected
- **WHEN** the user passes `--password secret` to any command
- **THEN** the CLI exits non-zero explaining that the password must come from `NEO4J_PASSWORD` or the config file

### Requirement: Error output and exit codes
Every command SHALL write human-readable errors to stderr and exit non-zero on failure; exit code 0 SHALL mean the command fully succeeded. Library errors (`OGMError` subclasses, generator errors) SHALL be rendered with their message and, when available, the offending file or schema location — never a bare stack trace by default. `--debug` SHALL include the stack trace.

#### Scenario: Schema parse failure
- **WHEN** `grafeo generate` runs against an SDL file with a syntax error
- **THEN** the CLI exits non-zero and stderr names the schema file and the parse error without a stack trace

#### Scenario: Debug flag shows stack
- **WHEN** the same failure occurs with `--debug`
- **THEN** stderr additionally includes the full stack trace

