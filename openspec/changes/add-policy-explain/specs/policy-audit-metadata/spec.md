## ADDED Requirements

### Requirement: policiesEvaluated lists only applied policies
The `policiesEvaluated` audit-metadata field attached to policy-bound queries SHALL contain the names of exactly the policies that applied to the query:
- the firing override; or
- the permissives and restrictives whose operation matched and whose `appliesWhen(ctx)` was absent or true.

Restrictives whose `appliesWhen(ctx)` returned false SHALL NOT be listed. Compiled Cypher SHALL be unaffected by this requirement.

#### Scenario: Non-applying restrictive omitted
- **WHEN** a read runs with permissive `p1` (applies) and restrictive `r1` whose `appliesWhen(ctx)` returns false
- **THEN** `policiesEvaluated` equals `['p1']`

#### Scenario: Applying restrictive listed
- **WHEN** a read runs with permissive `p1` and restrictive `r1` whose `appliesWhen(ctx)` returns true
- **THEN** `policiesEvaluated` equals `['p1', 'r1']`

#### Scenario: Emitted Cypher unchanged
- **WHEN** a read runs with a restrictive whose `appliesWhen(ctx)` returns false
- **THEN** the emitted Cypher and params are byte-identical to the output before this change
