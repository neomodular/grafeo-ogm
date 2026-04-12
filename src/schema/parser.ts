import {
  parse,
  Kind,
  type DocumentNode,
  type ObjectTypeDefinitionNode,
  type InterfaceTypeDefinitionNode,
  type EnumTypeDefinitionNode,
  type FieldDefinitionNode,
  type DirectiveNode,
  type TypeNode,
  type StringValueNode,
  type ListValueNode,
  type ObjectValueNode,
  type BooleanValueNode,
  type EnumValueNode,
  type IntValueNode,
  type FloatValueNode,
} from 'graphql';

import pluralizeLib from 'pluralize';

import type {
  SchemaMetadata,
  NodeDefinition,
  InterfaceDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  FulltextIndex,
} from './types';

/**
 * Generate a plural name from a type name following OGM conventions.
 * Uses the `pluralize` npm package for correct English pluralization
 * (handles uncountable words like "equipment", irregular plurals, etc.)
 */
export function pluralize(name: string): string {
  const lcFirst = name.charAt(0).toLowerCase() + name.slice(1);
  return pluralizeLib(lcFirst);
}

/** Extract the named type from a potentially wrapped (NonNull, List) type node */
function unwrapType(typeNode: TypeNode): {
  typeName: string;
  isArray: boolean;
  isRequired: boolean;
  isListItemRequired: boolean;
} {
  let isArray = false;
  let isRequired = false;
  let isListItemRequired = false;
  let current: TypeNode = typeNode;

  // Outer NonNullType means the field itself is required
  if (current.kind === Kind.NON_NULL_TYPE) {
    isRequired = true;
    current = current.type;
  }

  if (current.kind === Kind.LIST_TYPE) {
    isArray = true;
    current = current.type;
    // Inner NonNullType on list element: [Type!]
    if (current.kind === Kind.NON_NULL_TYPE) {
      isListItemRequired = true;
      current = current.type;
    }
  }

  if (current.kind === Kind.NAMED_TYPE)
    return {
      typeName: current.name.value,
      isArray,
      isRequired,
      isListItemRequired,
    };

  // Fallback - shouldn't happen with valid GraphQL
  return { typeName: 'Unknown', isArray, isRequired, isListItemRequired };
}

/** Check if a type name is a scalar (not a node/interface/enum relationship target) */
const SCALAR_TYPES = new Set([
  'String',
  'Int',
  'Float',
  'Boolean',
  'ID',
  'DateTime',
  'BigInt',
  'Date',
  'Time',
  'LocalTime',
  'LocalDateTime',
  'Duration',
  'Point',
  'CartesianPoint',
]);

function getDirective(
  node: { directives?: readonly DirectiveNode[] },
  name: string,
): DirectiveNode | undefined {
  return node.directives?.find((d) => d.name.value === name);
}

function getDirectiveArgStringValue(
  directive: DirectiveNode,
  argName: string,
): string | undefined {
  const arg = directive.arguments?.find((a) => a.name.value === argName);
  if (arg && arg.value.kind === Kind.STRING)
    return (arg.value as StringValueNode).value;

  if (arg && arg.value.kind === Kind.ENUM)
    return (arg.value as EnumValueNode).value;

  return undefined;
}

function getDirectiveArgValue(
  directive: DirectiveNode,
  argName: string,
):
  | StringValueNode
  | ListValueNode
  | ObjectValueNode
  | BooleanValueNode
  | EnumValueNode
  | IntValueNode
  | FloatValueNode
  | undefined {
  const arg = directive.arguments?.find((a) => a.name.value === argName);
  if (!arg) return undefined;
  return arg.value as
    | StringValueNode
    | ListValueNode
    | ObjectValueNode
    | BooleanValueNode
    | EnumValueNode
    | IntValueNode
    | FloatValueNode;
}

