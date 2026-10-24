import type {
  InterfaceDefinition,
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../../schema/types';
import {
  hasRelAggregateField,
  REL_AGGREGATE_OPS,
  relAggregateFields,
  relAggregateTargetProperties,
} from './aggregation-emitter';
import { toPascalCase } from './helpers';

/**
 * Emits `SelectFields` types for every node, interface, and edge-properties
 * type in the schema. These types describe which fields can be selected in
 * the type-safe `select` API.
 */
export function emitSelectFieldTypes(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  // v2.21.0 — the select fields of a point sub-selection, when a stored
  // `Point` / `CartesianPoint` field references them.
  const pointBlocks = emitPointSelectFields(schema);
  if (pointBlocks.length > 0) blocks.push(...pointBlocks);

  // Edge SelectFields — emitted first so node SelectFields can reference them
  const edgeSelectBlocks = emitEdgeSelectFields(schema);
  if (edgeSelectBlocks.length > 0) blocks.push(...edgeSelectBlocks);

  // Node SelectFields (sorted alphabetically)
  const sortedNodes = [...schema.nodes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, node] of sortedNodes)
    blocks.push(emitNodeSelectFields(node, schema));

  // Interface SelectFields (sorted alphabetically)
  const sortedInterfaces = [...schema.interfaces.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, iface] of sortedInterfaces)
    blocks.push(emitInterfaceSelectFields(iface, schema));

  // Union SelectFields (type alias of member SelectFields)
  const sortedUnions = [...(schema.unions?.entries() ?? [])].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [name, members] of sortedUnions) {
    const memberFields = members.map((m) => `${m}SelectFields`).join(' | ');
    blocks.push(`export type ${name}SelectFields = ${memberFields};`);
  }

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Node SelectFields
// ---------------------------------------------------------------------------

function emitNodeSelectFields(
  node: NodeDefinition,
  schema: SchemaMetadata,
): string {
  const members: string[] = [];

  // Scalar / enum fields
  for (const [, prop] of node.properties) {
    if (!isSelectableProperty(prop, schema)) continue;
    members.push(scalarSelectMember(prop));
  }

  // Relationship fields
  for (const [, rel] of node.relationships)
    members.push(emitRelationshipField(rel));

  // Connection fields
  for (const [, rel] of node.relationships)
    members.push(emitConnectionField(node.typeName, rel, schema));

  // v2.7.0 — relationship aggregate fields
  for (const [, rel] of node.relationships)
    if (hasRelAggregateField(node, rel))
      members.push(emitAggregateSelectField(rel, schema));

  return `export type ${node.typeName}SelectFields = {\n${members.join('\n')}\n};`;
}

// ---------------------------------------------------------------------------
// Interface SelectFields
// ---------------------------------------------------------------------------

function emitInterfaceSelectFields(
  iface: InterfaceDefinition,
  schema: SchemaMetadata,
): string {
  const members: string[] = [];

  // Scalar / enum fields
  for (const [, prop] of iface.properties) {
    if (!isSelectableProperty(prop, schema)) continue;
    members.push(scalarSelectMember(prop));
  }

  // Relationship fields
  for (const [, rel] of iface.relationships)
    members.push(emitRelationshipField(rel));

  // Connection fields — interfaces can also expose connections
  for (const [, rel] of iface.relationships)
    members.push(emitConnectionField(iface.name, rel, schema));

  // v2.7.0 — relationship aggregate fields
  for (const [, rel] of iface.relationships)
    if (hasRelAggregateField(iface, rel))
      members.push(emitAggregateSelectField(rel, schema));

  return `export type ${iface.name}SelectFields = {\n${members.join('\n')}\n};`;
}

// ---------------------------------------------------------------------------
// Edge SelectFields (for relationships with properties)
// ---------------------------------------------------------------------------

