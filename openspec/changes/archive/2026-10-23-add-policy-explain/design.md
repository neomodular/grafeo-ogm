## Context

The NLS policy engine (v1.7.0+) resolves and compiles policies in two stages:

1. **Resolution**: `PolicyResolver.resolve(typeName, op, ctx)` in `src/policy/resolver.ts` gathers the type's own policies plus those inherited from implemented interfaces, filters them by operation, applies the override short-circuit (the first override whose `when(ctx)` is true wins, and the query emits no predicate), and drops permissives whose `appliesWhen(ctx)` is false. Restrictives are **not** filtered by `appliesWhen` here, yet they are still pushed into `evaluated`.
2. **Compilation**: `WhereCompiler.compilePolicyClause` in `src/compilers/where.compiler.ts` turns each policy into zero or more parenthesized boolean fragments over the node variable:
   - Permissive `when` returns a where-partial, compiled through `compileConditions`. `{}` becomes `true`; a falsy return abstains and emits nothing.
   - `cypher.fragment` text has its params namespaced to `policy_p<idx>_*`. An empty string emits nothing.
   - Restrictive `when` may return `false`, which emits the literal `false`.
   - Restrictives whose `appliesWhen` is false are skipped at this stage.
   - A policy that declares **both** `when` and `cypher` emits two fragments.
   - Fragments compose as `(P1 OR P2 …) AND R1 AND R2 …`. When no permissive is resolved, the clause is the literal `false` (default deny). When permissives are resolved but none emits a fragment, it is also `false`, per the v1.8.2 security fix.

`Model.find` in `src/model.ts` compiles the user `where` first, then the policy clause, sharing one `paramCounter` and one `CypherFieldScope` (`__where`). `@cypher` fields referenced by either part become `CALL { … } WITH n, … AS __where_n_<field>` preludes emitted before `WHERE`. Selection-level `@cypher` fields produce a second scope (`__sel`), whose `WITH` lines carry only `preserveVars` plus that scope's own aliases.

The policy context is bound through `ogm.withContext(ctx)`, which deep-freezes a snapshot. The `context` parameter on `find` is the `ExecutionContext` (transaction / session / metadata), not the policy context. The OGM constructor performs no database writes; `assertIndexesAndConstraints()` runs only when called explicitly.

Stakeholder: the issue #6 reporter runs an admin-only diagnostic assistant. They need name → outcome per candidate node, over both clause forms, including rejected nodes, in a read-only path.

## Goals / Non-Goals

**Goals:**
- Explain, per candidate node, the outcome of every read policy that the real `find` would enforce for the same bound context.
- Guarantee the explanation cannot drift from enforcement. The explain path consumes the same compiled fragments, and its verdict is computed from the literal enforcement predicate.
- Keep every existing emitted query byte-identical.
- Be read-only by construction on grafeo-managed sessions.
- Make the policy bypass explicit, logged, and bounded.

**Non-Goals:**
- `InterfaceModel` support. Its per-implementer `CASE` composition is a separate path; see Open Questions.
- Operations other than `read` (`count`, `aggregate`, `delete`).
- Fulltext and vector candidate selection.
- Explaining nested-relationship policy outcomes inside the selection.
- Query planning or timing data, and human-readable prose. Clause names are the contract.
- Write-restrictive (`create` / `update`) explanation.

## Decisions

### D1. Dedicated method, not a flag on `find`

`Model.explainPolicies(params)` returns `Promise<PolicyExplanation<T>[]>`.

*Why:* explain inverts `find`'s core semantics (filter → annotate) and changes its return type. A boolean on the main read path would need return-type overloads across `find` / `findFirst` / `findUnique` / `*OrThrow`. Worse, it turns the hottest read path into a policy bypass controlled by a single flag, so one `explain: req.query.debug` would leak every restricted row. A separate method keeps `find` untouched, makes the bypass visible in code review, and can be grepped for.

*Alternative rejected:* `find({ explain: true })`, as literally proposed in the issue.

### D2. Split compile into fragments + compose (single source of truth)

`compilePolicyClause` is refactored into:
- `compilePolicyFragments(bundle, nodeVar, nodeDef, paramCounter, scope, paramsTarget)` returns `{ permissives: CompiledPolicy[]; restrictives: CompiledPolicy[] }`, where `CompiledPolicy = { policy, parts: string[] }`. Parts are exactly the strings pushed today, in the same order: for each policy, the `when` part first, then the `cypher` part. `policy_p<idx>_` numbering and `paramCounter` advancement are unchanged.
- `composePolicyClause(fragments, resolved)` flattens the parts and returns exactly the string produced today, including the `false` default-deny paths and the `restClause === 'true'` elision.

`compilePolicyClause` becomes `composePolicyClause(compilePolicyFragments(...))`. The existing byte-identical suite, plus new golden tests over the refactor, pins zero emission change.

*Why:* re-deriving clause predicates anywhere else, even inside grafeo, recreates the drift problem the feature exists to eliminate. The explain path must consume the enforcement path's own compiled artifacts.

*Alternative rejected:* a parallel "explain compiler". It would be simpler to write, but it is the same bug in a new location.