/** Parse a field definition into either a PropertyDefinition or RelationshipDefinition */
function parseField(
  field: FieldDefinitionNode,
  enumNames: Set<string>,
): { property?: PropertyDefinition; relationship?: RelationshipDefinition } {
  const { typeName, isArray, isRequired, isListItemRequired } = unwrapType(
    field.type,
  );

  const relationshipDirective = getDirective(field, 'relationship');
  const declareRelDirective = getDirective(field, 'declareRelationship');

  // If it has @relationship directive, it's a relationship
  if (relationshipDirective) {
    const relType = getDirectiveArgStringValue(relationshipDirective, 'type');
    const direction = getDirectiveArgStringValue(
      relationshipDirective,
      'direction',
    );
    const properties = getDirectiveArgStringValue(
      relationshipDirective,
      'properties',
    );

    if (!relType || !direction)
      // Malformed directive, skip
      return {};

    const rel: RelationshipDefinition = {
      fieldName: field.name.value,
      type: relType,
      direction: direction as 'IN' | 'OUT',
      target: typeName,
      isArray,
      isRequired,
    };
    if (properties) rel.properties = properties;

    return { relationship: rel };
  }

  // If it has @declareRelationship, treat as a relationship declaration
  // (used for interface types — direction/type come from concrete implementors)
  if (declareRelDirective) {
    const rel: RelationshipDefinition = {
      fieldName: field.name.value,
      type: '', // Unknown at interface level
      direction: 'OUT', // Default; concrete types provide actual direction
      target: typeName,
      isArray,
      isRequired,
    };
    return { relationship: rel };
  }

  // Otherwise it's a property (scalar, enum, or unknown type treated as scalar)
  const idDirective = getDirective(field, 'id');
  const uniqueDirective = getDirective(field, 'unique');
  const cypherDirective = getDirective(field, 'cypher');
  const defaultDirective = getDirective(field, 'default');

  let defaultValue: string | undefined;
  if (defaultDirective) {
    const val = getDirectiveArgValue(defaultDirective, 'value');
    if (val)
      if (val.kind === Kind.STRING) defaultValue = val.value;
      else if (val.kind === Kind.BOOLEAN) defaultValue = String(val.value);
      else if (val.kind === Kind.ENUM) defaultValue = val.value;
      else if (val.kind === Kind.INT) defaultValue = val.value;
      else if (val.kind === Kind.FLOAT) defaultValue = val.value;
  }

  // Determine if this is truly a scalar property
  // A non-scalar, non-enum type without @relationship is unusual but we treat it as a property
  // if it's a known scalar or enum
  const isScalarOrEnum = SCALAR_TYPES.has(typeName) || enumNames.has(typeName);

  if (!isScalarOrEnum && !isArray) {
    // Could be a relationship to a node type without @relationship directive
    // but per the schema patterns we've seen, we'll still treat it as property
    // unless it's array of a non-scalar
  }

  const directives = field.directives?.map((d) => d.name.value) ?? [];

  const prop: PropertyDefinition = {
    name: field.name.value,
    type: typeName,
    required: isRequired,
    isArray,
    isListItemRequired,
    isGenerated: !!idDirective,
    isUnique: !!uniqueDirective,
    isCypher: !!cypherDirective,
    directives,
    defaultValue,
  };

  return { property: prop };
}

/** Parse @fulltext indexes from a type definition */
function parseFulltextIndexes(
  node: ObjectTypeDefinitionNode | InterfaceTypeDefinitionNode,
): FulltextIndex[] {
  const ftDirective = getDirective(node, 'fulltext');
  if (!ftDirective) return [];

  const indexesArg = getDirectiveArgValue(ftDirective, 'indexes');
  if (!indexesArg || indexesArg.kind !== Kind.LIST) return [];

  const results: FulltextIndex[] = [];
  for (const item of (indexesArg as ListValueNode).values) {
    if (item.kind !== Kind.OBJECT) continue;
    const obj = item as ObjectValueNode;

    let name = '';
    const fields: string[] = [];

    for (const field of obj.fields) {
      if (field.name.value === 'name' && field.value.kind === Kind.STRING)
        name = (field.value as StringValueNode).value;

      if (field.name.value === 'fields' && field.value.kind === Kind.LIST)
        for (const f of (field.value as ListValueNode).values)
          if (f.kind === Kind.STRING) fields.push((f as StringValueNode).value);
    }

    if (name && fields.length > 0) results.push({ name, fields });
  }

  return results;
}

/** Parse @node labels directive */
function parseNodeLabels(node: ObjectTypeDefinitionNode): string[] | undefined {
  const nodeDirective = getDirective(node, 'node');
  if (!nodeDirective) return undefined;

  const labelsArg = getDirectiveArgValue(nodeDirective, 'labels');
  if (!labelsArg || labelsArg.kind !== Kind.LIST) return undefined;

  const labels: string[] = [];
  for (const val of (labelsArg as ListValueNode).values)
    if (val.kind === Kind.STRING) labels.push((val as StringValueNode).value);

  return labels.length > 0 ? labels : undefined;
}

/**
 * Parse a GraphQL schema string into SchemaMetadata.
 */
