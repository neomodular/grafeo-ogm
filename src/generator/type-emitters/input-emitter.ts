import type {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  RelationshipPropertiesDefinition,
  SchemaMetadata,
} from '../../schema/types';
import { isBuiltInScalar, toPascalCase } from './helpers';

/** Wrap a type in `Array<T>` when the relationship is an array, otherwise use `T`. */
function wrapArray(typeStr: string, isArray: boolean): string {
  return isArray ? `Array<${typeStr}>` : typeStr;
}

/** Returns true when the named node exists in the schema and has at least one relationship. */
function nodeHasRelationships(
  typeName: string,
  schema: SchemaMetadata,
): boolean {
  const node = schema.nodes.get(typeName);
  return node !== undefined && node.relationships.size > 0;
}

/**
 * Emits all input types for every node in the schema.
 */
export function emitInputTypes(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  const sortedNodes = [...schema.nodes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  const emittedConnectWheres = new Set<string>();
  const emittedTypeNames = new Set<string>();

  for (const [, node] of sortedNodes) {
    blocks.push(emitCreateInput(node, schema));
    blocks.push(emitUpdateInput(node, schema));
    if (node.relationships.size > 0) {
      blocks.push(emitConnectInput(node, schema));
      blocks.push(emitDisconnectInput(node, schema));
      blocks.push(emitDeleteInput(node, schema));
    }

    for (const [, rel] of node.relationships) {
      const members = getTargetMembers(rel.target, schema);

      if (members) {
        // Union/interface target → per-member keyed types
        const pascal = toPascalCase(rel.fieldName);
        const prefix = `${node.typeName}${pascal}`;
        // Track emitted type names to avoid duplicates with union CRUD section
        emittedTypeNames.add(`${prefix}CreateInput`);
        emittedTypeNames.add(`${prefix}UpdateFieldInput`);
        emittedTypeNames.add(`${prefix}UpdateInput`);
        emittedTypeNames.add(`${prefix}ConnectInput`);
        emittedTypeNames.add(`${prefix}DisconnectInput`);
        emittedTypeNames.add(`${prefix}DeleteInput`);

        blocks.push(...emitUnionRelFieldInput(node.typeName, rel, members));
        blocks.push(
          ...emitUnionRelCreateFieldInput(node.typeName, rel, members),
        );
        blocks.push(
          ...emitUnionRelConnectFieldInput(node.typeName, rel, members, schema),
        );
        blocks.push(
          ...emitUnionRelDisconnectFieldInput(
            node.typeName,
            rel,
            members,
            schema,
          ),
        );
        blocks.push(
          ...emitUnionRelDeleteFieldInput(node.typeName, rel, members, schema),
        );
        blocks.push(
          ...emitUnionRelUpdateFieldInput(node.typeName, rel, members),
        );
        blocks.push(
          ...emitUnionRelUpdateConnectionInput(node.typeName, rel, members),
        );
      } else {
        // Normal target → flat types
        blocks.push(emitFieldInput(node.typeName, rel));
        blocks.push(emitCreateFieldInput(node.typeName, rel));
        blocks.push(emitConnectFieldInput(node.typeName, rel, schema));
        blocks.push(emitDisconnectFieldInput(node.typeName, rel, schema));
        blocks.push(emitDeleteFieldInput(node.typeName, rel, schema));
        blocks.push(emitUpdateFieldInput(node.typeName, rel));
        blocks.push(emitUpdateConnectionInput(node.typeName, rel));
      }

      // ConnectWhere — one per target node (skip unions/interfaces)
      if (!members) {
        const connectWhereName = `${rel.target}ConnectWhere`;
        if (!emittedConnectWheres.has(connectWhereName)) {
          emittedConnectWheres.add(connectWhereName);
          blocks.push(emitConnectWhere(rel.target));
        }
      } else
        // Per-member ConnectWhere for union targets
        for (const m of members) {
          const connectWhereName = `${m}ConnectWhere`;
          if (!emittedConnectWheres.has(connectWhereName)) {
            emittedConnectWheres.add(connectWhereName);
            blocks.push(emitConnectWhere(m));
          }
        }
    }
  }

  // Relationship-property input types
  const sortedRelProps = [...schema.relationshipProperties.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  );
  for (const [, relProp] of sortedRelProps) {
    blocks.push(emitRelPropCreateInput(relProp, schema));
    blocks.push(emitRelPropUpdateInput(relProp, schema));
  }

  // Union CRUD input types (per-member keyed)
  // Skip if already emitted by per-relationship union handling
  const sortedUnions = [...(schema.unions?.entries() ?? [])].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [name, members] of sortedUnions) {
    if (!emittedTypeNames.has(`${name}CreateInput`))
      blocks.push(emitUnionCreateInput(name, members));
    if (!emittedTypeNames.has(`${name}UpdateInput`))
      blocks.push(emitUnionUpdateInput(name, members));
    if (!emittedTypeNames.has(`${name}ConnectInput`))
      blocks.push(emitUnionConnectInput(name, members, schema));
    if (!emittedTypeNames.has(`${name}DisconnectInput`))
      blocks.push(emitUnionDisconnectInput(name, members, schema));
    if (!emittedTypeNames.has(`${name}DeleteInput`))
      blocks.push(emitUnionDeleteInput(name, members, schema));
  }

  // Interface CRUD input types (per-implementor keyed)
  const sortedInterfaces = [...schema.interfaces.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [, iface] of sortedInterfaces) {
    if (iface.implementedBy.length === 0) continue;
    blocks.push(emitUnionCreateInput(iface.name, iface.implementedBy));
    blocks.push(emitUnionUpdateInput(iface.name, iface.implementedBy));
    blocks.push(emitUnionConnectInput(iface.name, iface.implementedBy, schema));
    blocks.push(
      emitUnionDisconnectInput(iface.name, iface.implementedBy, schema),
    );
    blocks.push(emitUnionDeleteInput(iface.name, iface.implementedBy, schema));
  }

  return blocks.filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapInputScalar(
  typeName: string,
  enums: Map<string, string[]>,
): string {
  if (isBuiltInScalar(typeName)) return `Scalars["${typeName}"]["input"]`;
  if (enums.has(typeName)) return typeName;
  return typeName;
}

/**
 * Returns union member type names if the target is a union type,
 * otherwise `undefined` for normal node or interface targets.
 *
 * Interface targets are NOT treated as per-member keyed — the old OGM
 * uses flat input types for interface-target relationships.
 */
function getTargetMembers(
  target: string,
  schema: SchemaMetadata,
): string[] | undefined {
  const unionMembers = schema.unions?.get(target);
  if (unionMembers) return unionMembers;

  return undefined;
}

// ---------------------------------------------------------------------------
// CreateInput
// ---------------------------------------------------------------------------

function emitCreateInput(node: NodeDefinition, schema: SchemaMetadata): string {
  const members: string[] = [];

  for (const [, prop] of node.properties) {
    if (prop.isCypher) continue;
    if (prop.isGenerated) continue;
    members.push(emitCreateScalarField(prop, schema));
  }

  for (const [, rel] of node.relationships) {
    const pascal = toPascalCase(rel.fieldName);
    const targetMembers = getTargetMembers(rel.target, schema);

    if (targetMembers)
      // Union/interface target — use CreateInput (per-member keyed, has connect/create)
      members.push(
        `  ${rel.fieldName}?: InputMaybe<${node.typeName}${pascal}CreateInput>;`,
      );
    else
      members.push(
        `  ${rel.fieldName}?: InputMaybe<${node.typeName}${pascal}FieldInput>;`,
      );
  }

  return `export type ${node.typeName}CreateInput = {\n${members.join('\n')}\n};`;
}

function emitCreateScalarField(
  prop: PropertyDefinition,
  schema: SchemaMetadata,
): string {
  const tsType = mapInputScalar(prop.type, schema.enums);
  const wrapped = prop.isArray ? `Array<${tsType}>` : tsType;

  if (prop.required) return `  ${prop.name}: ${wrapped};`;
  return `  ${prop.name}?: InputMaybe<${wrapped}>;`;
}

// ---------------------------------------------------------------------------
// UpdateInput
// ---------------------------------------------------------------------------

function emitUpdateInput(node: NodeDefinition, schema: SchemaMetadata): string {
  const members: string[] = [];

  for (const [, prop] of node.properties) {
    if (prop.isCypher) continue;
    if (prop.isGenerated) continue;

    const tsType = mapInputScalar(prop.type, schema.enums);
    const wrapped = prop.isArray ? `Array<${tsType}>` : tsType;
    members.push(`  ${prop.name}?: InputMaybe<${wrapped}>;`);
  }

  for (const [, rel] of node.relationships) {
    const pascal = toPascalCase(rel.fieldName);
    const targetMembers = getTargetMembers(rel.target, schema);

    if (targetMembers)
      // Union/interface target — use UpdateFieldInput (per-member keyed, singular)
      members.push(
        `  ${rel.fieldName}?: InputMaybe<${node.typeName}${pascal}UpdateFieldInput>;`,
      );
    else {
      const typeName = `${node.typeName}${pascal}UpdateFieldInput`;
      if (rel.isArray)
        members.push(`  ${rel.fieldName}?: InputMaybe<Array<${typeName}>>;`);
      else members.push(`  ${rel.fieldName}?: InputMaybe<${typeName}>;`);
    }
  }

  return `export type ${node.typeName}UpdateInput = {\n${members.join('\n')}\n};`;
}

// ---------------------------------------------------------------------------
// ConnectInput
// ---------------------------------------------------------------------------

function emitConnectInput(
  node: NodeDefinition,
  schema: SchemaMetadata,
): string {
  const members: string[] = [];

  for (const [, rel] of node.relationships) {
    const pascal = toPascalCase(rel.fieldName);
    const targetMembers = getTargetMembers(rel.target, schema);

    if (targetMembers)
      members.push(
        `  ${rel.fieldName}?: InputMaybe<${node.typeName}${pascal}ConnectInput>;`,
      );
    else {
      const typeName = `${node.typeName}${pascal}ConnectFieldInput`;
      if (rel.isArray)
        members.push(`  ${rel.fieldName}?: InputMaybe<Array<${typeName}>>;`);
      else members.push(`  ${rel.fieldName}?: InputMaybe<${typeName}>;`);
    }
  }

  return `export type ${node.typeName}ConnectInput = {\n${members.join('\n')}\n};`;
}

// ---------------------------------------------------------------------------
// DisconnectInput
// ---------------------------------------------------------------------------

function emitDisconnectInput(
  node: NodeDefinition,
  schema: SchemaMetadata,
): string {
  const members: string[] = [];

  for (const [, rel] of node.relationships) {
    const pascal = toPascalCase(rel.fieldName);
    const targetMembers = getTargetMembers(rel.target, schema);

    if (targetMembers)
      members.push(
        `  ${rel.fieldName}?: InputMaybe<${node.typeName}${pascal}DisconnectInput>;`,
      );
    else {
      const typeName = `${node.typeName}${pascal}DisconnectFieldInput`;
      if (rel.isArray)
        members.push(`  ${rel.fieldName}?: InputMaybe<Array<${typeName}>>;`);
      else members.push(`  ${rel.fieldName}?: InputMaybe<${typeName}>;`);
    }
  }

  return `export type ${node.typeName}DisconnectInput = {\n${members.join('\n')}\n};`;
}

// ---------------------------------------------------------------------------
// DeleteInput
// ---------------------------------------------------------------------------

function emitDeleteInput(node: NodeDefinition, schema: SchemaMetadata): string {
  const members: string[] = [];

  for (const [, rel] of node.relationships) {
    const pascal = toPascalCase(rel.fieldName);
    const targetMembers = getTargetMembers(rel.target, schema);

    if (targetMembers)
      members.push(
        `  ${rel.fieldName}?: InputMaybe<${node.typeName}${pascal}DeleteInput>;`,
      );
    else {
      const typeName = `${node.typeName}${pascal}DeleteFieldInput`;
      if (rel.isArray)
        members.push(`  ${rel.fieldName}?: InputMaybe<Array<${typeName}>>;`);
      else members.push(`  ${rel.fieldName}?: InputMaybe<${typeName}>;`);
    }
  }

  return `export type ${node.typeName}DeleteInput = {\n${members.join('\n')}\n};`;
}

// ---------------------------------------------------------------------------
// Per-relationship field input types (normal, non-union targets)
// ---------------------------------------------------------------------------

function emitFieldInput(typeName: string, rel: RelationshipDefinition): string {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const members: string[] = [];

  if (rel.isArray) {
    members.push(`  connect?: InputMaybe<Array<${prefix}ConnectFieldInput>>;`);
    members.push(`  create?: InputMaybe<Array<${prefix}CreateFieldInput>>;`);
  } else {
    members.push(`  connect?: InputMaybe<${prefix}ConnectFieldInput>;`);
    members.push(`  create?: InputMaybe<${prefix}CreateFieldInput>;`);
  }

  return `export type ${prefix}FieldInput = {\n${members.join('\n')}\n};`;
}

function emitCreateFieldInput(
  typeName: string,
  rel: RelationshipDefinition,
): string {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const members: string[] = [];

  if (rel.properties)
    members.push(`  edge?: InputMaybe<${rel.properties}CreateInput>;`);

  members.push(`  node: ${rel.target}CreateInput;`);

  return `export type ${prefix}CreateFieldInput = {\n${members.join('\n')}\n};`;
}

function emitConnectFieldInput(
  typeName: string,
  rel: RelationshipDefinition,
  schema: SchemaMetadata,
): string {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const members: string[] = [];

  if (rel.properties)
    members.push(`  edge?: InputMaybe<${rel.properties}CreateInput>;`);

  members.push(`  where?: InputMaybe<${rel.target}ConnectWhere>;`);
  members.push(
    `  /** Whether or not to overwrite any matching relationship with the new properties. */`,
  );
  members.push(`  overwrite?: Scalars["Boolean"]["input"];`);

  if (nodeHasRelationships(rel.target, schema))
    if (rel.isArray)
      members.push(`  connect?: InputMaybe<Array<${rel.target}ConnectInput>>;`);
    else members.push(`  connect?: InputMaybe<${rel.target}ConnectInput>;`);

  return `export type ${prefix}ConnectFieldInput = {\n${members.join('\n')}\n};`;
}

function emitDisconnectFieldInput(
  typeName: string,
  rel: RelationshipDefinition,
  schema: SchemaMetadata,
): string {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const members: string[] = [];

  members.push(`  where?: InputMaybe<${prefix}ConnectionWhere>;`);
  if (nodeHasRelationships(rel.target, schema))
    members.push(`  disconnect?: InputMaybe<${rel.target}DisconnectInput>;`);

  return `export type ${prefix}DisconnectFieldInput = {\n${members.join('\n')}\n};`;
}

function emitDeleteFieldInput(
  typeName: string,
  rel: RelationshipDefinition,
  schema: SchemaMetadata,
): string {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const members: string[] = [];

  members.push(`  where?: InputMaybe<${prefix}ConnectionWhere>;`);
  if (nodeHasRelationships(rel.target, schema))
    members.push(`  delete?: InputMaybe<${rel.target}DeleteInput>;`);

  return `export type ${prefix}DeleteFieldInput = {\n${members.join('\n')}\n};`;
}

function emitUpdateFieldInput(
  typeName: string,
  rel: RelationshipDefinition,
): string {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const members: string[] = [];

  members.push(`  where?: InputMaybe<${prefix}ConnectionWhere>;`);

  if (rel.isArray) {
    members.push(`  connect?: InputMaybe<Array<${prefix}ConnectFieldInput>>;`);
    members.push(
      `  disconnect?: InputMaybe<Array<${prefix}DisconnectFieldInput>>;`,
    );
    members.push(`  create?: InputMaybe<Array<${prefix}CreateFieldInput>>;`);
  } else {
    members.push(`  connect?: InputMaybe<${prefix}ConnectFieldInput>;`);
    members.push(`  disconnect?: InputMaybe<${prefix}DisconnectFieldInput>;`);
    members.push(`  create?: InputMaybe<${prefix}CreateFieldInput>;`);
  }

  members.push(`  update?: InputMaybe<${prefix}UpdateConnectionInput>;`);

  if (rel.isArray)
    members.push(`  delete?: InputMaybe<Array<${prefix}DeleteFieldInput>>;`);
  else members.push(`  delete?: InputMaybe<${prefix}DeleteFieldInput>;`);

  return `export type ${prefix}UpdateFieldInput = {\n${members.join('\n')}\n};`;
}

function emitUpdateConnectionInput(
  typeName: string,
  rel: RelationshipDefinition,
): string {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const members: string[] = [];

  members.push(`  node?: InputMaybe<${rel.target}UpdateInput>;`);

  if (rel.properties)
    members.push(`  edge?: InputMaybe<${rel.properties}UpdateInput>;`);

  return `export type ${prefix}UpdateConnectionInput = {\n${members.join('\n')}\n};`;
}

function emitConnectWhere(target: string): string {
  return `export type ${target}ConnectWhere = {
  node: ${target}Where;
};`;
}

// ---------------------------------------------------------------------------
// Union/Interface target relationship input types (per-member keyed)
// ---------------------------------------------------------------------------

/**
 * Emits per-member keyed CreateInput for a union-target relationship.
 * e.g., DoseDoseTypesCreateInput = { RangeDose?: ..., StandardDose?: ... }
 * Plus per-member sub-types: DoseDoseTypesRangeDoseFieldInput
 */
function emitUnionRelFieldInput(
  typeName: string,
  rel: RelationshipDefinition,
  members: string[],
): string[] {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const sorted = [...members].sort();
  const blocks: string[] = [];

  // Top-level per-member FieldInput
  // Emitted as both CreateInput and CreateFieldInput for backward compat
  const lines = sorted.map(
    (m) => `  ${m}?: InputMaybe<${prefix}${m}FieldInput>;`,
  );
  const fieldInputBody = lines.join('\n');
  blocks.push(`export type ${prefix}CreateInput = {\n${fieldInputBody}\n};`);
  blocks.push(`export type ${prefix}CreateFieldInput = ${prefix}CreateInput;`);

  // Per-member FieldInput sub-types
  for (const m of sorted) {
    const subMembers: string[] = [];
    subMembers.push(
      `  connect?: InputMaybe<${wrapArray(`${prefix}${m}ConnectFieldInput`, rel.isArray)}>;`,
    );
    subMembers.push(
      `  create?: InputMaybe<${wrapArray(`${prefix}${m}CreateFieldInput`, rel.isArray)}>;`,
    );
    blocks.push(
      `export type ${prefix}${m}FieldInput = {\n${subMembers.join('\n')}\n};`,
    );
  }

  return blocks;
}

function emitUnionRelCreateFieldInput(
  typeName: string,
  rel: RelationshipDefinition,
  members: string[],
): string[] {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const sorted = [...members].sort();
  const blocks: string[] = [];

  // Per-member CreateFieldInput sub-types
  // (top-level CreateFieldInput is emitted as alias of CreateInput in emitUnionRelFieldInput)
  for (const m of sorted) {
    const subMembers: string[] = [];
    if (rel.properties)
      subMembers.push(`  edge?: InputMaybe<${rel.properties}CreateInput>;`);
    subMembers.push(`  node: ${m}CreateInput;`);
    blocks.push(
      `export type ${prefix}${m}CreateFieldInput = {\n${subMembers.join('\n')}\n};`,
    );
  }

  return blocks;
}

function emitUnionRelConnectFieldInput(
  typeName: string,
  rel: RelationshipDefinition,
  members: string[],
  schema: SchemaMetadata,
): string[] {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const sorted = [...members].sort();
  const blocks: string[] = [];

  // Top-level per-member ConnectInput
  const lines = sorted.map(
    (m) =>
      `  ${m}?: InputMaybe<${wrapArray(`${prefix}${m}ConnectFieldInput`, rel.isArray)}>;`,
  );
  blocks.push(`export type ${prefix}ConnectInput = {\n${lines.join('\n')}\n};`);

  // Per-member ConnectFieldInput sub-types
  for (const m of sorted) {
    const subMembers: string[] = [];
    if (rel.properties)
      subMembers.push(`  edge?: InputMaybe<${rel.properties}CreateInput>;`);
    subMembers.push(`  where?: InputMaybe<${m}ConnectWhere>;`);
    subMembers.push(
      `  /** Whether or not to overwrite any matching relationship with the new properties. */`,
    );
    subMembers.push(`  overwrite?: Scalars["Boolean"]["input"];`);
    if (nodeHasRelationships(m, schema))
      subMembers.push(
        `  connect?: InputMaybe<${wrapArray(`${m}ConnectInput`, rel.isArray)}>;`,
      );

    blocks.push(
      `export type ${prefix}${m}ConnectFieldInput = {\n${subMembers.join('\n')}\n};`,
    );
  }

  return blocks;
}

function emitUnionRelDisconnectFieldInput(
  typeName: string,
  rel: RelationshipDefinition,
  members: string[],
  schema: SchemaMetadata,
): string[] {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const sorted = [...members].sort();
  const blocks: string[] = [];

  // Top-level per-member DisconnectInput
  const lines = sorted.map(
    (m) =>
      `  ${m}?: InputMaybe<${wrapArray(`${prefix}${m}DisconnectFieldInput`, rel.isArray)}>;`,
  );
  blocks.push(
    `export type ${prefix}DisconnectInput = {\n${lines.join('\n')}\n};`,
  );

  // Per-member DisconnectFieldInput sub-types
  for (const m of sorted) {
    const subMembers: string[] = [];
    subMembers.push(`  where?: InputMaybe<${prefix}${m}ConnectionWhere>;`);
    if (nodeHasRelationships(m, schema))
      subMembers.push(`  disconnect?: InputMaybe<${m}DisconnectInput>;`);

    blocks.push(
      `export type ${prefix}${m}DisconnectFieldInput = {\n${subMembers.join('\n')}\n};`,
    );
  }

  return blocks;
}

function emitUnionRelDeleteFieldInput(
  typeName: string,
  rel: RelationshipDefinition,
  members: string[],
  schema: SchemaMetadata,
): string[] {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const sorted = [...members].sort();
  const blocks: string[] = [];

  // Top-level per-member DeleteInput
  const lines = sorted.map(
    (m) =>
      `  ${m}?: InputMaybe<${wrapArray(`${prefix}${m}DeleteFieldInput`, rel.isArray)}>;`,
  );
  blocks.push(`export type ${prefix}DeleteInput = {\n${lines.join('\n')}\n};`);

  // Per-member DeleteFieldInput sub-types
  for (const m of sorted) {
    const subMembers: string[] = [];
    subMembers.push(`  where?: InputMaybe<${prefix}${m}ConnectionWhere>;`);
    if (nodeHasRelationships(m, schema))
      subMembers.push(`  delete?: InputMaybe<${m}DeleteInput>;`);

    blocks.push(
      `export type ${prefix}${m}DeleteFieldInput = {\n${subMembers.join('\n')}\n};`,
    );
  }

  return blocks;
}

function emitUnionRelUpdateFieldInput(
  typeName: string,
  rel: RelationshipDefinition,
  members: string[],
): string[] {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const sorted = [...members].sort();
  const blocks: string[] = [];

  // Top-level per-member UpdateFieldInput
  const lines = sorted.map(
    (m) =>
      `  ${m}?: InputMaybe<${wrapArray(`${prefix}${m}UpdateFieldInput`, rel.isArray)}>;`,
  );
  blocks.push(
    `export type ${prefix}UpdateFieldInput = {\n${lines.join('\n')}\n};`,
  );
  // Backward compat alias: UpdateInput = UpdateFieldInput
  blocks.push(`export type ${prefix}UpdateInput = ${prefix}UpdateFieldInput;`);

  // Per-member UpdateFieldInput sub-types
  for (const m of sorted) {
    const subMembers: string[] = [];
    subMembers.push(`  where?: InputMaybe<${prefix}${m}ConnectionWhere>;`);
    subMembers.push(
      `  connect?: InputMaybe<${wrapArray(`${prefix}${m}ConnectFieldInput`, rel.isArray)}>;`,
    );
    subMembers.push(
      `  disconnect?: InputMaybe<${wrapArray(`${prefix}${m}DisconnectFieldInput`, rel.isArray)}>;`,
    );
    subMembers.push(
      `  create?: InputMaybe<${wrapArray(`${prefix}${m}CreateFieldInput`, rel.isArray)}>;`,
    );
    subMembers.push(
      `  update?: InputMaybe<${prefix}${m}UpdateConnectionInput>;`,
    );
    subMembers.push(
      `  delete?: InputMaybe<Array<${prefix}${m}DeleteFieldInput>>;`,
    );
    blocks.push(
      `export type ${prefix}${m}UpdateFieldInput = {\n${subMembers.join('\n')}\n};`,
    );
  }

  return blocks;
}

function emitUnionRelUpdateConnectionInput(
  typeName: string,
  rel: RelationshipDefinition,
  members: string[],
): string[] {
  const pascal = toPascalCase(rel.fieldName);
  const prefix = `${typeName}${pascal}`;
  const sorted = [...members].sort();
  const blocks: string[] = [];

  // Per-member UpdateConnectionInput sub-types
  for (const m of sorted) {
    const subMembers: string[] = [];
    subMembers.push(`  node?: InputMaybe<${m}UpdateInput>;`);
    if (rel.properties)
      subMembers.push(`  edge?: InputMaybe<${rel.properties}UpdateInput>;`);
    blocks.push(
      `export type ${prefix}${m}UpdateConnectionInput = {\n${subMembers.join('\n')}\n};`,
    );
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Relationship-property input types
// ---------------------------------------------------------------------------

function emitRelPropCreateInput(
  relProp: RelationshipPropertiesDefinition,
  schema: SchemaMetadata,
): string {
  const members: string[] = [];

  for (const [, prop] of relProp.properties) {
    if (prop.isCypher) continue;
    if (prop.isGenerated) continue;
    members.push(emitCreateScalarField(prop, schema));
  }

  return `export type ${relProp.typeName}CreateInput = {\n${members.join('\n')}\n};`;
}

function emitRelPropUpdateInput(
  relProp: RelationshipPropertiesDefinition,
  schema: SchemaMetadata,
): string {
  const members: string[] = [];

  for (const [, prop] of relProp.properties) {
    if (prop.isCypher) continue;
    if (prop.isGenerated) continue;

    const tsType = mapInputScalar(prop.type, schema.enums);
    const wrapped = prop.isArray ? `Array<${tsType}>` : tsType;
    members.push(`  ${prop.name}?: InputMaybe<${wrapped}>;`);
  }

  return `export type ${relProp.typeName}UpdateInput = {\n${members.join('\n')}\n};`;
}

// ---------------------------------------------------------------------------
// Union / Interface CRUD input types (per-member keyed)
// ---------------------------------------------------------------------------

function emitUnionCreateInput(name: string, members: string[]): string {
  const sorted = [...members].sort();
  const lines = sorted.map((m) => `  ${m}?: InputMaybe<${m}CreateInput>;`);
  return `export type ${name}CreateInput = {\n${lines.join('\n')}\n};`;
}

function emitUnionUpdateInput(name: string, members: string[]): string {
  const sorted = [...members].sort();
  const lines = sorted.map((m) => `  ${m}?: InputMaybe<${m}UpdateInput>;`);
  return `export type ${name}UpdateInput = {\n${lines.join('\n')}\n};`;
}

function emitUnionConnectInput(
  name: string,
  members: string[],
  schema: SchemaMetadata,
): string {
  const sorted = [...members].sort();
  const lines = sorted
    .filter((m) => nodeHasRelationships(m, schema))
    .map((m) => `  ${m}?: InputMaybe<Array<${m}ConnectInput>>;`);
  if (lines.length === 0) return '';
  return `export type ${name}ConnectInput = {\n${lines.join('\n')}\n};`;
}

function emitUnionDisconnectInput(
  name: string,
  members: string[],
  schema: SchemaMetadata,
): string {
  const sorted = [...members].sort();
  const lines = sorted
    .filter((m) => nodeHasRelationships(m, schema))
    .map((m) => `  ${m}?: InputMaybe<Array<${m}DisconnectInput>>;`);
  if (lines.length === 0) return '';
  return `export type ${name}DisconnectInput = {\n${lines.join('\n')}\n};`;
}

function emitUnionDeleteInput(
  name: string,
  members: string[],
  schema: SchemaMetadata,
): string {
  const sorted = [...members].sort();
  const lines = sorted
    .filter((m) => nodeHasRelationships(m, schema))
    .map((m) => `  ${m}?: InputMaybe<Array<${m}DeleteInput>>;`);
  if (lines.length === 0) return '';
  return `export type ${name}DeleteInput = {\n${lines.join('\n')}\n};`;
}
