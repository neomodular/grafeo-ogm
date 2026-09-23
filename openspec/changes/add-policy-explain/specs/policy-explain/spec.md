## ADDED Requirements

### Requirement: Dedicated explain method on policy-bound models
The system SHALL expose `Model.explainPolicies(params)` accepting `where`, `select` or `selectionSet`, `labels`, `options` (`limit`, `offset`, `sort`), and `context` (an `ExecutionContext`). It SHALL resolve to an array of `PolicyExplanation` entries, one per candidate node. `find` and every other existing method SHALL NOT change signature or behavior.

#### Scenario: Explain on a policy-bound model
- **WHEN** `ogm.withContext(ctx).model('Chart').explainPolicies({ where: { id_IN: ids } })` is called
- **THEN** it resolves to one `PolicyExplanation` per matching candidate, each containing `node`, `visible`, `overriddenBy`, `permissiveGranted`, `failedRestrictives`, and `policies`

#### Scenario: Model without a policy binding
- **WHEN** `explainPolicies` is called on a model obtained from `ogm.model(...)` without `withContext`
- **THEN** it rejects with `OGMError` stating that a policy-bound model is required

#### Scenario: Global-bypass OGM
- **WHEN** `explainPolicies` is called on a model from `ogm.unsafe.bypassPolicies()`
- **THEN** it rejects with `OGMError`

#### Scenario: Mutually exclusive selection inputs
- **WHEN** both `select` and `selectionSet` are provided
- **THEN** it rejects with `OGMError`, matching `find`

### Requirement: Candidate selection mirrors the enforced read minus the root policy predicate
The explain query SHALL select candidates using the caller's `where` and `labels` compiled exactly as `find` compiles them: same compile order, same parameter names, and still enforcing target-type policies on relationship traversals. It SHALL NOT filter candidates by the root type's policy clause.

#### Scenario: Rejected nodes are returned
- **WHEN** a candidate matches `where` but fails a restrictive policy
- **THEN** it is present in the result with `visible: false`

#### Scenario: Non-matching candidates are absent
- **WHEN** a candidate id in `where` does not exist or does not match `where` / `labels`
- **THEN** no entry is returned for it

#### Scenario: Parameter parity with find
- **WHEN** `explainPolicies` and `find` are compiled for the same `where` and the same bound context
- **THEN** the user-where and policy parameter names and values in the explain query are identical to those in the `find` query

### Requirement: Every clause form is explained
The system SHALL report an entry for every `read` policy matching the type (own and interface-inherited) in registration order: own type first, then interfaces. This covers overrides, permissives, and read restrictives, in both the `when:` form and the `cypher: { fragment, params }` form. A policy declaring both forms SHALL be reported as one entry whose value combines its parts with OR for permissives and with AND for restrictives.

#### Scenario: Raw-Cypher restrictive attributed
- **WHEN** a restrictive defined with `cypher: { fragment, params }` evaluates to false for a candidate
- **THEN** that policy's entry has `applied: true` and `outcome: 'fail'`, and its name appears in `failedRestrictives`

#### Scenario: Declarative restrictive attributed
- **WHEN** a restrictive defined with `when: (ctx) => ({ ... })` evaluates to false for a candidate
- **THEN** that policy's entry has `outcome: 'fail'`

#### Scenario: Restrictive with both forms
- **WHEN** a restrictive declares both `when` and `cypher` and only the `cypher` part is false for a candidate
- **THEN** that single entry has `outcome: 'fail'`

#### Scenario: Permissive with both forms
- **WHEN** a permissive declares both `when` and `cypher` and only one part is true for a candidate
- **THEN** that single entry has `outcome: 'pass'`

### Requirement: No short-circuiting across clauses
The system SHALL evaluate every applied permissive and restrictive for every candidate, regardless of the outcomes of other clauses.

#### Scenario: Two failing gates are both reported
- **WHEN** a candidate fails two different restrictives
- **THEN** both entries have `outcome: 'fail'`, and both names appear in `failedRestrictives`

### Requirement: appliesWhen is reported distinctly
A policy whose `appliesWhen(ctx)` returns false SHALL be reported with `applied: false` and `outcome: 'not-applied'`, and SHALL NOT be compiled or evaluated. An override whose `when(ctx)` returns false SHALL be reported the same way.

#### Scenario: Non-applying restrictive
- **WHEN** a restrictive's `appliesWhen(ctx)` returns false
- **THEN** its entry has `applied: false` and `outcome: 'not-applied'` for every candidate

#### Scenario: Non-applying permissive
- **WHEN** a permissive's `appliesWhen(ctx)` returns false
- **THEN** its entry has `applied: false` and `outcome: 'not-applied'`

### Requirement: Outcome vocabulary
Each applied, evaluated clause SHALL report exactly one outcome:
- `pass`: the clause value is true.
- `fail`: the value is false, including a restrictive `when` returning `false`.
- `null`: the value is NULL.
- `abstain`: the policy emitted no predicate. For a permissive this means `when` returned a falsy value or `cypher.fragment` returned `''`. For a restrictive it means `when` returned `true`, `null`, `undefined`, or `{}`, or `cypher.fragment` returned `''`.

