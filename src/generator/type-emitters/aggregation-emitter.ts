import type {
  SchemaMetadata,
  NodeDefinition,
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

const SHARED_AGGREGATE_TYPES = `export type IdAggregateSelection = {
  __typename?: "IDAggregateSelection";
  shortest?: Maybe<Scalars["ID"]["output"]>;
  longest?: Maybe<Scalars["ID"]["output"]>;
};

export type StringAggregateSelection = {
  __typename?: "StringAggregateSelection";
  shortest?: Maybe<Scalars["String"]["output"]>;
  longest?: Maybe<Scalars["String"]["output"]>;
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emits the shared aggregate selection types (`IdAggregateSelection`, etc.)
 * followed by one `<Node>AggregateSelection` type per node in the schema.
 */
export function emitAggregationTypes(schema: SchemaMetadata): string {
  const blocks: string[] = [SHARED_AGGREGATE_TYPES];

  const sortedNodes = [...schema.nodes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, node] of sortedNodes) {
    blocks.push(emitNodeAggregateSelection(node, schema));

    // Relationship aggregation selection + aggregate input types
    for (const [, rel] of node.relationships) {
      blocks.push(emitRelationshipAggregationSelection(node, rel, schema));
      blocks.push(emitRelationshipAggregateInput(node, rel));
    }
  }

  // Interface relationship aggregate input types
  const sortedInterfaces = [...schema.interfaces.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [, iface] of sortedInterfaces)
    for (const [, rel] of iface.relationships)
      blocks.push(emitInterfaceRelAggregateInput(iface.name, rel));

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
  parent: NodeDefinition,
  rel: RelationshipDefinition,
  schema: SchemaMetadata,
): string {
  const pascalField = toPascalCase(rel.fieldName);
  const typeName = `${parent.typeName}${rel.target}${pascalField}AggregationSelection`;
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

  // Also emit the NodeAggregateSelection type (scalar properties of the target)
  const targetNode = schema.nodes.get(rel.target);
  const nodeLines: string[] = [`  __typename?: "${nodeAggType}";`];

  if (targetNode)
    for (const [name, prop] of targetNode.properties) {
      if (prop.isCypher) continue;
      const aggType = SCALAR_AGGREGATE_MAP[prop.type];
      if (!aggType) continue;
      if (schema.enums.has(prop.type)) continue;
      nodeLines.push(`  ${name}: ${aggType};`);
    }

  const nodeBlock = `export type ${nodeAggType} = {\n${nodeLines.join('\n')}\n};`;

  // Emit edge aggregate selection if relationship has properties
  if (rel.properties) {
    const edgeAggType = `${typeName.replace('AggregationSelection', '')}EdgeAggregateSelection`;
    const edgeLines: string[] = [`  __typename?: "${edgeAggType}";`];
    const relProps = schema.relationshipProperties.get(rel.properties);
    if (relProps)
      for (const [name, prop] of relProps.properties) {
        if (prop.isCypher) continue;
        const aggType = SCALAR_AGGREGATE_MAP[prop.type];
        if (!aggType) continue;
        edgeLines.push(`  ${name}: ${aggType};`);
      }
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

  return `export type ${typeName} = {\n${lines.join('\n')}\n};`;
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

  return `export type ${typeName} = {\n${lines.join('\n')}\n};`;
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
