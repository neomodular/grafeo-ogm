# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in grafeo-ogm, please report it privately so a fix can be released before the issue is publicly disclosed.

**Please do NOT open a public GitHub issue for security vulnerabilities.**

### How to report

Open a [GitHub security advisory](https://github.com/neomodular/grafeo-ogm/security/advisories/new) on this repository. This creates a private channel between you and the maintainers.

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal reproduction repo or code snippet is ideal)
- The grafeo-ogm version, Neo4j version, and Node.js version affected
- Any relevant logs or stack traces (with secrets redacted)

After a fix ships, public disclosure happens with credit to the reporter unless anonymity is requested.

## Supported Versions

Security fixes are applied to the latest minor release.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Threat Model

grafeo-ogm is a library that **takes untrusted input and builds Cypher queries**. The threat model assumes the application calling grafeo-ogm may be passing user-controlled data through `where`, `select`, `input`, and other typed parameters.

### What grafeo-ogm protects against

- **Cypher injection** — all field names are validated against a strict identifier regex (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) and backtick-escaped. All values are sent as Cypher parameters (`$param0`), never interpolated into the query string.
- **Prototype pollution** — `__proto__`, `constructor`, and `prototype` are blocked as input keys. The result mapper uses `Object.create(null)` to prevent prototype chain contamination.
- **ReDoS** — all regex patterns in the codebase are linear-time; no catastrophic backtracking.
- **Resource exhaustion** — recursion depth is bounded in the WHERE compiler (10), selection compiler (5), result mapper (50), and parse cache (200 entries).
- **Identifier enumeration** — error messages do not leak internal schema target type names; they reference the user-facing field name only.
- **Lucene injection** (fulltext queries) — special characters are escaped before being passed to `db.index.fulltext.queryNodes`.

### What grafeo-ogm does NOT protect against

- **Authentication / authorization** — grafeo-ogm runs with whatever Neo4j credentials you give the driver. You must enforce auth in your application layer.
- **Rate limiting** — long-running queries are not throttled; use connection pooling and Neo4j's `dbms.transaction.timeout` for protection.
- **Data validation beyond Cypher safety** — grafeo-ogm validates *Cypher safety* of identifiers, not *business rules* of values. Validate inputs (email format, range bounds, etc.) in your application before passing them to grafeo-ogm.
- **Secrets in queries** — if you log queries via `Executor.debug = true`, parameter values appear in logs. Strip sensitive values or disable debug in production.

## Hall of Fame

Security researchers credited for responsible disclosure will be listed here.
