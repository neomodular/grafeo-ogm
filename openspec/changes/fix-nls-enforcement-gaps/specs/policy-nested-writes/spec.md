## ADDED Requirements

### Requirement: Nested writes enforce the target type's policies as a direct write would
A nested write SHALL enforce, against the target type, exactly what the equivalent direct write on that type would enforce for the same bound context: the same operation's row filter, the same default-deny, and the same write restrictives. A target type with no policies for that operation SHALL be unconstrained, as it is for direct writes.

#### Scenario: Nested update is row-filtered by the target's update policy
- **WHEN** Chart's `update` permissive only allows `ownerId = ctx.uid`, and `Tag.update({ where, update: { charts: [{ where: { node: {} }, update: { node: { title: 'x' } } }] } })` runs
- **THEN** only related charts owned by `ctx.uid` are updated

#### Scenario: Nested update applies the target's write restrictive
- **WHEN** Chart has a write restrictive on `update` that rejects `input.tenantId !== ctx.tid`, and a nested update sets `tenantId: 'other'`
- **THEN** the call rejects with `PolicyDeniedError` naming the restrictive, and nothing is written

#### Scenario: Nested create applies the target's create permissive and write restrictive
- **WHEN** Chart has no applicable `create` permissive, and `Tag.create({ input: [{ charts: { create: [{ node: { id: 'c9' } }] } }] })` runs
- **THEN** the call rejects with `PolicyDeniedError` for type Chart and operation `create`, and nothing is created

#### Scenario: Nested create inside update
- **WHEN** a nested create inside `update` violates Chart's create write restrictive
- **THEN** the call rejects with `PolicyDeniedError` before any Cypher runs

#### Scenario: Nested delete inside update uses the target's delete policy
- **WHEN** `Tag.update({ where, update: { charts: [{ delete: [{ where: { node: {} } }] }] } })` runs and Chart's `delete` policy hides some related charts
- **THEN** only the charts permitted by Chart's `delete` policy are deleted

#### Scenario: onDeny 'throw' on a nested operation
- **WHEN** `policyDefaults.onDeny` is `'throw'`, Chart has `update` policies but none applies to ctx, and a nested update targets Chart
- **THEN** the call rejects with `PolicyDeniedError` at compile time, as a direct Chart update would

### Requirement: Cascade delete honors the per-relationship where
`Model.delete`'s nested `delete` SHALL delete, for each relationship item, only related nodes that match that item's `where` AND are permitted by the target type's `delete` policy. `{}` or an item without a `where` SHALL delete every related node the `delete` policy permits.

#### Scenario: README example deletes only the named category
- **WHEN** a book is linked to categories "Temp Category" and "Fiction", and `Book.delete({ where: { id }, delete: { categories: [{ where: { node: { name: 'Temp Category' } } }] } })` runs
- **THEN** "Temp Category" and the book are deleted, and "Fiction" still exists

#### Scenario: Target delete policy gates cascaded nodes
- **WHEN** Category's `delete` policy denies ctx for some related categories and a cascade with `{}` runs
- **THEN** only permitted categories are deleted; the others remain and only lose their relationship to the deleted book

#### Scenario: Single-relationship spec
- **WHEN** the relationship is singular and the spec is an object instead of an array
- **THEN** it is treated as a one-element list

### Requirement: Unsupported cascade input is rejected
The system SHALL reject, with `OGMError`, a nested `delete` inside a delete spec (multi-level cascade), unknown keys in a delete spec, and `edge` / `edge_NOT` filters in any mutation `where`, instead of silently ignoring them.

#### Scenario: Multi-level cascade
- **WHEN** `Book.delete({ where, delete: { reviews: [{ delete: { book: {} } }] } })` runs
- **THEN** it rejects with `OGMError` stating that multi-level cascade delete is not supported, and nothing is deleted

#### Scenario: Unknown key
- **WHEN** a delete spec contains `{ wher: {…} }`
- **THEN** it rejects with `OGMError` naming the unknown key
