import type {
  SchemaMetadata,
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
} from '../../schema/types';
import { toPascalCase } from './helpers';

// ---------------------------------------------------------------------------
// Scalar → aggregate selection type mapping
// ---------------------------------------------------------------------------

const SCALAR_AGGREGATE_MAP: Record<string, string> = {
  ID: 'IdAggregateSelection',
  String: 'StringAggregateSelection',
  Int: 'IntAggregateSelection',
  Float: 'FloatAggregateSelection',
  DateTime: 'DateTimeAggregateSelection',
};

// ---------------------------------------------------------------------------
// Shared aggregate selection types (schema-independent)
// ---------------------------------------------------------------------------

// ID / String mirror Model.aggregate(), which returns lexicographic
// `min` / `max` for every non-numeric field. Through v2.4.7 these
// declared upstream's `shortest` / `longest`, which the runtime never
// returns.
const SHARED_AGGREGATE_TYPES = `export type IdAggregateSelection = {
  __typename?: "IDAggregateSelection";
  min?: Maybe<Scalars["ID"]["output"]>;
  max?: Maybe<Scalars["ID"]["output"]>;
};

export type StringAggregateSelection = {
  __typename?: "StringAggregateSelection";
  min?: Maybe<Scalars["String"]["output"]>;
  max?: Maybe<Scalars["String"]["output"]>;
};

export type IntAggregateSelection = {
  __typename?: "IntAggregateSelection";
  max?: Maybe<Scalars["Int"]["output"]>;
  min?: Maybe<Scalars["Int"]["output"]>;
  average?: Maybe<Scalars["Float"]["output"]>;
  sum?: Maybe<Scalars["Int"]["output"]>;
};

export type FloatAggregateSelection = {
  __typename?: "FloatAggregateSelection";
  max?: Maybe<Scalars["Float"]["output"]>;
  min?: Maybe<Scalars["Float"]["output"]>;
  average?: Maybe<Scalars["Float"]["output"]>;
  sum?: Maybe<Scalars["Float"]["output"]>;
};

export type DateTimeAggregateSelection = {
  __typename?: "DateTimeAggregateSelection";
  min?: Maybe<Scalars["DateTime"]["output"]>;
  max?: Maybe<Scalars["DateTime"]["output"]>;
};`;

/**
 * v2.7.0 — field aggregate selections of a `<rel>Aggregate` selection, by
 * scalar type: upstream `@neo4j/graphql` 5.x's aggregation type matrix.
 * Int / Float / DateTime reuse the shapes above (they are upstream's).
 * ID / String add upstream's `shortest` / `longest` to the lexicographic
 * `min` / `max` those types declared (and the runtime still returns).
 * BigInt aggregates are strings, as upstream's BigInt scalar serialized
 * them. Temporal values use the node types' ISO string output.
 */
const REL_AGGREGATE_MAP: Record<string, string> = {
  ID: 'IdRelationshipAggregateSelection',
  String: 'StringRelationshipAggregateSelection',
  Int: 'IntAggregateSelection',
  Float: 'FloatAggregateSelection',
  BigInt: 'BigIntAggregateSelection',
  DateTime: 'DateTimeAggregateSelection',
  LocalDateTime: 'LocalDateTimeAggregateSelection',
  LocalTime: 'LocalTimeAggregateSelection',
  Time: 'TimeAggregateSelection',
  Duration: 'DurationAggregateSelection',
};