function emitEdgeSelectFields(schema: SchemaMetadata): string[] {
  const blocks: string[] = [];
  const emittedEdges = new Set<string>();

  // Gather all relationship definitions that carry edge properties.
  // v2.6.3 — interfaces too: `emitInterfaceSelectFields` references
  // `<Interface><Field>EdgeSelectFields` whenever a `@declareRelationship`
  // resolves (from its implementors) to a relationship with properties.
  // Since v2.4.8 that name was referenced but never emitted, so the
  // generated file failed to compile (TS2552, #22). The parser requires
  // every implementor to agree on the properties type, so the resolved
  // `rel.properties` is the single type to build it from.
  const owners: Array<[string, Map<string, RelationshipDefinition>]> = [
    ...[...schema.nodes.values()].map(
      (node): [string, Map<string, RelationshipDefinition>] => [
        node.typeName,
        node.relationships,
      ],
    ),
    ...[...schema.interfaces.values()].map(
      (iface): [string, Map<string, RelationshipDefinition>] => [
        iface.name,
        iface.relationships,
      ],
    ),
  ];

  for (const [ownerTypeName, relationships] of owners)
    for (const [, rel] of relationships) {
      if (!rel.properties) continue;

      const edgeTypeName = buildEdgeSelectFieldsName(ownerTypeName, rel);
      if (emittedEdges.has(edgeTypeName)) continue;
      emittedEdges.add(edgeTypeName);

      const propsType = schema.relationshipProperties.get(rel.properties);
      if (!propsType) continue;

      const members = buildScalarMembers(propsType.properties);
      blocks.push(`export type ${edgeTypeName} = {\n${members.join('\n')}\n};`);
    }

  // Sort for deterministic output
  blocks.sort();
  return blocks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a property gets a `field?: boolean` select entry. Stored
 * properties always do. `@cypher` fields do when they return a scalar or
 * enum: the runtime `select` projects them (via a CALL prelude) and the
 * node type already declares them as `Maybe<T>`, but through v2.4.7 the
 * select types skipped every `@cypher` field, so selecting one failed to
 * compile. `@cypher` fields returning node/interface/union types stay
 * out — a boolean cannot describe their nested selection.
 */
function isSelectableProperty(
  prop: PropertyDefinition,
  schema: SchemaMetadata,
): boolean {
  if (!prop.isCypher) return true;
  return (
    !schema.nodes.has(prop.type) &&
    !schema.interfaces.has(prop.type) &&
    !(schema.unions?.has(prop.type) ?? false)
  );
}

/** Emits a single relationship field entry (non-connection). */
function emitRelationshipField(rel: RelationshipDefinition): string {
  if (rel.isArray)
    return `  ${rel.fieldName}?: boolean | { where?: ${rel.target}Where; select?: ${rel.target}SelectFields; orderBy?: Array<Record<string, 'ASC' | 'DESC'>> };`;

  return `  ${rel.fieldName}?: boolean | { where?: ${rel.target}Where; select?: ${rel.target}SelectFields };`;
}

/**
 * Emits a single connection field entry.
 *
 * Pattern:
 * ```
 * drugsConnection?: boolean | {
 *   where?: ChartDrugsConnectionWhere;
 *   select: {
 *     edges?: boolean | {
 *       node?: boolean | { select: DrugSelectFields };
 *       properties?: boolean | { select: ChartDrugsEdgeSelectFields };
 *     };
 *   };
 * };
 * ```
 */
function emitConnectionField(
  ownerTypeName: string,
  rel: RelationshipDefinition,
  schema: SchemaMetadata,
): string {
  const connFieldName = `${rel.fieldName}Connection`;
  const connWhereName = `${ownerTypeName}${toPascalCase(rel.fieldName)}ConnectionWhere`;
  const targetSelect = `${rel.target}SelectFields`;

  // Build edge inner type
  const edgeMembers: string[] = [
    `        node?: boolean | { select: ${targetSelect} };`,
    // v2.8.0 — the runtime projects `cursor` (upstream offset cursors).
    `        cursor?: boolean;`,
  ];

  // Compute the orderBy union shape. Node sort is always available; edge sort
  // is only offered when the relationship carries @relationshipProperties.
  const hasEdgeProps =
    !!rel.properties && schema.relationshipProperties.has(rel.properties);
  const orderByArm = hasEdgeProps
    ? `Array<{ node: Record<string, 'ASC' | 'DESC'> } | { edge: Record<string, 'ASC' | 'DESC'> }>`
    : `Array<{ node: Record<string, 'ASC' | 'DESC'> }>`;

  // Only include properties if the relationship carries edge properties
  if (hasEdgeProps) {
    const edgeSelectName = buildEdgeSelectFieldsName(ownerTypeName, rel);
    edgeMembers.push(
      `        properties?: boolean | { select: ${edgeSelectName} };`,
    );
  }

  const lines = [
    `  ${connFieldName}?: boolean | {`,
    `    where?: ${connWhereName};`,
    `    orderBy?: ${orderByArm};`,
    `    select: {`,
    // v2.4.8 — the runtime projects `totalCount` (filtered by the same
    // where + target read policy as `edges`); the select type now offers it.
    `      totalCount?: boolean;`,
    // v2.8.0 — the runtime projects `pageInfo` (same filtered list).
    `      pageInfo?: boolean | { select: { hasNextPage?: boolean; hasPreviousPage?: boolean; startCursor?: boolean; endCursor?: boolean } };`,
    `      edges?: boolean | {`,
    ...edgeMembers,
    `      };`,
    `    };`,
    `  };`,
  ];

  return lines.join('\n');
}

/**
 * v2.7.0 — a `<rel>Aggregate` select entry, mirroring the runtime
 * (`SelectNormalizer.normalizeAggregate`): `true` selects `count` and every
 * aggregate of every aggregatable node / edge field; the object form takes
 * `where` (the target's where input), `directed` and a `select` of `count`,
 * `node` and (with edge properties) `edge`, each field `true` (all its
 * aggregates) or `{ select: { <aggregate>: true } }`.
 *
 * ```
 * postsAggregate?: boolean | {
 *   where?: PostWhere;
 *   directed?: boolean;
 *   select?: {
 *     count?: boolean;
 *     node?: boolean | { select: { views?: boolean | { select: { min?: boolean; … } } } };
 *   };
 * };
 * ```
 */
function emitAggregateSelectField(
  rel: RelationshipDefinition,
  schema: SchemaMetadata,
): string {
  const fieldsSelect = (props: Map<string, PropertyDefinition>): string => {
    const members = relAggregateFields(props).map(([name, aggType]) => {
      const ops = REL_AGGREGATE_OPS[aggType]
        .map((op) => `${op}?: boolean`)
        .join('; ');
      return `${name}?: boolean | { select: { ${ops} } }`;
    });
    return `boolean | { select: { ${members.join('; ')} } }`;
  };
  const isUnion = !!schema.unions?.get(rel.target)?.length;
  const edgeProps = rel.properties
    ? schema.relationshipProperties.get(rel.properties)?.properties
    : undefined;
  const selectMembers = [`        count?: boolean;`];
  if (!isUnion)
    selectMembers.push(
      `        node?: ${fieldsSelect(relAggregateTargetProperties(rel.target, schema))};`,
    );
  if (edgeProps)
    selectMembers.push(`        edge?: ${fieldsSelect(edgeProps)};`);
  return [
    `  ${rel.fieldName}Aggregate?: boolean | {`,
    `    where?: ${rel.target}Where;`,
    `    directed?: boolean;`,
    `    select?: {`,
    ...selectMembers,
    `    };`,
    `  };`,
  ].join('\n');
}

/**
 * Builds the name for an edge SelectFields type.
 *
 * Convention: `<OwnerType><PascalFieldName>EdgeSelectFields`
 * Example: `ChartDrugsEdgeSelectFields`
 */
function buildEdgeSelectFieldsName(
  ownerTypeName: string,
  rel: RelationshipDefinition,
): string {
  return `${ownerTypeName}${toPascalCase(rel.fieldName)}EdgeSelectFields`;
}

/**
 * Builds `fieldName?: boolean;` members for a set of scalar properties,
 * skipping @cypher fields.
 */
function buildScalarMembers(
  properties: Map<string, PropertyDefinition>,
): string[] {
  const members: string[] = [];

  for (const [, prop] of properties) {
    if (prop.isCypher) continue;
    members.push(scalarSelectMember(prop));
  }

  return members;
}

/** v2.21.0 — stored `Point` / `CartesianPoint` fields → their sub-selection fields. */
const POINT_SELECT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Point: ['longitude', 'latitude', 'height', 'crs', 'srid', '__typename'],
  CartesianPoint: ['x', 'y', 'z', 'crs', 'srid', '__typename'],
};

