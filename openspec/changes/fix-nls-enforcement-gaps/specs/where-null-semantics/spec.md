## ADDED Requirements

### Requirement: Null values are interpreted after the operator suffix
Every `where` compiler SHALL interpret a `null` value only after separating the operator suffix from the field name. This includes the root where, relationship and connection filters, policy `when` partials, and nested-write `where`.

#### Scenario: field_NOT null means IS NOT NULL
- **WHEN** a where contains `{ deletedAt_NOT: null }`
- **THEN** it compiles to `` n.`deletedAt` IS NOT NULL ``

#### Scenario: field null means IS NULL
- **WHEN** a where contains `{ deletedAt: null }`
- **THEN** it compiles to `` n.`deletedAt` IS NULL ``

#### Scenario: Relationship null and not-null
- **WHEN** a where contains `{ author: null }` and, separately, `{ author_NOT: null }`
- **THEN** they compile to `NOT EXISTS { MATCH … }` and `EXISTS { MATCH … }` respectively

#### Scenario: Restrictive policy using the not-null idiom
- **WHEN** a read restrictive's `when` returns `{ approvedAt_NOT: null }`
- **THEN** only nodes with a non-null `approvedAt` are visible

### Requirement: Uninterpretable null filters are rejected
A `null` value SHALL be rejected with `OGMError` when paired with any operator other than equality or `_NOT` (for example `_IN`, `_GT`, `_CONTAINS`, `_STARTS_WITH`, `_SOME`), or when the field is not a declared property, `@cypher` field, or relationship of the type. This SHALL hold regardless of `strictWhere`.

#### Scenario: Operator with null
- **WHEN** a where contains `{ name_CONTAINS: null }`
- **THEN** compilation rejects with `OGMError` naming the key

#### Scenario: Unknown field with null
- **WHEN** a where contains `{ deletedAtt: null }` and `strictWhere` is off
- **THEN** compilation rejects with `OGMError` naming the unknown field

#### Scenario: Unknown field with a non-null value keeps current behavior
- **WHEN** a where contains `{ deletedAtt: 'x' }` and `strictWhere` is off
- **THEN** it compiles as before (`` n.`deletedAtt` = $param `` — matches nothing)

### Requirement: Nested-write where uses the same compiler
Nested-write `where` (connect, disconnect, nested update, nested and cascade delete) SHALL be compiled by `WhereCompiler`, with the same operators, null semantics, and relationship-traversal policy enforcement as a direct `where`. `edge` and `edge_NOT` SHALL still be rejected in mutation `where`.

#### Scenario: Operator parity
- **WHEN** a connect `where` uses `{ node: { name_STARTS_WITH: 'A', tags_SOME: { id: 't1' } } }`
- **THEN** it compiles with the same operators as a direct where, and the `tags_SOME` traversal applies Tag's read policy

#### Scenario: Null parity
- **WHEN** a disconnect `where` uses `{ node: { archivedAt_NOT: null } }`
- **THEN** it compiles to `IS NOT NULL` on the target