export function parseSchema(schemaSource: string): SchemaMetadata {
  const document: DocumentNode = parse(schemaSource);

  const metadata: SchemaMetadata = {
    nodes: new Map(),
    interfaces: new Map(),
    relationshipProperties: new Map(),
    enums: new Map(),
    unions: new Map(),
  };

  // First pass: collect enum names and relationship properties type names
  const enumNames = new Set<string>();
  const relPropsTypeNames = new Set<string>();
  const unionMembers = new Map<string, string[]>();

  for (const def of document.definitions) {
    if (def.kind === Kind.ENUM_TYPE_DEFINITION) {
      const enumDef = def as EnumTypeDefinitionNode;
      const values = enumDef.values?.map((v) => v.name.value) ?? [];
      metadata.enums.set(enumDef.name.value, values);
      enumNames.add(enumDef.name.value);
    }

    if (def.kind === Kind.OBJECT_TYPE_DEFINITION) {
      const objDef = def as ObjectTypeDefinitionNode;
      if (getDirective(objDef, 'relationshipProperties'))
        relPropsTypeNames.add(objDef.name.value);
    }

    if (def.kind === Kind.UNION_TYPE_DEFINITION) {
      const members = def.types?.map((t) => t.name.value) ?? [];
      unionMembers.set(def.name.value, members);
      metadata.unions.set(def.name.value, members);
    }
  }

  // Second pass: parse interfaces
  for (const def of document.definitions)
    if (def.kind === Kind.INTERFACE_TYPE_DEFINITION) {
      const intDef = def as InterfaceTypeDefinitionNode;
      const properties = new Map<string, PropertyDefinition>();
      const relationships = new Map<string, RelationshipDefinition>();

      for (const field of intDef.fields ?? []) {
        const parsed = parseField(field, enumNames);
        if (parsed.property)
          properties.set(parsed.property.name, parsed.property);

        if (parsed.relationship)
          relationships.set(parsed.relationship.fieldName, parsed.relationship);
      }

      const interfaceDef: InterfaceDefinition = {
        name: intDef.name.value,
        label: intDef.name.value,
        properties,
        relationships,
        implementedBy: [], // populated in third pass
      };

      metadata.interfaces.set(intDef.name.value, interfaceDef);
    }

  // Third pass: parse object types (nodes and relationship properties)
  for (const def of document.definitions) {
    if (def.kind !== Kind.OBJECT_TYPE_DEFINITION) continue;
    const objDef = def as ObjectTypeDefinitionNode;
    const typeName = objDef.name.value;

    // Handle @relationshipProperties types
    if (relPropsTypeNames.has(typeName)) {
      const properties = new Map<string, PropertyDefinition>();
      for (const field of objDef.fields ?? []) {
        const parsed = parseField(field, enumNames);
        if (parsed.property)
          properties.set(parsed.property.name, parsed.property);
      }
      const fulltextIndexes = parseFulltextIndexes(objDef);
      metadata.relationshipProperties.set(typeName, {
        typeName,
        properties,
        fulltextIndexes,
      });
      continue;
    }

    // Regular node type
    const properties = new Map<string, PropertyDefinition>();
    const relationships = new Map<string, RelationshipDefinition>();

    for (const field of objDef.fields ?? []) {
      const parsed = parseField(field, enumNames);
      if (parsed.property)
        properties.set(parsed.property.name, parsed.property);

      if (parsed.relationship)
        relationships.set(parsed.relationship.fieldName, parsed.relationship);
    }

    // Determine labels
    const nodeLabels = parseNodeLabels(objDef);
    const implementsInterfaces =
      objDef.interfaces?.map((i) => i.name.value) ?? [];

    // Register with interfaces
    for (const ifaceName of implementsInterfaces) {
      const iface = metadata.interfaces.get(ifaceName);
      if (iface) iface.implementedBy.push(typeName);
    }

    // If @node(labels: [...]) is specified, use those labels
    // Otherwise, use the typeName as the single label
    let labels: string[];
    let label: string;
    if (nodeLabels) {
      labels = nodeLabels;
      label = typeName;
    } else {
      labels = [typeName];
      label = typeName;
    }

    const fulltextIndexes = parseFulltextIndexes(objDef);

    const nodeDef: NodeDefinition = {
      typeName,
      label,
      labels,
      pluralName: pluralize(typeName),
      properties,
      relationships,
      fulltextIndexes,
      implementsInterfaces,
    };

    metadata.nodes.set(typeName, nodeDef);
  }

  return metadata;
}