#### Scenario: NULL is distinct from false
- **WHEN** a restrictive compares a property that is absent on the candidate
- **THEN** its entry has `outcome: 'null'` and its name appears in `failedRestrictives`

#### Scenario: Empty-partial permissive
- **WHEN** a permissive's `when` returns `{}`
- **THEN** its entry has `outcome: 'pass'`

#### Scenario: Abstaining permissive grants nothing
- **WHEN** the only applied permissive returns `null` from `when`
- **THEN** its entry has `outcome: 'abstain'`, `permissiveGranted` is false, and `visible` is false

#### Scenario: Abstaining restrictive restricts nothing
- **WHEN** a restrictive's `when` returns `null`
- **THEN** its entry has `outcome: 'abstain'` and it does not cause `visible: false`

### Requirement: Override and no-policy reporting
When an override fires, the system SHALL report it with `applied: true` and `outcome: 'pass'`, set `overriddenBy` to its name, mark every other entry `outcome: 'skipped'`, and set `visible: true` for every candidate. When no policies are registered for the type, every candidate SHALL have `visible: true` and `policies: []`.

#### Scenario: Override fires
- **WHEN** an override's `when(ctx)` returns true
- **THEN** every candidate has `visible: true` and `overriddenBy` set to the override name, and all other entries are `skipped`

#### Scenario: Type has no policies
- **WHEN** the model's type and its interfaces have no registered policies
- **THEN** every candidate has `visible: true` and `policies: []`

### Requirement: Verdict fidelity with enforcement
`visible` SHALL equal the truth value of the exact policy predicate that `find` would enforce for the same bound context, computed in Cypher as `coalesce(<composed clause>, false)`. The system SHALL independently recompute `visible` from the per-clause outcomes. If the two disagree, it SHALL reject with `OGMError` instead of returning results.

#### Scenario: Visible matches find
- **WHEN** `explainPolicies` and `find` run with the same `where`, the same labels, and the same bound context against the same data
- **THEN** the set of candidates with `visible: true` equals the set of nodes returned by `find`

#### Scenario: Default deny
- **WHEN** no permissive applies for the bound context
- **THEN** every candidate has `visible: false` and `permissiveGranted: false`, and no `PolicyDeniedError` is thrown even when `onDeny` is `'throw'`

#### Scenario: Internal inconsistency
- **WHEN** the JS-recomputed verdict differs from the Cypher-computed verdict for any candidate
- **THEN** the call rejects with `OGMError` and returns no explanations

### Requirement: Stable identifiers for unnamed policies
A policy without a `name` SHALL be reported under the fallback identifier `<source>.<kind>[<index>]`, where `index` is its position in the registering source's policy list, and SHALL have `named: false`. Named policies SHALL have `named: true`. Duplicate names SHALL be reported as separate positional entries.

#### Scenario: Unnamed restrictive
- **WHEN** the fourth policy registered on `Chart` is an unnamed restrictive
- **THEN** its entry has `name: 'Chart.restrictive[3]'` and `named: false`

### Requirement: Read-only execution
When grafeo opens the session itself, explain SHALL run in a session with `READ` access mode. It SHALL NOT assert indexes or constraints or perform any write. When the caller supplies a `transaction` or `session`, explain SHALL run on it unchanged.

#### Scenario: Auto-commit session is READ
- **WHEN** `explainPolicies` is called without a `transaction` or `session`
- **THEN** the driver session is opened with `defaultAccessMode` `READ`

#### Scenario: Caller-supplied session
- **WHEN** `context.session` is provided
- **THEN** the query runs on that session and no new session is opened

### Requirement: Explicit bypass signalling and bounds
Every `explainPolicies` call SHALL emit a `warn` log naming the type. It SHALL attach audit metadata with `operation: 'read'` and `explain: true`, even when `policyDefaults.auditMetadata` is false. `options.limit` SHALL default to 100. A limit greater than 1,000 SHALL be rejected with `OGMError`.

#### Scenario: Warn log
- **WHEN** `explainPolicies` is called with a logger that implements `warn`
- **THEN** `warn` is called once, with a message naming the model type

#### Scenario: Audit tag
- **WHEN** `explainPolicies` runs on an OGM with `auditMetadata: false`
- **THEN** transaction metadata is still attached and includes `explain: true`

#### Scenario: Default limit
- **WHEN** no `options.limit` is given
- **THEN** the query is bounded to 100 candidates

#### Scenario: Limit above maximum
- **WHEN** `options.limit` is 1001
- **THEN** the call rejects with `OGMError`

### Requirement: Full selection with nested policies preserved
`explainPolicies` SHALL accept any `select` or `selectionSet` accepted by `find`, including relationships, connections, and `@cypher` fields. Nested relationship targets SHALL be filtered by their own target-type policies exactly as in `find`. Explanations SHALL cover only the root type's policies.

#### Scenario: Nested relationship still filtered
- **WHEN** the selection includes a relationship whose target type has a restrictive that hides some related nodes from the bound context
- **THEN** `node` omits those related nodes, and `policies` lists only root-type policies

#### Scenario: @cypher field in selection and policy
- **WHEN** a policy's `when` partial and the selection both reference `@cypher` fields
- **THEN** the query executes, and the per-clause outcomes and `node` values are correct