const REL_SHARED_AGGREGATE_TYPES = `export type IdRelationshipAggregateSelection = {
  __typename?: "IDAggregateSelection";
  shortest?: Maybe<Scalars["ID"]["output"]>;
  longest?: Maybe<Scalars["ID"]["output"]>;
  min?: Maybe<Scalars["ID"]["output"]>;
  max?: Maybe<Scalars["ID"]["output"]>;
};

export type StringRelationshipAggregateSelection = {
  __typename?: "StringAggregateSelection";
  shortest?: Maybe<Scalars["String"]["output"]>;
  longest?: Maybe<Scalars["String"]["output"]>;
  min?: Maybe<Scalars["String"]["output"]>;
  max?: Maybe<Scalars["String"]["output"]>;
};

export type BigIntAggregateSelection = {
  __typename?: "BigIntAggregateSelection";
  max?: Maybe<string>;
  min?: Maybe<string>;
  average?: Maybe<string>;
  sum?: Maybe<string>;
};

export type LocalDateTimeAggregateSelection = {
  __typename?: "LocalDateTimeAggregateSelection";
  min?: Maybe<Scalars["LocalDateTime"]["output"]>;
  max?: Maybe<Scalars["LocalDateTime"]["output"]>;
};

export type LocalTimeAggregateSelection = {
  __typename?: "LocalTimeAggregateSelection";
  min?: Maybe<Scalars["LocalTime"]["output"]>;
  max?: Maybe<Scalars["LocalTime"]["output"]>;
};

export type TimeAggregateSelection = {
  __typename?: "TimeAggregateSelection";
  min?: Maybe<Scalars["Time"]["output"]>;
  max?: Maybe<Scalars["Time"]["output"]>;
};

export type DurationAggregateSelection = {
  __typename?: "DurationAggregateSelection";
  min?: Maybe<Scalars["Duration"]["output"]>;
  max?: Maybe<Scalars["Duration"]["output"]>;
};`;

/**
 * The relationship aggregate WHERE inputs (`<rel>Aggregate` filter keys)
 * stay declared for existing imports but unsupported: the where compiler
 * rejects aggregate filters. (The `<rel>Aggregate` SELECTION is supported
 * since v2.7.0.)
 */
const UNSUPPORTED_REL_AGGREGATE_DOC =
  '/** @deprecated Relationship aggregate filters are not supported at runtime; this type is unused. */';

/**
 * The aggregate selection type of a field in a `<rel>Aggregate` selection,
 * or `undefined` when it has none (lists, `@cypher`, Boolean, Date, enums,
 * points, custom scalars) — mirrors the runtime's `aggregateKind`.
 */
function relAggregateType(prop: PropertyDefinition): string | undefined {
  if (prop.isArray || prop.isCypher) return undefined;
  return REL_AGGREGATE_MAP[prop.type];
}

/**
 * The scalar properties a `<rel>Aggregate { node { … } }` aggregates: the
 * target node's or interface's own; none for a union target.
 */
export function relAggregateTargetProperties(
  target: string,
  schema: SchemaMetadata,
): Map<string, PropertyDefinition> {
  return (
    schema.nodes.get(target)?.properties ??
    schema.interfaces.get(target)?.properties ??
    new Map()
  );
}

/** The aggregatable `[name, selectionType]` pairs of a property map. */
export function relAggregateFields(
  props: Map<string, PropertyDefinition>,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, prop] of props) {
    const type = relAggregateType(prop);
    if (type) out.push([name, type]);
  }
  return out;
}

/**
 * The members of a `…NodeAggregateSelection` / `…EdgeAggregateSelection`
 * type, in property order: one per aggregatable field and — with
 * `legacyLists` — the list fields v2.6.3 declared (ID / String / Int /
 * Float / DateTime lists, with their v2.6.3 type), kept so existing code
 * compiles but `@deprecated`: lists are not aggregated (never were at
 * runtime; selecting one throws) and the members go in 3.0.
 */
function relAggregateMembers(
  props: Map<string, PropertyDefinition>,
  legacyLists: boolean,
  schema: SchemaMetadata,
): string[] {
  const lines: string[] = [];
  for (const [name, prop] of props) {
    const type = relAggregateType(prop);
    if (type) {
      lines.push(`  ${name}: ${type};`);
      continue;
    }
    const legacy = SCALAR_AGGREGATE_MAP[prop.type];
    if (
      legacyLists &&
      legacy &&
      prop.isArray &&
      !prop.isCypher &&
      !schema.enums.has(prop.type)
    )
      lines.push(
        `  /** @deprecated List fields are not aggregated (never supported at runtime: selecting it throws). Removed in 3.0. */`,
        `  ${name}: ${legacy};`,
      );
  }
  return lines;
}

