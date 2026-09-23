## Why

When a policy-bound read filters a node out, callers can only see *that* it disappeared, never *which* named policy clause rejected it. The NLS compiler ANDs/ORs every clause into one `WHERE` predicate, so attribution is lost at compile time. Downstream workarounds are either impossible (policies are bound at OGM construction; `withContext` cannot drop individual clauses) or dangerous (re-implementing raw-Cypher clauses outside grafeo guarantees drift, and a confidently wrong explanation is worse than none). grafeo is the only layer holding every clause in a uniform, executable form. Requested in GitHub issue #6 by a consumer running an admin-only "why can / can't this user see this resource" diagnostic over a 62-clause policy set (41 raw-Cypher, 21 declarative).

## What Changes

- **New `Model.explainPolicies()` method** (dedicated, NOT a flag on `find`). Given a candidate `where`, it returns every candidate node **including nodes the policies would reject**, each annotated with a per-clause report: name, kind (override / permissive / restrictive), source type, whether `appliesWhen` held, and an outcome (`pass` | `fail` | `null` | `abstain` | `not-applied` | `skipped`), plus the overall `visible` verdict.
- Covers **both clause forms** (`when:` where-partials and `cypher: { fragment, params }`), evaluates **every** applied clause without short-circuiting, and reports `appliesWhen` as a distinct "not applied" answer rather than folding it into a pass.
- **Single source of truth**: the explain query projects the *exact* compiled fragments the enforcement path uses, and derives `visible` from the *literal* enforcement predicate. A JS-side recomputation from the per-clause outcomes is cross-checked against it; any mismatch throws instead of returning an explanation.
- **Strictly read-only**: when grafeo opens its own session, explain opens it in `READ` access mode, so the server rejects writes. No index or constraint assertion.
- **Explicit policy-bypass surface**: explain deliberately returns rows the bound context cannot see. Every call logs a `warn` (same tier as `unsafe.bypassPolicies`) and tags audit metadata with `explain: true`. Candidate count is capped (default 100, max 1,000).
- Supports full `select` / `selectionSet` including relationships. Nested relationships remain filtered by their own target-type policies, exactly as in `find`.
- **Internal refactor, no behavior change**: `WhereCompiler.compilePolicyClause` is split into `compilePolicyFragments()` (structured per-policy parts) + `composePolicyClause()` (byte-identical to today's output). `PolicyResolver` gains `resolveDetailed()` (every matching policy with `applied` flag, source, and registration index); `resolve()` is derived from it.
- **Audit-metadata fix**: `policiesEvaluated` currently lists restrictives whose `appliesWhen(ctx)` returned false, contradicting its documented meaning ("names of policies that fired"). It will list only policies that applied. Compiled Cypher is unaffected; the metadata array gets shorter in that case (observable, not breaking).
- v1 scope: `Model` + `read` operation only. `InterfaceModel`, `count` / `aggregate` / `delete`, and fulltext / vector candidate selection are out of scope.

## Capabilities

### New Capabilities
- `policy-explain`: Per-clause, per-node explanation of NLS read-policy outcomes via `Model.explainPolicies()`, covering candidate selection, clause reporting semantics, verdict fidelity, read-only execution, bypass gating, and result shape.
- `policy-audit-metadata`: Correctness contract for the `policiesEvaluated` audit-metadata field attached to policy-bound queries: it reports only the policies that actually applied.

### Modified Capabilities
<!-- None: no existing spec in openspec/specs/ covers the policy engine. -->

## Impact

- **Code**: `src/compilers/where.compiler.ts` (fragment/compose split), `src/policy/resolver.ts` (`resolveDetailed`, restrictive `appliesWhen` in resolver), `src/policy/types.ts` (explain result types), `src/model.ts` (`explainPolicies`), `src/execution/executor.ts` (optional access mode for auto-commit sessions), `src/index.ts` (type exports).
- **Public API**: additive only. New `Model.explainPolicies()` method, new exported types (`PolicyExplanation`, `PolicyClauseExplanation`, `PolicyClauseOutcome`), additive optional executor access-mode option. No change to `find` or any existing signature.
- **Emitted Cypher**: unchanged for every existing read and write path (pinned by `tests/policy/byte-identical.spec.ts`).
- **Audit metadata**: `policiesEvaluated` no longer includes non-applying restrictives. `explainPolicies` calls add `explain: true`.
- **Dependencies**: none added. Uses `neo4j-driver` session access mode (available in the supported `^5 || ^6` range).
- **Docs**: README NLS section, CHANGELOG, new `examples/15-policy-explain.ts`.
- **Release**: minor version (v2.2.0).
