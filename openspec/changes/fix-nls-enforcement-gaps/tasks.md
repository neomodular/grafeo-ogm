## 1. Harness and red tests (prove every hole first)

- [x] 1.1 Create branch `fix/nls-enforcement-gaps` from `main`; confirm the full suite and the 17-case golden suite are green (baseline)
- [x] 1.2 Add `tests/integration/nls-enforcement.spec.ts`: skipped unless `NEO4J_URI` is set; `It*`-labelled schema (Tag → Chart ← Category-style shared nodes, an interface with two implementers, write restrictives on Chart), per-run id, cleanup in `afterAll`
- [x] 1.3 Write one live scenario per gap (design Context matrix + H2 + H3) asserting DB outcomes; run it against a local Neo4j and record that each FAILS on the unpatched code (the hole is real). **Recorded 2026-09-23:** disposable Neo4j 5.26.31; v2.2.0 (1741962) → 23/23 fail, every one an assertion on a DB outcome (hidden rows returned, hidden nodes linked, wrong nodes deleted/kept, nested writes accepted), none a setup error
- [x] 1.4 Add mock-driver unit tests per gap asserting the intended emitted Cypher / thrown errors (red), including the byte-identical guard for OGMs without policies and for reads touching no protected type

## 2. H1 — always bind a policy context

- [x] 2.1 Add the shared frozen `NO_ROOT_POLICY` resolution (policy module) with a doc comment tying it to `ResolvedPolicies.overridden` semantics
- [x] 2.2 `Model.resolvePolicyContext`: return a bundle with `NO_ROOT_POLICY` when the binding exists but the root resolves `null`; keep `null` for no binding / bypass
- [x] 2.3 `InterfaceModel`: replace the inline synthetic `overridden: true` bundles with `NO_ROOT_POLICY`
- [x] 2.4 `Model.explainPolicies`: build the bundle with `NO_ROOT_POLICY` when `resolveDetailed` returns `null` (plan stays `unrestricted`)
- [x] 2.5 Add a guard test asserting no target-policy path (`buildTargetBundle`, `compileUnionRelationship`, `compileNestedWhere`, `buildTargetPolicyPredicate`) reads `resolved.overridden`
- [x] 2.6 Green: H1 unit tests pass and all 17 read goldens are byte-identical (the interface golden changes only in 7.3)

## 3. H3 — strict null semantics in WhereCompiler

- [x] 3.1 In `compileConditions`, split the operator suffix (scalar + relationship suffix tables) before handling `null`; implement the D5 table
- [x] 3.2 Reject any other operator with `null` and unknown fields with `null` (regardless of `strictWhere`) with `OGMError` naming the key
- [x] 3.3 Green: null-semantics unit tests (root where, relationship filter, connection `node`, policy `when` partial, `@cypher` field with null)

## 4. D4 — nested-write where compiled by WhereCompiler

- [x] 4.1 Add `connectionWhereToNodeWhere(spec)` (pure; `node`/`node_NOT`/`NOT`/`AND`/`OR`/bare props; `edge`/`edge_NOT` throw) with its own unit tests
- [x] 4.2 Add a mutation-target entry in `WhereCompiler` (or a helper in the mutation compiler) that compiles the mapped where with a `traversalBundle` (`NO_ROOT_POLICY` + caller `resolveForType`) and the shared counter; throw on `@cypher` preludes
- [x] 4.3 Route every nested-write `where` (connect, disconnect, nested update, nested/cascade delete — top-level and nested paths, create and update) through it
- [x] 4.4 Delete `buildConnectionWhereConditions`, `buildNodeWhereConditions`, `tryBuildRelationshipFilter` (and any now-dead helpers); confirm no remaining references. Keep `extractConnectWhereConditions` + `parseOperatorSuffix` ONLY for the narrowed bulk-connect UNWIND fast path (design D4 exception): route items with null values, logical keys, `node_NOT`, or traversals to the per-item WhereCompiler path
- [x] 4.5 Thread ONE shared `paramCounter` (and the bundle) from every `Model` write method into every mutation-compile call (`compileCreate`, `compileUpdate`, `compileDelete`, `compileMerge`, createMany/updateMany/deleteMany paths); add the optional trailing parameters `compileCreate`/`compileDelete` lack
- [x] 4.6 Rewrite affected mutation-compiler tests from param-name assertions to semantic assertions; green

## 5. D2/D3 — nested-write row filters and cascade delete

