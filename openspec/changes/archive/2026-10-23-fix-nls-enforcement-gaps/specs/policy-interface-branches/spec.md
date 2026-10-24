## ADDED Requirements

### Requirement: Interface branches equal each implementer's own policy clause
For every implementer M of an interface, the `InterfaceModel` policy branch for `n:M` SHALL be equivalent to the policy clause `Model(M).find` compiles for the same bound context and operation. It SHALL be `true` only when M (including M's interfaces) has no policy for the operation, or when an override fires for M.

#### Scenario: Implementer whose permissives are all gated off
- **WHEN** implementer `Drug`'s only read permissive has `appliesWhen: () => false`
- **THEN** the interface query's `Drug` branch denies (`false`), matching `Model('Drug').find` (`WHERE false`)

#### Scenario: Branch text equals the model clause
- **WHEN** an interface and its implementers have read policies
- **THEN** each `WHEN n:M THEN <clause>` has `<clause>` identical to the policy clause of `Model(M).find` with no user where

#### Scenario: No duplicated interface predicates
- **WHEN** the interface has a restrictive `tenantId = ctx.tid`
- **THEN** each branch contains that predicate exactly once

#### Scenario: Implementer override
- **WHEN** an override registered on implementer `Chart` fires
- **THEN** the `Chart` branch is `true`, matching `Model('Chart').find`
