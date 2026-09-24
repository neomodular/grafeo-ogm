## ADDED Requirements

### Requirement: A policy-bound model always enforces target-type policies
A model obtained through `ogm.withContext(ctx)` on an OGM that is not policy-bypassed SHALL enforce each reached type's `read` policies in nested selection, in relationship traversal filters (`_SOME`, `_NONE`, `_ALL`, `_SINGLE`, `*Connection*`), and on connect/disconnect targets. This SHALL hold whether or not the root type has policies of its own.

#### Scenario: Unprotected root, protected relationship in selection
- **WHEN** type `Tag` has no policies, type `Chart` has a restrictive hiding `secret: true` charts, and `withContext(ctx).model('Tag').find({ select: { charts: { select: { id: true } } } })` runs
- **THEN** the nested `charts` projection applies Chart's read policy and returns no secret chart

#### Scenario: Unprotected root, traversal filter
- **WHEN** `withContext(ctx).model('Tag').find({ where: { charts_SOME: { id: 'c-secret' } } })` runs and `c-secret` is hidden from ctx
- **THEN** the traversal applies Chart's read policy, and the Tag is not matched through the hidden chart

#### Scenario: Unprotected root, connect target
- **WHEN** `withContext(ctx).model('Tag').update({ where, connect: { charts: [{ where: { node: { id: 'c-secret' } } }] } })` runs
- **THEN** no relationship to the hidden chart is created

#### Scenario: Connect inside create
- **WHEN** `withContext(ctx).model('Tag').create({ input: [{ charts: { connect: [{ where: { node: { id: 'c-secret' } } }] } }] })` runs
- **THEN** no relationship to the hidden chart is created, whether or not Tag has policies

#### Scenario: No policies anywhere stays byte-identical
- **WHEN** an OGM with no `policies` config, or a bound context whose read touches no type with policies, runs any read
- **THEN** the emitted Cypher is byte-identical to v2.2.0

### Requirement: Root without policies contributes no root clause
When the root type resolves no policy for the operation, the bound model SHALL emit no root policy clause and SHALL NOT throw `PolicyDeniedError`, exactly as before. Only target-type enforcement is added.

#### Scenario: Root reads unchanged
- **WHEN** `Tag` has no policies and `withContext(ctx).model('Tag').find({ where: { id: 't1' } })` runs with no relationship in the where or selection
- **THEN** the emitted Cypher equals the no-policy Cypher

### Requirement: explainPolicies enforces target-type policies in its selection
`Model.explainPolicies` SHALL apply the same target-type enforcement to its selection and candidate traversal as `find`, including when the root type has no policies.

#### Scenario: Explain on an unprotected root
- **WHEN** `withContext(ctx).model('Tag').explainPolicies({ select: { charts: { select: { id: true } } } })` runs
- **THEN** the nested charts are filtered by Chart's read policy, and each candidate reports `policies: []`, `visible: true`

### Requirement: Traversal quantifiers range over the related nodes the caller may see
A relationship traversal filter SHALL evaluate its quantifier over the related nodes that pass the target type's `read` policy only. Hidden related nodes SHALL neither satisfy nor falsify it: the target policy is composed outside every negation the quantifier introduces. Enforcement SHALL cascade through types without policies to any traversal depth.

#### Scenario: `_ALL` is not falsified by a hidden node
- **WHEN** Tag `t` relates to a visible chart titled `ok` and a hidden chart titled `bad`, and `find({ where: { id: 't', charts_ALL: { title: 'ok' } } })` runs
- **THEN** `t` is returned

#### Scenario: `_ALL` without a filter is vacuous
- **WHEN** `find({ where: { charts_ALL: {} } })` runs
- **THEN** no traversal is emitted, and the result does not depend on whether hidden related nodes exist

#### Scenario: Connection `node_NOT` is not satisfied by a hidden node
- **WHEN** `t`'s only visible chart is `c-pub`, and `find({ where: { id: 't', chartsConnection: { node_NOT: { id: 'c-pub' } } } })` runs
- **THEN** `t` is not returned

#### Scenario: Edge-only connection filter
- **WHEN** only the relationship to a hidden chart has `weight: 9`, and `find({ where: { chartsConnection: { edge: { weight: 9 } } } })` runs
- **THEN** no Tag is matched through it

#### Scenario: Policy-free middle type
- **WHEN** `Tag` has no policies and `find({ where: { charts_SOME: { tags_SOME: { charts_SOME: { id: 'c-secret' } } } } })` runs
- **THEN** the innermost chart is guarded by Chart's read policy

#### Scenario: Negated filter in a selection connection
- **WHEN** a nested `…Connection` selection filters with `node_NOT` containing a traversal
- **THEN** the traversal inside the negation applies its target's read policy, and the projected node's policy stays outside the negation