- [x] 5.1 Generalize `buildTargetPolicyPredicate` with `op: 'read' | 'update' | 'delete'`, mirroring `assertNotDeniedAtCompile` (`onDeny: 'throw'` → `PolicyDeniedError` at compile)
- [x] 5.2 Connect/disconnect: `'read'` on every path, including connect-in-create (`buildCreateRelationshipsForTarget`)
- [x] 5.3 Nested update: AND the target `'update'` predicate into the nested MATCH
- [x] 5.4 Add shared `buildNestedDelete` (per-item `CALL { … DETACH DELETE … }`, `where` via D4, target `'delete'` predicate, single-or-array spec, reject nested `delete` and unknown keys); use it from `compileDelete` and from delete-inside-update
- [x] 5.5 `Model.delete`: pass bundle + counter into `compileDelete`
- [x] 5.6 Green: nested row-filter + cascade unit tests (incl. README cascade example, `{}` semantics, singular relationship, multi-level rejection)

## 5b. H5 — abstract relationship targets (D6b)

- [x] 5b.1 Add `WhereCompiler.compileTargetPolicyClause(typeName, var, op, bundle, counter)`: concrete → own composed clause (null when none); interface/union → `CASE WHEN var:M THEN <M clause|true> … ELSE false END` via `resolveForType(M, op)`, null when every member is `true`; returns preludes to the caller
- [x] 5b.2 `MutationCompiler.buildTargetPolicyPredicate` delegates to it (covers abstract connect/disconnect/nested update/delete targets; nested contexts reject preludes)
- [x] 5b.3 Traversal filters on interface targets (and verify the union path) AND the helper's clause for the target
- [x] 5b.4 `SelectionCompiler` nested projection of interface and union targets applies the helper's clause
- [x] 5b.5 Mock tests (interface + union targets: selection, traversal, connect, byte-identical when no member has policies) and live scenarios

## 6. D2 — application-layer checks on nested input

- [x] 6.1 Extract the create default-deny + write-restrictive evaluation (`evaluateCreatePolicies`) and `evaluateWriteRestrictives` into module-level functions shared by root and nested
- [x] 6.2 Add `src/policy/nested-writes.ts`: schema-driven walker over create/update inputs — nested `create.node` → target `'create'` checks + recurse; nested `update.node` → target `'update'` write restrictives + recurse
- [x] 6.3 Call it from `create`, `update`, `updateMany` before compile. NOT from `createMany` (rejects relationship fields; drops them from later items) or `upsert` (`compileMerge` ignores relationship keys): neither executes nested writes. Both silent-drop behaviours are tracked as separate issues
- [x] 6.4 Green: nested create/update WITH CHECK and default-deny unit tests (in create, in update, depth > 1, single vs array inputs)

## 7. H2 — interface branches

- [x] 7.1 Rebuild `compileInterfacePolicyClause` on the D6b helper (`compileTargetPolicyClause(interface, …)`); keep the interface-override short-circuit; emit no clause when every branch is `true`
- [x] 7.2 Invariant test: each branch text equals `Model(M).find`'s policy clause for the same ctx (several fixtures, incl. interface-only, implementer-only, gated permissives, implementer override)
- [x] 7.3 Deliberately re-pin the `interface model find across implementers` golden (dedupe) with the new expected text; all other goldens unchanged
- [x] 7.4 Verify `InterfaceModel.aggregate`/`count` use the same branches; green

## 8. Verification

- [x] 8.1 Full suite, `tsc --noEmit` (all configs), lint, format:check green
- [x] 8.2 Live suite against a local Neo4j: every scenario from 1.3 now PASSES; record the run. **Recorded 2026-09-23:** same DB, this branch → 23/23 pass; 0 nodes left after both runs
- [x] 8.3 Run `examples/15-policy-explain.ts` and a cascade-delete example against the live DB after a user-run build. **Recorded 2026-09-23:** fresh `pnpm run build` (run at the user's request); `grafeo-ogm` resolved to `dist/cjs`; examples 15 and 05 exit 0; a scratch filtered-cascade check through `dist` (category `where`, singular review spec, shared node kept, multi-level rejected with nothing deleted) passed 9/9
- [x] 8.4 Self-review: re-run the design's Context matrix probe (mock) and confirm every row now enforces

## 9. Docs and release

- [x] 9.1 README: nested-write enforcement principle + table, cascade-delete semantics (where honored, target delete policy, multi-level rejected), null semantics table, update the NLS "Limitations" list (remove fixed items, add `edge` in mutation where), security note for unprotected types
- [x] 9.2 CHANGELOG v2.3.0: **Security** section per hole (H1, H4, nested writes, H3, H2) + **Behavior changes** with migration notes
- [x] 9.3 Decide on a GitHub Security Advisory (check v1.14.0 precedent) — user decision. **Decided 2026-09-23:** publish a GHSA once v2.3.0 is live on npm (v1.14.0 had none)
- [ ] 9.4 Release per runbook: granular signed `fix:` commits (one per hole), `chore: release v2.3.0 — …`, annotated tag, push as `neomodular`, watch Release/CI and npm
