# Contributing to grafeo-ogm

Thank you for your interest in contributing to grafeo-ogm. This guide covers everything you need to get started.

## Prerequisites

- **Node.js** >= 18
- **pnpm** (package manager)
- **TypeScript** familiarity (the codebase uses strict mode)
- **Neo4j** and Cypher knowledge (helpful for compiler work)
- **GraphQL SDL** basics (the schema definition layer)

## Development Setup

```bash
# Clone and install
git clone https://github.com/aleguzman/grafeo-ogm.git
cd grafeo-ogm
pnpm install

# Build the project
pnpm run build

# Run the full test suite
pnpm test

# Lint and format
pnpm run lint
pnpm run format:check
```

## Project Structure

```
src/
  schema/          # GraphQL SDL parser and type definitions
  compilers/       # Stateless compilers: where, selection, mutation, fulltext
  execution/       # Cypher executor and Neo4j result mapper
  generator/       # TypeScript code generator and type emitters
  subgraph/        # Subgraph and multi-label support
  testing/         # Mock factories and test utilities (CypherAssert, etc.)
  utils/           # Validation, security, and shared helpers
  ogm.ts           # Central OGM hub
  model.ts         # CRUD operations for node types
  interface-model.ts  # Read-only queries for interface types
  errors.ts        # Custom error types

tests/             # Test files mirroring src/ structure
examples/          # Runnable usage examples
```

### Core Pipeline

```
GraphQL SDL --> parseSchema() --> SchemaMetadata --> Compilers --> Cypher + Params --> Executor --> Neo4j --> ResultMapper --> JS objects
```

Each compiler is stateless and produces `{ cypher, params }` output. The OGM parses the schema once in the constructor, creates shared compiler instances, and vends cached Model/InterfaceModel instances via `ogm.model(name)`.

## Running Tests

```bash
# Full suite
pnpm test

# Single file
npx jest tests/where.compiler.spec.ts

# By test name
npx jest -t "compiles _CONTAINS operator"
```

### Testing Guidelines

- All changes must include tests.
- Use the mock factories from `src/testing/` (`NodeDefinition`, `PropertyDefinition`, `RelationshipDefinition`) rather than parsing real schemas.
- Use `CypherAssert` for Cypher output assertions, `Neo4jRecordFactory` for mock Neo4j records, and `SelectionSetFactory` for selection set construction.
- Match the style of existing tests in the `tests/` directory.
- Call `Model.clearSelectionCache()` in tests when you need to reset compiler caches between test cases.

## Code Style

- **TypeScript** with strict mode enabled
- **Prettier** for formatting (`pnpm run format`)
- **ESLint** for linting (`pnpm run lint:fix`)
- Single quotes, trailing commas
- No `console.log` statements (enforced by ESLint)
- ES2020 target, CommonJS output

Run both checks before submitting:

```bash
pnpm run lint
pnpm run format:check
```

## Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must follow this format:

```
<type>: <description>

[optional body]
```

Types:

- `feat:` -- new feature or capability
- `fix:` -- bug fix
- `docs:` -- documentation changes
- `test:` -- adding or updating tests
- `refactor:` -- code restructuring without behavior change
- `chore:` -- tooling, CI, dependencies, maintenance
- `perf:` -- performance improvement

Examples:

```
feat: add _STARTS_WITH operator to WhereCompiler
fix: handle null values in ResultMapper depth guard
test: add edge cases for fulltext compiler lucene escaping
refactor: extract parameter naming into shared utility
```

## Pull Request Process

1. **Fork** the repository and create a branch from `main`.
2. **Name your branch** descriptively: `feat/where-regex-operator`, `fix/result-mapper-null`, etc.
3. **Make your changes** with tests covering the new behavior.
4. **Run the full validation suite**:
   ```bash
   pnpm run build
   pnpm test
   pnpm run lint
   pnpm run format:check
   ```
5. **Commit** using conventional commit messages.
6. **Open a Pull Request** against `main` with a clear description of what changed and why.

### PR Expectations

- Every PR must pass CI (build, tests, lint).
- New features need tests. Bug fixes need a regression test.
- Breaking changes must be clearly documented in the PR description.
- Keep PRs focused -- one logical change per PR.

## Reporting Issues

When opening an issue, include:

- **grafeo-ogm version** (from `package.json` or `npm ls grafeo-ogm`)
- **Node.js version** (`node --version`)
- **Neo4j version** (if applicable)
- **Operating system**
- **GraphQL schema** (if relevant to the issue)
- **Minimal reproduction** -- the smallest code snippet or test case that demonstrates the problem
- **Expected behavior** vs. **actual behavior**

The more detail you provide, the faster we can diagnose and fix the issue.

## Architecture Notes

If you are contributing to a specific area, here is what each compiler does:

| Compiler | Responsibility |
|---|---|
| **WhereCompiler** | Filter objects to `WHERE` clauses. Scalar operators, logical operators, relationship quantifiers. |
| **SelectionCompiler** | Selection sets to Cypher map projections. Relationships via pattern comprehensions. |
| **MutationCompiler** | `CREATE`, `SET`, `DELETE`, `MERGE` with nested relationship operations. |
| **FulltextCompiler** | `CALL db.index.fulltext.queryNodes()` clauses with index validation. |
| **SelectNormalizer** | Typed `select` API objects to `SelectionNode[]` trees for SelectionCompiler. |

### Security Conventions

- All identifiers are validated (`assertSafeIdentifier`, `assertSafeLabel`) and backtick-escaped.
- Parameters use numbered naming (`param0`, `param1`) to prevent injection.
- Prototype pollution keys (`__proto__`, `constructor`) are blocked in all input processing.

## Questions?

If something is unclear, open a discussion or issue. We are happy to help you find the right place to contribute.