function isStoredPoint(prop: PropertyDefinition): boolean {
  return (
    !prop.isCypher &&
    Object.prototype.hasOwnProperty.call(POINT_SELECT_FIELDS, prop.type)
  );
}

/**
 * `field?: boolean;`, or (2.21.0) for a stored point field
 * `loc?: boolean | { select: PointSelectFields };`, the typed form of the
 * `loc { longitude latitude }` sub-selection.
 */
function scalarSelectMember(prop: PropertyDefinition): string {
  if (isStoredPoint(prop))
    return `  ${prop.name}?: boolean | { select: ${prop.type}SelectFields };`;
  return `  ${prop.name}?: boolean;`;
}

/**
 * v2.21.0 — `PointSelectFields` / `CartesianPointSelectFields`, emitted only
 * when a stored field of that type exists (node, interface or relationship
 * properties), so schemas without points generate the same file as before.
 */
function emitPointSelectFields(schema: SchemaMetadata): string[] {
  const used = new Set<string>();
  const holders = [
    ...schema.nodes.values(),
    ...schema.interfaces.values(),
    ...schema.relationshipProperties.values(),
  ];
  for (const holder of holders)
    for (const [, prop] of holder.properties)
      if (isStoredPoint(prop)) used.add(prop.type);
  return Object.keys(POINT_SELECT_FIELDS)
    .filter((type) => used.has(type))
    .map(
      (type) =>
        `export type ${type}SelectFields = {\n${POINT_SELECT_FIELDS[type]
          .map((f) => `  ${f}?: boolean;`)
          .join('\n')}\n};`,
    );
}
