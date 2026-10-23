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
  type ValueNode,
} from 'graphql';

import pluralizeLib from 'pluralize';

import type {
  SchemaMetadata,
  NodeDefinition,
  InterfaceDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  FulltextIndex,
  VectorIndex,
} from './types';

import { assertSafeIdentifier } from '../utils/validation';
import { OGMError } from '../errors';
import { mergeTypeExtensions } from './type-extensions';

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

/**
 * String encoding of a scalar `@default` value (`'true'`, `'5'`, `'RED'`),
 * or `undefined` for kinds that have no scalar encoding (lists, objects,
 * null, variables).
 */
function scalarDefaultString(val: ValueNode): string | undefined {
  switch (val.kind) {
    case Kind.STRING:
    case Kind.ENUM:
    case Kind.INT:
    case Kind.FLOAT:
      return val.value;
    case Kind.BOOLEAN:
      return String(val.value);
    default:
      return undefined;
  }
}

/** Parse a field definition into either a PropertyDefinition or RelationshipDefinition */
function parseField(
  field: FieldDefinitionNode,
  enumNames: Set<string>,
  ownerName: string,
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

    // Through v2.4.7 any value was cast to 'IN' | 'OUT' unchecked. Reads
    // treat anything but 'IN' as OUT while writes treat anything but 'OUT'
    // as IN, so e.g. `direction: "out"` wrote every edge reversed and the
    // reads then could not see them. Reject at parse time instead.
    if (direction !== 'IN' && direction !== 'OUT')
      throw new OGMError(
        `Invalid @relationship direction "${direction}" on ${ownerName}.${field.name.value}: ` +
          `direction must be exactly "IN" or "OUT" (case-sensitive).`,
      );

    const rel: RelationshipDefinition = {
      fieldName: field.name.value,
      type: relType,
      direction,
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

  let defaultValue: string | string[] | undefined;
  if (defaultDirective) {
    const val = getDirectiveArgValue(defaultDirective, 'value');
    if (val && val.kind === Kind.LIST) {
      // Through v2.4.7 there was no LIST branch: a list default parsed as
      // `undefined` and creates silently wrote nothing. Elements use the
      // same string encoding as scalar defaults (converted by type at
      // write time, see resolveDefaultWriteValue).
      const where = `${ownerName}.${field.name.value}`;
      if (!isArray)
        throw new OGMError(
          `Invalid @default on ${where}: a list @default was given but the field is not a list type.`,
        );
      defaultValue = (val as ListValueNode).values.map((el) => {
        const scalar = scalarDefaultString(el);
        if (scalar === undefined)
          throw new OGMError(
            `Invalid @default on ${where}: list defaults may ` +
              `only contain String, Int, Float, Boolean or enum values.`,
          );
        return scalar;
      });
    } else if (val) {
      const scalar = scalarDefaultString(val);
      // v2.5.3 — a single value on a list field coerces to a one-element
      // list (GraphQL input coercion). Pre-2.5.3 the scalar was stored on
      // a field the generated types declare as a list.
      defaultValue = isArray && scalar !== undefined ? [scalar] : scalar;
    }
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

  if (cypherDirective) {
    const statement = getDirectiveArgStringValue(cypherDirective, 'statement');
    if (statement) prop.cypherStatement = statement;
    const columnName = getDirectiveArgStringValue(
      cypherDirective,
      'columnName',
    );
    if (columnName) prop.cypherColumnName = columnName;
  }

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

/** Parse @vector indexes from an object type definition */
function parseVectorIndexes(
  node: ObjectTypeDefinitionNode,
  properties: Map<string, PropertyDefinition>,
  typeName: string,
): VectorIndex[] {
  const vDirective = getDirective(node, 'vector');
  if (!vDirective) return [];

  const indexesArg = getDirectiveArgValue(vDirective, 'indexes');
  if (!indexesArg || indexesArg.kind !== Kind.LIST) return [];

  const results: VectorIndex[] = [];
  for (const item of (indexesArg as ListValueNode).values) {
    if (item.kind !== Kind.OBJECT) continue;
    const obj = item as ObjectValueNode;

    let indexName = '';
    let queryName = '';
    let embeddingProperty = '';
    let provider: string | undefined;

    for (const field of obj.fields) {
      if (field.name.value === 'indexName' && field.value.kind === Kind.STRING)
        indexName = (field.value as StringValueNode).value;

      if (field.name.value === 'queryName' && field.value.kind === Kind.STRING)
        queryName = (field.value as StringValueNode).value;

      if (
        field.name.value === 'embeddingProperty' &&
        field.value.kind === Kind.STRING
      )
        embeddingProperty = (field.value as StringValueNode).value;

      if (field.name.value === 'provider' && field.value.kind === Kind.STRING)
        provider = (field.value as StringValueNode).value;
    }

    if (!indexName || !queryName || !embeddingProperty) continue;

    assertSafeIdentifier(indexName, '@vector indexName');
    assertSafeIdentifier(queryName, '@vector queryName');
    assertSafeIdentifier(embeddingProperty, '@vector embeddingProperty');
    if (provider !== undefined)
      assertSafeIdentifier(provider, '@vector provider');

    if (!properties.has(embeddingProperty))
      throw new OGMError(
        `@vector index "${indexName}" references unknown embeddingProperty "${embeddingProperty}" on type "${typeName}"`,
      );

    const entry: VectorIndex = { indexName, queryName, embeddingProperty };
    if (provider !== undefined) entry.provider = provider;

    results.push(entry);
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
  // v2.13.0 — `extend type X { … }` and friends are folded into X first.
  const document: DocumentNode = mergeTypeExtensions(parse(schemaSource));

  const customScalars = new Set<string>();
  const metadata: SchemaMetadata = {
    nodes: new Map(),
    interfaces: new Map(),
    relationshipProperties: new Map(),
    enums: new Map(),
    unions: new Map(),
    customScalars,
  };

  // First pass: collect enum names and relationship properties type names
  const enumNames = new Set<string>();
  const relPropsTypeNames = new Set<string>();
  const unionMembers = new Map<string, string[]>();

  for (const def of document.definitions) {
    // v2.12.6 — record custom scalars for the type generator. Pre-2.12.6
    // they were not tracked and the generated file referenced
    // `Scalars["X"]` / a bare `X` that it never declared (TS2339 / TS2304).
    if (
      def.kind === Kind.SCALAR_TYPE_DEFINITION &&
      !SCALAR_TYPES.has(def.name.value)
    )
      customScalars.add(def.name.value);

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
        const parsed = parseField(field, enumNames, intDef.name.value);
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
        const parsed = parseField(field, enumNames, typeName);
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
      const parsed = parseField(field, enumNames, typeName);
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
    const vectorIndexes = parseVectorIndexes(objDef, properties, typeName);

    const nodeDef: NodeDefinition = {
      typeName,
      label,
      labels,
      pluralName: pluralize(typeName),
      properties,
      relationships,
      fulltextIndexes,
      vectorIndexes,
      implementsInterfaces,
    };

    metadata.nodes.set(typeName, nodeDef);
  }

  resolveDeclaredRelationships(metadata);

  return metadata;
}

/**
 * Fill in `@declareRelationship` interface relationships from the
 * implementors' `@relationship` directives. Through v2.4.7 they kept
 * `type: ''`, so every InterfaceModel operator on them (`actors_SOME`,
 * `actorsConnection`, selecting `actors { ... }`) threw
 * `Invalid identifier ""`. The InterfaceModel matches the shared interface
 * label, so one type/direction/properties must hold for every implementor;
 * if they disagree there is no single correct pattern and the schema is
 * rejected. Interfaces with no implementors are left as declared.
 */
function resolveDeclaredRelationships(metadata: SchemaMetadata): void {
  for (const iface of metadata.interfaces.values())
    for (const rel of iface.relationships.values()) {
      if (rel.type !== '') continue;
      const where = `${iface.name}.${rel.fieldName}`;
      let first: { owner: string; rel: RelationshipDefinition } | undefined;

      for (const implName of iface.implementedBy) {
        const implRel = metadata.nodes
          .get(implName)
          ?.relationships.get(rel.fieldName);
        if (!implRel)
          throw new OGMError(
            `Cannot resolve @declareRelationship ${where}: implementor ` +
              `${implName}.${rel.fieldName} has no @relationship directive.`,
          );
        if (!first) {
          first = { owner: implName, rel: implRel };
          continue;
        }
        const fields = ['type', 'direction', 'properties'] as const;
        for (const key of fields)
          if (implRel[key] !== first.rel[key])
            throw new OGMError(
              `Cannot resolve @declareRelationship ${where}: ` +
                `${first.owner}.${rel.fieldName} and ${implName}.${rel.fieldName} ` +
                `declare a different ${key} (${JSON.stringify(first.rel[key] ?? null)} vs ` +
                `${JSON.stringify(implRel[key] ?? null)}). Every implementor must use ` +
                `the same type, direction and properties.`,
            );
      }

      if (!first) continue;
      rel.type = first.rel.type;
      rel.direction = first.rel.direction;
      if (first.rel.properties !== undefined)
        rel.properties = first.rel.properties;
    }
}
