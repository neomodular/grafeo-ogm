import type {
  SchemaMetadata,
  RelationshipDefinition,
} from '../../schema/types';
import { toPascalCase } from './helpers';

// ---------------------------------------------------------------------------
// Connection Where types
// ---------------------------------------------------------------------------

/**
 * Emits `{Parent}{PascalField}ConnectionWhere` types for every relationship
 * on every node in the schema.
 *
 * Each ConnectionWhere type contains:
 * - `node` / `node_NOT` — target node Where filter
 * - `edge` / `edge_NOT` — edge property Where filter (only when relationship has properties)
 * - `AND` / `OR` / `NOT` — logical operators
 */
export function emitConnectionWhereTypes(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  const sortedNodes = [...schema.nodes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, node] of sortedNodes) {
    const sortedRels = [...node.relationships.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );

    for (const [, rel] of sortedRels) {
      const unionMembers = schema.unions?.get(rel.target);
      if (unionMembers)
        // Union target → emit per-member ConnectionWhere types
        blocks.push(
          ...emitUnionConnectionWheres(
            node.typeName,
            rel,
            unionMembers,
            schema,
          ),
        );
      else blocks.push(emitConnectionWhere(node.typeName, rel, schema));
    }
  }

  // Interface connection where types
  const sortedInterfaces = [...schema.interfaces.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, iface] of sortedInterfaces) {
    const sortedRels = [...iface.relationships.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );

    for (const [, rel] of sortedRels)
      blocks.push(emitInterfaceConnectionWhere(iface.name, rel, schema));
  }

  return blocks.join('\n\n');
}

function emitConnectionWhere(
  parentType: string,
  rel: RelationshipDefinition,
  schema: SchemaMetadata,
): string {
  const pascalField = toPascalCase(rel.fieldName);
  const typeName = `${parentType}${pascalField}ConnectionWhere`;
  const lines: string[] = [];

  // node filters
  lines.push(`  node?: InputMaybe<${rel.target}Where>;`);
  lines.push(`  node_NOT?: InputMaybe<${rel.target}Where>;`);

  // edge filters (only when relationship has properties)
  if (rel.properties) {
    const edgeWhereName = resolveEdgeWhereName(rel.properties, schema);
    lines.push(`  edge?: InputMaybe<${edgeWhereName}>;`);
    lines.push(`  edge_NOT?: InputMaybe<${edgeWhereName}>;`);
  }

  // Logical operators
  lines.push(`  AND?: InputMaybe<Array<${typeName}>>;`);
  lines.push(`  OR?: InputMaybe<Array<${typeName}>>;`);
  lines.push(`  NOT?: InputMaybe<${typeName}>;`);

  return `export type ${typeName} = {\n${lines.join('\n')}\n};`;
}

// ---------------------------------------------------------------------------
// Connection & Edge (Relationship) types
// ---------------------------------------------------------------------------

/**
 * Emits Connection, Relationship (edge), and PageInfo types.
 *
 * For each relationship on each node:
 * - `{Parent}{PascalField}Connection` — edges array, totalCount, pageInfo
 * - `{Parent}{PascalField}Relationship` — cursor, node, and optional properties
 *
 * Also emits the `PageInfo` type exactly once.
 */
export function emitConnectionEdgeTypes(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  // PageInfo (emitted once at the top)
  blocks.push(emitPageInfo());

  const sortedNodes = [...schema.nodes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, node] of sortedNodes) {
    const sortedRels = [...node.relationships.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );

    for (const [, rel] of sortedRels) {
      const unionMembers = schema.unions?.get(rel.target);
      if (unionMembers)
        blocks.push(
          ...emitUnionConnectionAndRelationships(
            node.typeName,
            rel,
            unionMembers,
          ),
        );
      else blocks.push(emitConnectionAndRelationship(node.typeName, rel));
    }
  }

  // Interface connection/edge types
  const sortedInterfaces = [...schema.interfaces.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, iface] of sortedInterfaces) {
    const sortedRels = [...iface.relationships.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );

    for (const [, rel] of sortedRels)
      blocks.push(
        emitInterfaceConnectionAndRelationship(iface.name, rel, schema),
      );
  }

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitPageInfo(): string {
  return `export type PageInfo = {
  hasNextPage: Scalars["Boolean"]["output"];
  hasPreviousPage: Scalars["Boolean"]["output"];
  startCursor?: Maybe<Scalars["String"]["output"]>;
  endCursor?: Maybe<Scalars["String"]["output"]>;
};`;
}