### D3. Per-clause value semantics follow the composition operator of the clause's kind

A single policy can have two parts (`when` + `cypher`). Its per-clause value reflects how those parts combine in enforcement:
- **Permissive**: parts are OR-ed into the permissive disjunction, so the clause value is `(part1 OR part2)`.
- **Restrictive**: parts are AND-ed into the restrictive conjunction, so the clause value is `(part1 AND part2)`.
- **No parts** (applied, but emitted no predicate): `abstain`. A permissive abstain grants nothing; a restrictive abstain restricts nothing. This is resolved in JS without projection.

### D4. Outcome vocabulary

| Outcome | Meaning |
|---|---|
| `pass` | Applied; the projected clause value is `true` (includes `when: () => ({})` → `true`). |
| `fail` | Applied; the value is `false` (includes a restrictive hard deny `when: () => false`). |
| `null` | Applied; the value is NULL (three-valued logic, e.g. a missing property). Enforcement treats it as not-true. It is kept distinct from `fail` because the operator's fix differs. |
| `abstain` | Applied, but the policy emitted no predicate (see D3). |
| `not-applied` | `appliesWhen(ctx)` was false (for an override: `when(ctx)` was false). Not compiled. |
| `skipped` | Not evaluated because an earlier override fired (the resolver short-circuit). |

The issue asks for `applied` to be reported distinctly rather than folded into a pass; `applied: boolean` is carried alongside `outcome`.

### D5. Verdict = the literal enforcement predicate, cross-checked in JS

The explain query projects both of the following for each candidate:
- `__explain_outcomes`: a list with one entry per applied policy that has parts, holding its D3 clause value. Order is aligned positionally with the JS-side descriptor list.
- `__explain_visible`: `coalesce((<composePolicyClause output>), false)`, i.e. the exact predicate `find` would put in `WHERE`.

JS recomputes `visible` from the outcomes: some permissive is `pass`, and every restrictive is `pass` or `abstain`. It asserts equality with `__explain_visible`. The composition uses only `AND` / `OR`, which are monotone, so mapping NULL to false at the leaves yields the same truth value as `coalesce(…, false)` at the root. A mismatch therefore signals an engine bug. It raises `OGMError` and never returns a possibly wrong explanation.

*Cost:* each fragment is evaluated twice per candidate, once in the list and once in the composed predicate. This is acceptable for a bounded diagnostic call.

*Alternative rejected:* computing `visible` only in JS. It is cheaper, but it would no longer prove that compose semantics equal per-clause semantics, which is the fidelity guarantee the consumer needs in a safety-adjacent domain.

### D6. Query shape: policy predicate moves from `WHERE` into a projection

```
MATCH (n:`Chart`[:`ExtraLabel`…])
<__where preludes: user where + policy-partial @cypher fields>
WHERE <user where only>                        -- omitted when empty
WITH n, [<c0>, <c1>, …] AS __explain_outcomes,
        coalesce((<composed clause>), false) AS __explain_visible
<__sel preludes, preserveVars = [__explain_outcomes, __explain_visible]>
<sort prelude,  preserveVars = sel aliases + explain vars>
RETURN <selection projection>, __explain_outcomes, __explain_visible
ORDER BY … SKIP … LIMIT $options_limit
```

- The candidate `where` compiles exactly as in `find`: same compile order, same `paramCounter`, and still policy-aware for relationship traversal. The explain query therefore uses the same parameter names and bindings as the enforced read. Definition: *explain = the real read with the root policy predicate moved from the filter into the projection.*
- Outcomes are computed in a `WITH` immediately after the candidate `WHERE`, because selection-scope `WITH` lines drop `__where_*` aliases (they carry only `preserveVars` plus their own aliases). The explain variables are passed as `preserveVars` into the `__sel` scope and the sort prelude.

### D7. Resolver: `resolveDetailed()` as the single `appliesWhen` authority

`PolicyResolver.resolveDetailed(typeName, op, ctx)` returns `{ overriddenBy: string | null; entries: DetailedPolicy[] }`, where `DetailedPolicy = { policy, kind, source, index, name, named, applied, skipped }`. Here `source` is the registering type or interface, and `index` is the position in that source's registration list.

`resolve()` is re-expressed as a projection of `resolveDetailed()`, keeping the same return shape and ordering. **The `restrictives` array is unchanged**: it still holds every operation-matching restrictive, and `appliesWhen` is still enforced downstream (the compiler for read restrictives, `evaluateWriteRestrictives` for write ones). **Only `evaluated` is filtered**: restrictives whose `appliesWhen(ctx)` is false are no longer listed, which fixes the audit over-report. `appliesWhen` is documented as a pure compile-time gate, so evaluating it in both the resolver and downstream is safe.

*Why not drop non-applying restrictives from `restrictives`?* (Found during implementation.) `InterfaceModel.compileInterfacePolicyClause` treats an implementer whose merged permissives and restrictives are both empty as unconstrained (`WHEN n:<Impl> THEN true`). A non-applying restrictive currently keeps that list non-empty, which forces the branch through the default-deny compile path. Dropping it would flip such a branch from `false` to `true`, a policy bypass via the interface model. A probe confirmed that the permissive-only variant of this bypass **already exists** (an implementer whose only permissives are gated off by `appliesWhen` is `false` via `Model.find` but `true` via `InterfaceModel.find`). That is tracked as a separate security fix, outside this change.

