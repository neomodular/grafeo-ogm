## Why

While implementing issue #6 (v2.2.0), we traced and probe-verified several existing gaps in Node-Level Security enforcement. They let a bound context **read, link, modify, create and delete** nodes that the target type's policies forbid, and in one case delete unrelated data without any policy involved at all. The underlying problem is that target-type enforcement only happens on some paths: it disappears when the root type has no policies, it was never added to most nested write operations, and a parallel `where` implementation inside the mutation compiler has drifted from `WhereCompiler`, including its policy threading, since v1.8.5. This is a security release.

## What Changes

- **Unprotected-root gateway (H1, critical).** When the root type has no policies of its own, the policy context is currently dropped. As a result, nested selection, `_SOME`/`_NONE`/`_ALL`/`_SINGLE`/`Connection` traversal filters, and connect/disconnect targets all skip the *target* type's policies. After this change, a policy-bound model always carries a policy context; a root with no policies simply contributes no root clause. `explainPolicies` gets the same fix.
- **Cascade delete (H4, critical).** `Model.delete`'s nested `delete` currently ignores its `where`, so the README's own example deletes **every** related node, including nodes shared with other records, and never checks the target's policies. After this change it honors the per-relationship `where` and is gated by the target type's `delete` policy. **BREAKING-ish:** callers passing a `where` now delete only the matching nodes (the documented behavior); multi-level cascade (a `delete` inside a delete spec, previously ignored) now throws.
- **Every nested write enforces the target type's policies**, on one principle: *a nested write enforces exactly what the equivalent direct write on the target type would*.
  - delete inside `update`: the target's `delete` policy
  - nested `update`: the target's `update` row filter, plus its write restrictives (WITH CHECK) applied to the nested input
  - nested `create` (inside `create` or `update`): the target's `create` permissive (default-deny), plus its write restrictives applied to the nested input
  - connect/disconnect: keep the target's `read` policy, now on every path
- **Strict null semantics in `where` (H3, high).** `{ field_NOT: null }` currently compiles to an always-true `` n.`field_NOT` IS NULL ``. It will compile to `IS NOT NULL`. A relationship with `_NOT: null` compiles to `EXISTS`. Any other operator with `null`, or an unknown field with `null`, throws `OGMError` even without `strictWhere`. **BREAKING-ish** for inputs that previously compiled into a filter that silently did nothing.
- **Nested-write `where` is compiled by `WhereCompiler`.** The mutation compiler's parallel builder is removed. Nested writes gain identical operator support, strict null semantics, correct labels for abstract relationship targets, and traversal-policy enforcement. Their emitted Cypher changes shape: parameters come from the shared `paramN` counter. `edge` filters in mutation `where` remain unsupported and still throw.
- **Interface reads (H2, medium).** An implementer whose permissives are all gated off by `appliesWhen` is currently treated as unconstrained by `InterfaceModel` (`THEN true`), while `Model.find` denies it. After this change each `CASE` branch is built from the implementer's own resolution, so it equals `Model(<Impl>).find`'s clause. This also removes the duplicated interface predicates.
- **Abstract relationship targets (H5, critical).** Found during implementation and probe-verified. When a relationship points at an **interface or union**, the concrete implementers' policies are never applied: not in nested selection, not in traversal filters, and not in nested writes. Enforcement resolved the *abstract* type's name, which carries only interface-level policies, or none for a union. After this change, an abstract target's policy is a `CASE` over its concrete members' own clauses. The same shared helper builds `InterfaceModel`'s root branches (H2).
- **Opt-in live Neo4j integration suite.** It runs only when `NEO4J_URI` is set, so CI is unchanged. It proves each hole end to end against a real database, before and after the fix.

## Capabilities

### New Capabilities
- `policy-target-enforcement`: Target-type policies are enforced for nested selection, traversal filters and connect/disconnect whenever a policy context is bound, regardless of whether the root type has policies.
- `policy-nested-writes`: Nested delete, update and create enforce the target type's policies for that operation, exactly as a direct write would. This includes the corrected cascade-delete `where` semantics.
- `where-null-semantics`: How `null` values are interpreted by every `where` compiler, including nested-write `where`, which is now compiled by `WhereCompiler`.
- `policy-interface-branches`: `InterfaceModel` policy branches are equivalent to each implementer's own `Model` policy clause.
- `policy-abstract-targets`: Interface- and union-typed relationship targets enforce each concrete member's own policy, on reads and nested writes.
- `nls-integration-suite`: The opt-in live-database verification suite for NLS enforcement.

### Modified Capabilities
<!-- None: no existing spec in openspec/specs/ covers these areas. -->

## Impact

- **Code**:
  - `src/model.ts`: always bind a policy context; cascade delete and nested-write policy wiring; the `explainPolicies` bundle.
  - `src/compilers/mutation.compiler.ts`: cascade/nested delete, nested update/create policy predicates, removal of the parallel where builder.
  - `src/compilers/where.compiler.ts`: null semantics; an entry point for nested-write targets.
  - `src/interface-model.ts`: branch construction.
  - `src/policy/*`: a shared no-root-policy resolution and nested-write policy evaluation.
- **Emitted Cypher**:
  - Unchanged for OGMs without policies, and for reads where neither the root nor any reached type has policies. Pinned by the existing golden suites.
  - Changed by design for: reads that reach policy-protected types through unprotected roots; every nested write that has a `where`, has a policy-protected target, or both; `InterfaceModel` reads with policies; and cascade deletes.
- **Behavior changes** (minor version, following the v1.14.0 / v2.1.0 bar):
  - Nested writes into protected types can now be filtered or denied.
  - Cascade `where` is honored.
  - Multi-level cascade throws.
  - Unsupported or unknown null filters throw.
  - `field_NOT: null` flips from always-true to `IS NOT NULL`.
- **Tests**: new red-first regression tests per hole, an update to the 17-case golden (only the `InterfaceModel` case changes, deliberately), and a new `tests/integration/` suite that is skipped when `NEO4J_URI` is unset.
- **Docs**: a README security note, cascade-delete and nested-write semantics, null semantics, and an updated NLS limitations list; a CHANGELOG security section.
- **Release**: v2.3.0.
