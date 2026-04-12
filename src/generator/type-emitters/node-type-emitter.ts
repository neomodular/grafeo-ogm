import type {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../../schema/types';
import { mapScalarType, toPascalCase, wrapMaybe } from './helpers';

/**
 * Emits one `export type <Node> = { ... }` declaration per node in the
 * schema, sorted alphabetically.
 *
 * Each type includes:
 * - `__typename?: "<TypeName>"`
 * - Scalar properties (skipping `@cypher` fields)
 * - Relationship fields (array or singular, required or optional)
 * - Connection fields for every relationship
 */
export function emitNodeTypes(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  const sortedNodes = [...schema.nodes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, node] of sortedNodes)
    blocks.push(emitSingleNodeType(node, schema));

  // Union types (sorted alphabetically)
  const sortedUnions = [...(schema.unions?.entries() ?? [])].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [name, members] of sortedUnions)
    blocks.push(`export type ${name} = ${members.join(' | ')};`);

  // Relationship-property base types (sorted alphabetically)
  const sortedRelProps = [...schema.relationshipProperties.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  );
  for (const [, relProp] of sortedRelProps) {
    const members: string[] = [];
    for (const [, prop] of relProp.properties) {
      if (prop.isCypher) continue;
      members.push(emitPropertyField(prop, schema));
    }
    blocks.push(
      `export type ${relProp.typeName} = {\n${members.join('\n')}\n};`,
    );
  }

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitSingleNodeType(
  node: NodeDefinition,
  schema: SchemaMetadata,
): string {
  const members: string[] = [];

  // __typename (always optional)
  members.push(`  __typename?: "${node.typeName}";`);

  // --- Scalar properties ---
  for (const [, prop] of node.properties) {
    if (prop.isCypher) {
      // @cypher fields are computed — emit as always-optional
      members.push(emitCypherField(prop, schema));
      continue;
    }

    members.push(emitPropertyField(prop, schema));
  }

  // --- Relationship fields ---
  for (const [, rel] of node.relationships) {
    members.push(emitAggregateField(node.typeName, rel));
    members.push(emitRelationshipField(rel));
    members.push(emitConnectionField(node.typeName, rel));
  }

  return `export type ${node.typeName} = {\n${members.join('\n')}\n};`;
}

/**
 * Emits a @cypher computed field as always-optional.
 *
 * @cypher fields may return scalars or node types (arrays or singular).
 * They are always optional since they're only present when explicitly queried.
 */
function emitCypherField(
  prop: PropertyDefinition,
  schema: SchemaMetadata,
): string {
  const isNodeType = schema.nodes.has(prop.type);
  const tsType = isNodeType
    ? prop.type
    : mapScalarType(prop.type, schema.enums);
  const wrapped = prop.isArray ? `Maybe<Array<${tsType}>>` : `Maybe<${tsType}>`;

  return `  ${prop.name}?: ${wrapped};`;
}

/**
 * Emits a single scalar property line.
 *
 * Examples:
 *   `  id: Scalars["ID"]["output"];`
 *   `  name?: Maybe<Scalars["String"]["output"]>;`
 */
function emitPropertyField(
  prop: PropertyDefinition,
  schema: SchemaMetadata,
): string {
  const tsType = mapScalarType(prop.type, schema.enums);
  const wrapped = prop.isArray ? `Array<${tsType}>` : tsType;
  const final = wrapMaybe(wrapped, prop.required);
  const optional = prop.required ? '' : '?';

  return `  ${prop.name}${optional}: ${final};`;
}

/**
 * Emits the relationship field line.
 *
 * Array relationships → `  drugs: Array<Drug>;`
 * Singular required   → `  hasStatus: Status;`
 * Singular optional   → `  resource?: Maybe<Resource>;`
 */
function emitRelationshipField(rel: RelationshipDefinition): string {
  if (rel.isArray) return `  ${rel.fieldName}: Array<${rel.target}>;`;

  const optional = rel.isRequired ? '' : '?';
  const type = wrapMaybe(rel.target, rel.isRequired);

  return `  ${rel.fieldName}${optional}: ${type};`;
}

/**
 * Emits the aggregate field for a relationship.
 *
 * Example: `  drugsAggregate?: Maybe<ChartDrugDrugsAggregationSelection>;`
 */
function emitAggregateField(
  typeName: string,
  rel: RelationshipDefinition,
): string {
  const pascalField = toPascalCase(rel.fieldName);
  const aggType = `${typeName}${rel.target}${pascalField}AggregationSelection`;

  return `  ${rel.fieldName}Aggregate?: Maybe<${aggType}>;`;
}

/**
 * Emits the connection field for a relationship.
 *
 * Example: `  drugsConnection: ChartDrugsConnection;`
 */
function emitConnectionField(
  typeName: string,
  rel: RelationshipDefinition,
): string {
  const pascalField = toPascalCase(rel.fieldName);
  const connectionType = `${typeName}${pascalField}Connection`;

  return `  ${rel.fieldName}Connection: ${connectionType};`;
}