Unnamed policies receive the fallback id `<source>.<kind>[<index>]` with `named: false`. Duplicate names are allowed: report entries are positional, not keyed.

### D8. Result shape

```ts
type PolicyClauseOutcome = 'pass' | 'fail' | 'null' | 'abstain' | 'not-applied' | 'skipped';

interface PolicyClauseExplanation {
  name: string;          // policy.name ?? '<source>.<kind>[<index>]'
  named: boolean;
  kind: 'override' | 'permissive' | 'restrictive';
  source: string;        // type or interface that registered it
  applied: boolean;
  outcome: PolicyClauseOutcome;
}

interface PolicyExplanation<T> {
  node: T;                             // the selected projection
  visible: boolean;                    // === enforcement verdict
  overriddenBy: string | null;
  permissiveGranted: boolean;          // true when overridden or no policies registered
  failedRestrictives: string[];        // names with outcome fail | null
  policies: PolicyClauseExplanation[]; // registration order: own type first, then interfaces
}
```

When no policies are registered for the type (the resolver returns null), every candidate is `visible: true` with `policies: []`. When an override fires, no predicate is projected: `visible: true`, the override is reported as `pass`, and every other entry is `skipped`.

### D9. Read-only execution

`Executor.execute` gains an optional, additive 4th parameter `{ accessMode?: 'READ' | 'WRITE' }`, honored only on the auto-commit path (`driver.session({ defaultAccessMode })`). `explainPolicies` passes `READ`. When the caller supplies `transaction` or `session`, grafeo runs on it as given, and the docs state that the caller owns the access mode there. No index or constraint work happens anywhere on this path.

*Alternative rejected:* adding `accessMode` to the public `ExecutionContext`. It is a broader API decision that deserves its own change.

### D10. Bypass gating and bounds

- Available only on policy-bound models (`ogm.withContext(ctx).model(...)`). It throws `OGMError` on a model with no policy binding, and on a global-bypass OGM, where explaining under bypass is meaningless. The method takes no `unsafe` option.
- `logger.warn('[OGM] explainPolicies on type "%s" returns rows regardless of policy outcome')` fires on every call.
- Audit metadata is attached as for `read`, with the additive key `explain: true`. It ignores `auditMetadata: false` in the same way global bypass already does, so explain calls always leave a trace.
- `onDeny: 'throw'` does not throw here; a denied context is reported per candidate.
- `options.limit` defaults to 100 and throws above 1,000. `offset` and `sort` are supported.
- `select` and `selectionSet` are mutually exclusive, as in `find`. Relationships in the selection are enforced by their target-type policies via the normal nested path.

## Risks / Trade-offs

- **[Explain leaks existence and data of rows the context cannot see]** → Dedicated method, a `warn` log on every call, audit tag, candidate cap, and docs that frame it as an admin-only diagnostic surface. The user explicitly chose full-select payloads over scalar-only, accepting the larger exposure surface.
- **[The refactor silently changes emitted Cypher]** → The byte-identical suite is extended with goldens captured *before* the refactor across every fragment shape (when-only, cypher-only, both, `{}`, `false`, abstain, zero permissives, interface inheritance, `@cypher` preludes).
- **[Positional misalignment between the projected list and the JS descriptors]** → Descriptors are built from the same `compilePolicyFragments` result that emits the list, and the D5 cross-check catches any drift at runtime.
- **[Filtering restrictives in the resolver would change what the compilers see]** → Avoided by design (D7): only `evaluated` is filtered. `permissives` and `restrictives` are unchanged, and the 17-case golden suite pins every compile path.
- **[Pre-existing: `InterfaceModel` treats an implementer whose permissives are all gated off by `appliesWhen` as unconstrained]** → Out of scope for this change. Reported separately as a security fix. The explain path is `Model`-only in v1, so it is not affected.
- **[Explain doubles fragment evaluation cost]** → Accepted for a bounded diagnostic call (limit ≤ 1,000), and documented.
- **[A caller-supplied WRITE session defeats the READ guarantee]** → Documented. grafeo's guarantee covers the sessions it opens itself.

## Migration Plan

Additive minor release (v2.2.0). No migration is required. The only observable change for existing users is shorter `policiesEvaluated` arrays when restrictives have `appliesWhen: false`. It is called out in the CHANGELOG. Rollback is a version pin.

## Open Questions

- **Duplicated interface policies in `InterfaceModel`**: `compileInterfacePolicyClause` composes the interface-level resolution with each implementer's resolution, and the implementer resolution already includes inherited interface policies. The duplicates are harmless for enforcement (idempotent AND / OR), but must be deduplicated before `InterfaceModel` explain support. Deferred to that follow-up.
- **The reporter's 62-clause corpus**: the issue author offered it as a test fixture. We need to confirm whether a sanitized copy can be committed or should only be used locally.
