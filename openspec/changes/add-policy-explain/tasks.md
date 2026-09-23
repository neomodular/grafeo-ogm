## 1. Safety net before refactoring

- [x] 1.1 Capture golden Cypher and params from the CURRENT `compilePolicyClause` for every fragment shape: `when`-only, `cypher`-only, both forms in one policy, `when: () => ({})`, restrictive `when: () => false`, abstaining permissive, zero permissives, all permissives abstaining, interface-inherited policies, and a `@cypher` field referenced in a policy partial. Store them in a new `tests/policy/explain-refactor-golden.spec.ts`
- [x] 1.2 Confirm `tests/policy/byte-identical.spec.ts` and the full suite pass on the untouched tree (baseline)

## 2. Resolver: `resolveDetailed()` and the audit fix

- [x] 2.1 Add the `DetailedPolicy` / `DetailedResolution` internal types (`policy`, `kind`, `source`, `index`, `name`, `named`, `applied`, `skipped`) to `src/policy/types.ts`
- [x] 2.2 Implement `PolicyResolver.resolveDetailed(typeName, op, ctx)`: registration order is own type first, then interfaces. Mark overrides after the firing one, and all non-overrides, as `skipped` when an override fires. Evaluate `appliesWhen` for BOTH permissives and restrictives. Build fallback names `<source>.<kind>[<index>]`
- [x] 2.3 Re-express `resolve()` as a projection of `resolveDetailed()`, keeping the return shape, ordering, and the `restrictives` array UNCHANGED (downstream still enforces `appliesWhen`). Filter non-applying restrictives out of `evaluated` only (see design D7 for why)
- [x] 2.4 Add resolver tests: detailed ordering, sources, fallback ids, `skipped` under override, and non-applying restrictives excluded from `evaluated`
- [x] 2.5 Add a `policy-audit-metadata` test: `policiesEvaluated` omits a restrictive whose `appliesWhen` is false, and the emitted Cypher is unchanged

## 3. Compiler: fragments + compose split

- [x] 3.1 Extract `compilePolicyFragments()` from `WhereCompiler.compilePolicyClause`, returning per-policy `{ policy, parts }` for permissives and restrictives. Keep part order, `policy_p<idx>_` numbering, and `paramCounter` advancement identical. Keep the restrictive `appliesWhen` check as defense in depth
- [x] 3.2 Extract `composePolicyClause()` reproducing today's string exactly: the default-deny `false` paths, `permClause` / `restClause` joins, and the `restClause === 'true'` elision
- [x] 3.3 Rewire `compilePolicyClause` as `compose(fragments)`. Expose a package-internal entry point that returns fragments, the composed clause, and preludes for the explain path
- [x] 3.4 Run the golden (1.1) and byte-identical suites and the full policy test directory. They must pass with ZERO emission diff

## 4. Executor: READ access mode

- [x] 4.1 Add an optional, additive 4th parameter `{ accessMode?: 'READ' | 'WRITE' }` to `Executor.execute`, honored only on the auto-commit path via `driver.session({ defaultAccessMode })`
- [x] 4.2 Test: auto-commit with `READ` opens the session in READ mode; caller-supplied `transaction` / `session` is used unchanged; the default path is unchanged

## 5. `Model.explainPolicies()`

- [x] 5.1 Add the public types `PolicyClauseOutcome`, `PolicyClauseExplanation`, and `PolicyExplanation<T>` in `src/policy/types.ts`, and export them from `src/index.ts`
- [x] 5.2 Implement the guards: no policy binding or global bypass → `OGMError`; `select` together with `selectionSet` → `OGMError`; limit defaults to 100 and throws above 1,000. Never throw `PolicyDeniedError`
- [x] 5.3 Build the query per design D6: MATCH with labels; the candidate `where` compiled as in `find` (same order, same `paramCounter`, policy-aware traversal); `__where` preludes; `WHERE` with the user body only; a `WITH n, [...] AS __explain_outcomes, coalesce((<composed>), false) AS __explain_visible`. Per-clause values are OR of parts for permissives and AND of parts for restrictives, and policies without parts are excluded from the list
- [x] 5.4 Carry the explain variables through the `__sel` scope (`preserveVars`) and the sort prelude (`compileOptions` preserveVars). RETURN the selection projection plus both explain variables, then apply ORDER BY / SKIP / LIMIT
- [x] 5.5 Map results: selection → `node` via `ResultMapper`; the outcomes list → per-entry `pass` / `fail` / `null` (positionally aligned with the descriptors); merge in the `abstain`, `not-applied`, and `skipped` entries from `resolveDetailed`; compute `permissiveGranted`, `failedRestrictives`, and `overriddenBy`
- [x] 5.6 Recompute `visible` in JS and assert equality with `__explain_visible` per candidate. On mismatch, throw `OGMError` with the type and candidate index
- [x] 5.7 Handle the override path (no predicate; `visible: true`; override reported as `pass`, others `skipped`) and the no-policies path (`visible: true`, `policies: []`)
- [x] 5.8 Emit `logger.warn` on every call, and attach audit metadata with `operation: 'read'` and `explain: true`, regardless of `auditMetadata: false`
- [x] 5.9 Execute with `accessMode: 'READ'` on the auto-commit path