/** Field ops of a field aggregate selection type (for select types). */
export const REL_AGGREGATE_OPS: Record<string, readonly string[]> = {
  IdRelationshipAggregateSelection: ['shortest', 'longest', 'min', 'max'],
  StringRelationshipAggregateSelection: ['shortest', 'longest', 'min', 'max'],
  IntAggregateSelection: ['min', 'max', 'average', 'sum'],
  FloatAggregateSelection: ['min', 'max', 'average', 'sum'],
  BigIntAggregateSelection: ['min', 'max', 'average', 'sum'],
  DateTimeAggregateSelection: ['min', 'max'],
  LocalDateTimeAggregateSelection: ['min', 'max'],
  LocalTimeAggregateSelection: ['min', 'max'],
  TimeAggregateSelection: ['min', 'max'],
  DurationAggregateSelection: ['min', 'max'],
};

/**
 * Whether `owner` gets a `<rel>Aggregate` field for `rel`: not when a
 * property or relationship already carries that name (the runtime then
 * keeps the field's own meaning).
 */
export function hasRelAggregateField(
  owner: {
    properties: Map<string, PropertyDefinition>;
    relationships: Map<string, RelationshipDefinition>;
  },
  rel: RelationshipDefinition,
): boolean {
  const name = `${rel.fieldName}Aggregate`;
  return !owner.properties.has(name) && !owner.relationships.has(name);
}