function emitConnectionAndRelationship(
  parentType: string,
  rel: RelationshipDefinition,
): string {
  const pascalField = toPascalCase(rel.fieldName);
  const connectionName = `${parentType}${pascalField}Connection`;
  const relationshipName = `${parentType}${pascalField}Relationship`;

  // Connection type
  const connectionType = `export type ${connectionName} = {
  edges: Array<${relationshipName}>;
  totalCount: Scalars["Int"]["output"];
  pageInfo: PageInfo;
};`;

  // Relationship type
  const relLines: string[] = [];
  relLines.push(`  cursor: Scalars["String"]["output"];`);
  relLines.push(`  node: ${rel.target};`);

  if (rel.properties) relLines.push(`  properties: ${rel.properties};`);

  const relationshipType = `export type ${relationshipName} = {\n${relLines.join('\n')}\n};`;

  return `${connectionType}\n\n${relationshipType}`;
}

/**
 * Resolves the Where type name for edge properties.
 *
 * Uses `{RelPropsTypeName}Where` — matching Neo4j OGM convention where the
 * relationship-properties type name is suffixed with `Where`.
 */
function resolveEdgeWhereName(
  propsTypeName: string,
  _schema: SchemaMetadata,
): string {
  return `${propsTypeName}Where`;
}

/**
 * For an interface relationship, find the edge properties type name used by
 * any concrete implementor. Returns `undefined` if none of the implementors
 * have edge properties for this relationship field.
 */
function findInterfaceRelEdgeProps(
  interfaceName: string,
  fieldName: string,
  schema: SchemaMetadata,
): string | undefined {
  const iface = schema.interfaces.get(interfaceName);
  if (!iface) return undefined;

  for (const implName of iface.implementedBy) {
    const node = schema.nodes.get(implName);
    if (!node) continue;
    const rel = node.relationships.get(fieldName);
    if (rel?.properties) return rel.properties;
  }
  return undefined;
}

/**
 * Emits ConnectionWhere for interface relationships.
 * When implementors have edge properties, emits an intermediate EdgeWhere
 * type with a discriminator key (the properties type name).
 */