## 6. Explain tests (`tests/policy/explain.spec.ts`)

- [x] 6.1 Guards: an unbound model throws, a global-bypass OGM throws, `select` together with `selectionSet` throws, the limit default is 100, and a limit of 1001 throws
- [x] 6.2 Clause forms: a `when:` restrictive fail, a `cypher:` restrictive fail, and a restrictive with both forms (AND). A permissive with both forms (OR)
- [x] 6.3 No short-circuit: two failing restrictives are both reported and both appear in `failedRestrictives`
- [x] 6.4 Applicability: permissive and restrictive `appliesWhen` false → `not-applied`. A non-firing override → `not-applied`. A firing override → `pass`, others `skipped`, all visible
- [x] 6.5 Outcomes: NULL → `null`; `{}` → `pass`; a hard deny → `fail`; a permissive abstain → no grant; a restrictive abstain → no restriction; default deny with `onDeny: 'throw'` does not throw
- [x] 6.6 Fidelity: the emitted explain query contains the exact composed clause from the `find` compile for the same ctx, and the param names and values match `find`. A forced-mismatch fixture rejects with `OGMError`
- [x] 6.7 Identity: fallback `<source>.<kind>[<index>]` for unnamed policies, `named` flags, duplicate names kept positional, and interface-inherited entries carry the interface as `source`
- [x] 6.8 Selection: full `select` with a relationship whose target policy hides nodes; a `@cypher` field in both a policy partial and the selection (explain variables survive the `__sel` / sort preludes); sort, offset, and labels
- [x] 6.9 Security: policy fragment params are namespaced; the injection-style inputs from `where-injection.spec.ts` / `parameter-injection-attack.spec.ts` are rejected on the explain path too; `warn` is called; audit metadata carries `explain: true`; auto-commit uses READ mode
- [x] 6.10 If a Neo4j integration harness exists, add an end-to-end check that the set of candidates with `visible: true` equals the `find` result for the same ctx and data. Otherwise, record that this check is covered by the Cypher-level fidelity tests only — **No harness exists** (the test suite is mock-driver only; live-DB code lives in `examples/`, driven by `NEO4J_URI`). Covered by the Cypher-level fidelity tests in `tests/policy/explain.spec.ts` (6.6); `examples/15-policy-explain.ts` asserts the same `visible` ⇔ `find` equivalence at runtime against a live Neo4j.

## 7. Docs and release prep

- [x] 7.1 README NLS section: `explainPolicies` usage, the outcome vocabulary, the admin-only / bypass warning, READ-mode semantics and the caller-supplied session caveat, and limits
- [x] 7.2 Add `examples/15-policy-explain.ts` in the style of the existing examples
- [x] 7.3 CHANGELOG entry for v2.2.0: the new method, exported types, and the `policiesEvaluated` correction (an observable change for non-applying restrictives)
- [x] 7.4 Run `pnpm run lint`, `pnpm run format:check`, and the full `pnpm run test`; fix any findings
- [x] 7.5 Reply on GitHub issue #6 with the design summary (user approval required before posting), and ask whether a sanitized copy of the 62-clause policy corpus can be shared as a fixture — **Resolved per the project's usual release flow:** the issue is closed by `Closes #6` in the feat commit; no separate comment was posted (user chose the standard flow). The 62-clause corpus request remains open for a follow-up.