/** `<Owner><Target><Field>AggregationSelection` — upstream's naming. */
export function relAggregationSelectionName(
  ownerTypeName: string,
  rel: RelationshipDefinition,
): string {
  return `${ownerTypeName}${rel.target}${toPascalCase(rel.fieldName)}AggregationSelection`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emits the shared aggregate selection types (`IdAggregateSelection`, etc.)
 * followed by one `<Node>AggregateSelection` type per node in the schema.
 */
export function emitAggregationTypes(schema: SchemaMetadata): string {
  const blocks: string[] = [SHARED_AGGREGATE_TYPES, REL_SHARED_AGGREGATE_TYPES];

  const sortedNodes = [...schema.nodes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, node] of sortedNodes) {
    blocks.push(emitNodeAggregateSelection(node, schema));

    // Relationship aggregation selection + aggregate input types
    for (const [, rel] of node.relationships) {
      blocks.push(
        emitRelationshipAggregationSelection(node.typeName, rel, schema),
      );
      blocks.push(emitRelationshipAggregateInput(node, rel));
    }
  }

  // Interface relationship aggregate input types, and (v2.7.0) the
  // aggregation selection of the interface's `<rel>Aggregate` field.
  const sortedInterfaces = [...schema.interfaces.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [, iface] of sortedInterfaces)
    for (const [, rel] of iface.relationships) {
      blocks.push(emitInterfaceRelAggregateInput(iface.name, rel));
      blocks.push(
        emitRelationshipAggregationSelection(iface.name, rel, schema),
      );
    }

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Emits a `<Parent><Target><Field>AggregationSelection` type for a relationship.
 *
 * Example: `ChartChartHasParentChartAggregationSelection = { count: ...; node?: ...; }`
 */
function emitRelationshipAggregationSelection(
  ownerTypeName: string,
  rel: RelationshipDefinition,
  schema: SchemaMetadata,
): string {
  // v2.7.0 — the type of the `<rel>Aggregate` selection the runtime now
  // populates (no longer @deprecated). Names are unchanged.
  const typeName = relAggregationSelectionName(ownerTypeName, rel);
  const nodeAggType = `${typeName.replace('AggregationSelection', '')}NodeAggregateSelection`;

  const lines: string[] = [
    `  __typename?: "${typeName}";`,
    `  count: Scalars["Int"]["output"];`,
    `  node?: Maybe<${nodeAggType}>;`,
  ];

  // If relationship has properties, add edge aggregate
  if (rel.properties) {
    const edgeAggType = `${typeName.replace('AggregationSelection', '')}EdgeAggregateSelection`;
    lines.push(`  edge?: Maybe<${edgeAggType}>;`);
  }

  const block = `export type ${typeName} = {\n${lines.join('\n')}\n};`;

  // The NodeAggregateSelection type: the target's aggregatable fields
  // (a node's or, v2.7.0, an interface's; none for a union).
  const nodeLines: string[] = [
    `  __typename?: "${nodeAggType}";`,
    // Through v2.6.3 a node target's list fields were declared too; they
    // stay, deprecated (a concrete node target only, as then).
    ...relAggregateMembers(
      relAggregateTargetProperties(rel.target, schema),
      schema.nodes.has(rel.target),
      schema,
    ),
  ];

  const nodeBlock = `export type ${nodeAggType} = {\n${nodeLines.join('\n')}\n};`;

  // Emit edge aggregate selection if relationship has properties
  if (rel.properties) {
    const edgeAggType = `${typeName.replace('AggregationSelection', '')}EdgeAggregateSelection`;
    const edgeLines: string[] = [`  __typename?: "${edgeAggType}";`];
    const relProps = schema.relationshipProperties.get(rel.properties);
    if (relProps)
      edgeLines.push(...relAggregateMembers(relProps.properties, true, schema));
    const edgeBlock = `export type ${edgeAggType} = {\n${edgeLines.join('\n')}\n};`;
    return `${block}\n\n${nodeBlock}\n\n${edgeBlock}`;
  }

  return `${block}\n\n${nodeBlock}`;
}

/**
 * Emits a `<Parent><Field>AggregateInput` type for Where aggregate filters.
 *
 * Example: `ChartHasParentChartAggregateInput = { count?: ...; count_LT?: ...; ... }`
 */
function emitRelationshipAggregateInput(
  parent: NodeDefinition,
  rel: RelationshipDefinition,
): string {
  const pascalField = toPascalCase(rel.fieldName);
  const typeName = `${parent.typeName}${pascalField}AggregateInput`;

  const lines: string[] = [
    `  count?: InputMaybe<Scalars["Int"]["input"]>;`,
    `  count_LT?: InputMaybe<Scalars["Int"]["input"]>;`,
    `  count_LTE?: InputMaybe<Scalars["Int"]["input"]>;`,
    `  count_GT?: InputMaybe<Scalars["Int"]["input"]>;`,
    `  count_GTE?: InputMaybe<Scalars["Int"]["input"]>;`,
    `  AND?: InputMaybe<Array<${typeName}>>;`,
    `  OR?: InputMaybe<Array<${typeName}>>;`,
    `  NOT?: InputMaybe<${typeName}>;`,
  ];

  return `${UNSUPPORTED_REL_AGGREGATE_DOC}\nexport type ${typeName} = {\n${lines.join('\n')}\n};`;
}

/**
 * Emits an aggregate input type for an interface relationship.
 * Same structure as node relationship aggregate inputs.
 */
function emitInterfaceRelAggregateInput(
  ifaceName: string,
  rel: RelationshipDefinition,
): string {
  const pascalField = toPascalCase(rel.fieldName);
  const typeName = `${ifaceName}${pascalField}AggregateInput`;

  const lines: string[] = [
    `  count?: InputMaybe<Scalars["Int"]["input"]>;`,
    `  count_LT?: InputMaybe<Scalars["Int"]["input"]>;`,
    `  count_LTE?: InputMaybe<Scalars["Int"]["input"]>;`,
    `  count_GT?: InputMaybe<Scalars["Int"]["input"]>;`,
    `  count_GTE?: InputMaybe<Scalars["Int"]["input"]>;`,
    `  AND?: InputMaybe<Array<${typeName}>>;`,
    `  OR?: InputMaybe<Array<${typeName}>>;`,
    `  NOT?: InputMaybe<${typeName}>;`,
  ];

  return `${UNSUPPORTED_REL_AGGREGATE_DOC}\nexport type ${typeName} = {\n${lines.join('\n')}\n};`;
}

/**
 * Emits a single `<Node>AggregateSelection` type with `count` followed by
 * one entry per aggregatable scalar property.
 */
function emitNodeAggregateSelection(
  node: NodeDefinition,
  schema: SchemaMetadata,
): string {
  const lines: string[] = [
    `  __typename?: "${node.typeName}AggregateSelection";`,
    `  count: Scalars["Int"]["output"];`,
  ];

  for (const [name, prop] of node.properties) {
    // Skip @cypher fields — computed, not stored
    if (prop.isCypher) continue;

    const aggregateType = SCALAR_AGGREGATE_MAP[prop.type];

    // Skip Booleans and enums — they have no aggregate selection
    if (!aggregateType) continue;

    // Skip enum types explicitly
    if (schema.enums.has(prop.type)) continue;

    lines.push(`  ${name}: ${aggregateType};`);
  }

  return `export type ${node.typeName}AggregateSelection = {\n${lines.join('\n')}\n};`;
}
