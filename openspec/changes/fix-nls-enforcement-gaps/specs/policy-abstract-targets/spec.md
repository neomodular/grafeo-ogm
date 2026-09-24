## ADDED Requirements

### Requirement: Abstract relationship targets enforce each concrete member's own policy
When a relationship's target is an interface or a union, every nested read path (selection, traversal filters) and every nested write (connect, disconnect, update, delete) SHALL guard each target node with the policy of its concrete member type for that operation. A member without a policy for the operation, or whose override fires, SHALL be unconstrained. A node carrying no known member label SHALL be excluded.

#### Scenario: Interface target in nested selection
- **WHEN** `Tag.res` targets interface `Res` (implemented by `Chart` and `Doc`), `Chart` has a read restrictive hiding `secret: true`, and `withContext(ctx).model('Tag').find({ select: { res: { select: { id: true } } } })` runs
- **THEN** secret charts are absent from `res`, and docs are unaffected

#### Scenario: Union target in nested selection
- **WHEN** `Tag.items` targets union `Item = Chart | Doc` and the same Chart restrictive applies
- **THEN** secret charts are absent from `items`

#### Scenario: Interface target traversal filter
- **WHEN** `Tag.find({ where: { res_SOME: { id: 'secret-chart' } } })` runs
- **THEN** the Tag is not matched through the hidden chart

#### Scenario: Interface target connect
- **WHEN** `Tag.update({ connect: { res: [{ where: { node: { id: 'secret-chart' } } }] } })` runs
- **THEN** no relationship to the hidden chart is created

#### Scenario: No member has policies stays byte-identical
- **WHEN** no member of the abstract target has a policy for the operation
- **THEN** the emitted Cypher carries no target policy clause

### Requirement: One construction for abstract policy clauses
The policy clause for an abstract type SHALL be `CASE WHEN <var>:<Member> THEN <member clause> … ELSE false END`, where each member clause is identical to the clause that member's own `Model` compiles for the same context and operation. The `InterfaceModel` root clause SHALL use the same construction.

#### Scenario: Branch equals the member's model clause
- **WHEN** the abstract clause is compiled for interface `Res` and operation `read`
- **THEN** the `Chart` branch text equals `Model('Chart').find`'s policy clause for the same context
