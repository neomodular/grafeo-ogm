# Security Policy

## Supported Versions

Fixes, including security fixes, ship in a new release of the latest 2.x minor line. Older releases are not patched: there are no backport branches, so upgrade to the latest 2.x to get a fix.

| Version                                       | Receives fixes                  |
| --------------------------------------------- | ------------------------------- |
| Latest 2.x release (`latest` on npm)          | :white_check_mark:              |
| Older 2.x releases                            | :x: (upgrade to the latest 2.x) |
| 1.x and pre-releases (such as `1.7.0-beta.*`) | :x:                             |

Within 2.x, a fix that changes behaviour callers may rely on ships as a minor release with a "Behavior changes" section in the [CHANGELOG](./CHANGELOG.md). Security fixes can change behaviour in a minor release; each such change is listed there.

## Reporting a Vulnerability

**Please do not open a public issue, pull request or discussion with vulnerability details.**

### How to report

Use GitHub's private vulnerability reporting: go to the repository's [Security tab](https://github.com/neomodular/grafeo-ogm/security) and choose **Report a vulnerability** (or open [a new draft advisory](https://github.com/neomodular/grafeo-ogm/security/advisories/new) directly). The report is visible only to you and the maintainers.

If that option is not available to you, open a public issue that says only that you have a security report and need a private channel. Do not include any details in it.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (a minimal schema and query or code snippet is ideal)
- The grafeo-ogm, Neo4j and Node.js versions
- Whether you use node-level security `policies`, and the relevant policy shape
- Any relevant logs or stack traces, with secrets redacted

### What to expect

- The maintainers reproduce the report, ideally with a failing test against a live Neo4j 5.26, before writing a fix.
- The fix ships in a new release of the latest 2.x minor line, with an entry under "Security" in the [CHANGELOG](./CHANGELOG.md).
- A [GitHub security advisory](https://github.com/neomodular/grafeo-ogm/security/advisories) is published for the fix, crediting the reporter unless they ask to stay anonymous.

This is a community-maintained project, so there is no guaranteed response time.

## Published Advisories

All published advisories are listed at <https://github.com/neomodular/grafeo-ogm/security/advisories>. For how fixes are tested and released, see [How grafeo-ogm stays correct](./README.md#how-grafeo-ogm-stays-correct) in the README.

## Threat Model

grafeo-ogm is a library that **takes untrusted input and builds Cypher queries**. The threat model assumes the application calling grafeo-ogm may pass user-controlled data through `where`, `select`, `selectionSet`, `input` and other parameters.

### What grafeo-ogm protects against

- **Cypher injection.** Field names, sort fields and labels are validated against a strict identifier regex (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) and backtick-escaped. All values are sent as Cypher parameters (`$param0`), never interpolated into the query string.
- **Prototype pollution.** `__proto__`, `constructor` and `prototype` are blocked as input keys. The result mapper uses `Object.create(null)`.
- **ReDoS through `_MATCHES`.** A `_MATCHES` pattern runs on Neo4j's backtracking Java regex engine and cannot be interrupted once running. The guard fails closed: it accepts a pattern only when it can prove linear-time matching and refuses everything else. The operator can be turned off with `features.filters.String.MATCHES: false`.
- **Resource exhaustion.** Recursion depth is bounded in the where compiler (10), the selection compiler (5) and the result mapper (50); the parse cache is bounded (200 entries).
- **Lucene injection** in fulltext queries. Special characters are escaped before being passed to the fulltext procedures.
- **Authorization bypass, when you configure `policies`.** Node-level security policies are compiled into every read and write that reaches a type: root, nested selection, relationship filters, connect / disconnect, nested create / update and cascade delete. A way around a configured policy is treated as a vulnerability.

### What grafeo-ogm does NOT protect against

- **Authentication.** grafeo-ogm runs with whatever Neo4j credentials you give the driver, and it does not know who the caller is. Authorization is enforced only by the `policies` you configure and the context you bind to them.
- **Rate limiting.** Long-running queries are not throttled; use connection pooling and Neo4j's `db.transaction.timeout`.
- **Business validation.** grafeo-ogm validates the _Cypher safety_ of identifiers, not the _business rules_ of values. Validate inputs (email format, ranges, etc.) in your application.
- **Secrets in logs.** With `Executor.debug = true`, parameter values appear in logs. Strip sensitive values or disable debug in production.
- **Raw Cypher you write.** `@cypher` fields, policy `cypher` fragments and raw queries run as written.

## Hall of Fame

Security researchers credited for responsible disclosure will be listed here.
