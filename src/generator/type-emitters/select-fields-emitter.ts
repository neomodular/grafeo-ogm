import type {
  InterfaceDefinition,
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../../schema/types';
import { toPascalCase } from './helpers';

/**
 * Emits `SelectFields` types for every node, interface, and edge-properties
 * type in the schema. These types describe which fields can be selected in
 * the type-safe `select` API.
 */
export function emitSelectFieldTypes(schema: SchemaMetadata): string {
  const blocks: string[] = [];

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
    if (prop.isCypher) continue;
    members.push(`  ${prop.name}?: boolean;`);
  }

  // Relationship fields
  for (const [, rel] of node.relationships)
    members.push(emitRelationshipField(rel));

  // Connection fields
  for (const [, rel] of node.relationships)
    members.push(emitConnectionField(node.typeName, rel, schema));

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
    if (prop.isCypher) continue;
    members.push(`  ${prop.name}?: boolean;`);
  }

  // Relationship fields
  for (const [, rel] of iface.relationships)
    members.push(emitRelationshipField(rel));

  // Connection fields — interfaces can also expose connections
  for (const [, rel] of iface.relationships)
    members.push(emitConnectionField(iface.name, rel, schema));

  return `export type ${iface.name}SelectFields = {\n${members.join('\n')}\n};`;
}

// ---------------------------------------------------------------------------
// Edge SelectFields (for relationships with properties)
// ---------------------------------------------------------------------------

function emitEdgeSelectFields(schema: SchemaMetadata): string[] {
  const blocks: string[] = [];
  const emittedEdges = new Set<string>();

  // Gather all relationship definitions that carry edge properties
  const allNodes = [...schema.nodes.values()];

  for (const node of allNodes)
    for (const [, rel] of node.relationships) {
      if (!rel.properties) continue;

      const edgeTypeName = buildEdgeSelectFieldsName(node.typeName, rel);
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
    `      edges?: boolean | {`,
    ...edgeMembers,
    `      };`,
    `    };`,
    `  };`,
  ];

  return lines.join('\n');
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
    members.push(`  ${prop.name}?: boolean;`);
  }

  return members;
}