function emitInterfaceConnectionWhere(
  interfaceName: string,
  rel: RelationshipDefinition,
  schema: SchemaMetadata,
): string {
  const pascalField = toPascalCase(rel.fieldName);
  const typeName = `${interfaceName}${pascalField}ConnectionWhere`;
  const lines: string[] = [];

  // node filters
  lines.push(`  node?: InputMaybe<${rel.target}Where>;`);
  lines.push(`  node_NOT?: InputMaybe<${rel.target}Where>;`);

  // edge filters — check concrete implementors for edge properties
  const edgeProps = findInterfaceRelEdgeProps(
    interfaceName,
    rel.fieldName,
    schema,
  );

  if (edgeProps) {
    const edgeWhereName = `${interfaceName}${pascalField}EdgeWhere`;
    lines.push(`  edge?: InputMaybe<${edgeWhereName}>;`);
    lines.push(`  edge_NOT?: InputMaybe<${edgeWhereName}>;`);
  }

  // Logical operators
  lines.push(`  AND?: InputMaybe<Array<${typeName}>>;`);
  lines.push(`  OR?: InputMaybe<Array<${typeName}>>;`);
  lines.push(`  NOT?: InputMaybe<${typeName}>;`);

  const blocks: string[] = [];
  blocks.push(`export type ${typeName} = {\n${lines.join('\n')}\n};`);

  // Emit the intermediate EdgeWhere type if needed
  if (edgeProps)
    blocks.push(
      `export type ${interfaceName}${pascalField}EdgeWhere = {\n` +
        `  ${edgeProps}?: InputMaybe<${edgeProps}Where>;\n` +
        `};`,
    );

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Union-target per-member Connection types
// ---------------------------------------------------------------------------

/**
 * For union-target relationships, emits per-member ConnectionWhere types.
 * e.g., DoseDoseTypesStandardDoseConnectionWhere
 */
function emitUnionConnectionWheres(
  parentType: string,
  rel: RelationshipDefinition,
  members: string[],
  schema: SchemaMetadata,
): string[] {
  const pascalField = toPascalCase(rel.fieldName);
  const prefix = `${parentType}${pascalField}`;
  const blocks: string[] = [];

  // Also emit the top-level ConnectionWhere (used by Where types)
  blocks.push(emitConnectionWhere(parentType, rel, schema));

  for (const m of [...members].sort()) {
    const typeName = `${prefix}${m}ConnectionWhere`;
    const lines: string[] = [];
    lines.push(`  node?: InputMaybe<${m}Where>;`);
    lines.push(`  node_NOT?: InputMaybe<${m}Where>;`);
    if (rel.properties) {
      const edgeWhereName = `${rel.properties}Where`;
      lines.push(`  edge?: InputMaybe<${edgeWhereName}>;`);
      lines.push(`  edge_NOT?: InputMaybe<${edgeWhereName}>;`);
    }
    lines.push(`  AND?: InputMaybe<Array<${typeName}>>;`);
    lines.push(`  OR?: InputMaybe<Array<${typeName}>>;`);
    lines.push(`  NOT?: InputMaybe<${typeName}>;`);
    blocks.push(`export type ${typeName} = {\n${lines.join('\n')}\n};`);
  }

  return blocks;
}

/**
 * For union-target relationships, emits per-member Connection and Relationship types.
 */
function emitUnionConnectionAndRelationships(
  parentType: string,
  rel: RelationshipDefinition,
  _members: string[],
): string[] {
  const pascalField = toPascalCase(rel.fieldName);
  const prefix = `${parentType}${pascalField}`;
  const blocks: string[] = [];

  // Top-level Connection type
  const connectionName = `${prefix}Connection`;
  const relationshipName = `${prefix}Relationship`;
  blocks.push(
    `export type ${connectionName} = {\n` +
      `  edges: Array<${relationshipName}>;\n` +
      `  totalCount: Scalars["Int"]["output"];\n` +
      `  pageInfo: PageInfo;\n` +
      `};`,
  );

  // Top-level Relationship type
  const relLines: string[] = [];
  relLines.push(`  cursor: Scalars["String"]["output"];`);
  relLines.push(`  node: ${rel.target};`);
  if (rel.properties) relLines.push(`  properties: ${rel.properties};`);
  blocks.push(
    `export type ${relationshipName} = {\n${relLines.join('\n')}\n};`,
  );

  return blocks;
}

/**
 * Emits Connection and Relationship types for interface relationships.
 */
function emitInterfaceConnectionAndRelationship(
  interfaceName: string,
  rel: RelationshipDefinition,
  schema: SchemaMetadata,
): string {
  const pascalField = toPascalCase(rel.fieldName);
  const connectionName = `${interfaceName}${pascalField}Connection`;
  const relationshipName = `${interfaceName}${pascalField}Relationship`;

  // Connection type
  const connectionType =
    `export type ${connectionName} = {\n` +
    `  edges: Array<${relationshipName}>;\n` +
    `  totalCount: Scalars["Int"]["output"];\n` +
    `  pageInfo: PageInfo;\n` +
    `};`;

  // Relationship type
  const relLines: string[] = [];
  relLines.push(`  cursor: Scalars["String"]["output"];`);
  relLines.push(`  node: ${rel.target};`);

  // Check if any implementor uses edge properties for this field
  const edgeProps = findInterfaceRelEdgeProps(
    interfaceName,
    rel.fieldName,
    schema,
  );
  if (edgeProps) {
    const propsAlias = `${interfaceName}${pascalField}RelationshipProperties`;
    relLines.push(`  properties: ${propsAlias};`);
  }

  const relationshipType = `export type ${relationshipName} = {\n${relLines.join('\n')}\n};`;

  const blocks = [connectionType, relationshipType];

  // Emit RelationshipProperties alias if needed
  if (edgeProps)
    blocks.push(
      `export type ${interfaceName}${pascalField}RelationshipProperties = ${edgeProps};`,
    );

  return blocks.join('\n\n');
}
