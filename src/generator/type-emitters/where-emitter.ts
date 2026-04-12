import type {
  SchemaMetadata,
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
} from '../../schema/types';
import { isBuiltInScalar, toPascalCase } from './helpers';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WhereEmitterConfig {
  /** When `false`, omits `_MATCHES` for String fields. Defaults to `true`. */
  stringMatchesFilter?: boolean;
}

/**
 * Emits `{TypeName}Where` types for every node and interface in the schema.
 *
 * Each Where type contains:
 * 1. Scalar operator fields (per scalar property)
 * 2. Relationship operator fields (per relationship)
 * 3. Logical operators (OR, AND, NOT)
 */
export function emitWhereTypes(
  schema: SchemaMetadata,
  config?: WhereEmitterConfig,
): string {
  const blocks: string[] = [];
  const enableMatches = config?.stringMatchesFilter !== false;

  // Node Where types (sorted alphabetically)
  const sortedNodes = [...schema.nodes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, node] of sortedNodes)
    blocks.push(
      emitWhereType(
        node.typeName,
        node.properties,
        node.relationships,
        schema,
        enableMatches,
        node,
      ),
    );

  // Interface Where types (sorted alphabetically)
  const sortedInterfaces = [...schema.interfaces.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, iface] of sortedInterfaces)
    blocks.push(
      emitWhereType(
        iface.name,
        iface.properties,
        iface.relationships,
        schema,
        enableMatches,
      ),
    );

  // Relationship-property Where types (sorted alphabetically)
  const sortedRelProps = [...schema.relationshipProperties.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  );

  for (const [, relProp] of sortedRelProps)
    blocks.push(
      emitWhereType(
        relProp.typeName,
        relProp.properties,
        new Map(),
        schema,
        enableMatches,
      ),
    );

  // Union Where types (per-member keyed)
  const sortedUnions = [...(schema.unions?.entries() ?? [])].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [name, members] of sortedUnions)
    blocks.push(emitUnionWhereType(name, members));

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Core emitter
// ---------------------------------------------------------------------------

function emitWhereType(
  typeName: string,
  properties: Map<string, PropertyDefinition>,
  relationships: Map<string, RelationshipDefinition>,
  schema: SchemaMetadata,
  enableMatches: boolean,
  nodeDef?: NodeDefinition,
): string {
  const lines: string[] = [];

  // 1. Scalar operator fields (including @cypher fields with scalar return types)
  for (const [, prop] of properties) {
    // Skip @cypher fields that return node/interface types (not scalars)
    if (
      prop.isCypher &&
      !isBuiltInScalar(prop.type) &&
      !schema.enums.has(prop.type)
    )
      continue;
    lines.push(...emitScalarOperators(prop, schema, enableMatches));
  }

  // 2. Logical operators (before relationships, matching reference output)
  lines.push(`  OR?: InputMaybe<Array<${typeName}Where>>;`);
  lines.push(`  AND?: InputMaybe<Array<${typeName}Where>>;`);
  lines.push(`  NOT?: InputMaybe<${typeName}Where>;`);

  // 3. Relationship operator fields
  for (const [, rel] of relationships)
    lines.push(...emitRelationshipOperators(typeName, rel, schema, nodeDef));

  return `export type ${typeName}Where = {\n${lines.join('\n')}\n};`;
}

// ---------------------------------------------------------------------------
// Scalar operator generation
// ---------------------------------------------------------------------------

type ScalarCategory =
  | 'string-like'
  | 'numeric-like'
  | 'boolean'
  | 'enum'
  | 'spatial';

/** Temporal types that support comparison operators (LT, LTE, GT, GTE) */
const TEMPORAL_TYPES = new Set([
  'DateTime',
  'Date',
  'Time',
  'LocalTime',
  'LocalDateTime',
  'Duration',
]);

/** Spatial types that only support equality and IN operators */
const SPATIAL_TYPES = new Set(['Point', 'CartesianPoint']);

function classifyType(
  typeName: string,
  enums: Map<string, string[]>,
): ScalarCategory {
  if (typeName === 'Boolean') return 'boolean';
  if (typeName === 'ID' || typeName === 'String') return 'string-like';
  if (typeName === 'Int' || typeName === 'Float' || typeName === 'BigInt')
    return 'numeric-like';
  if (TEMPORAL_TYPES.has(typeName)) return 'numeric-like';
  if (SPATIAL_TYPES.has(typeName)) return 'spatial';

  if (enums.has(typeName)) return 'enum';
  // Default to string-like for unknown scalars
  return 'string-like';
}

function scalarInputType(
  typeName: string,
  enums: Map<string, string[]>,
): string {
  if (isBuiltInScalar(typeName)) return `Scalars["${typeName}"]["input"]`;
  if (enums.has(typeName)) return typeName;
  return `Scalars["${typeName}"]["input"]`;
}

function emitScalarOperators(
  prop: PropertyDefinition,
  schema: SchemaMetadata,
  enableMatches: boolean,
): string[] {
  const lines: string[] = [];
  const { name, type, required } = prop;
  const category = classifyType(type, schema.enums);
  const inputType = scalarInputType(type, schema.enums);
  const wrap = (inner: string): string => `InputMaybe<${inner}>`;

  // Exact match
  lines.push(`  ${name}?: ${wrap(inputType)};`);

  // _NOT
  lines.push(`  ${name}_NOT?: ${wrap(inputType)};`);

  if (category === 'boolean')
    // Boolean only has exact + _NOT
    return lines;

  // _IN / _NOT_IN (all non-boolean types)
  const arrayInner = required ? inputType : `InputMaybe<${inputType}>`;
  lines.push(`  ${name}_IN?: ${wrap(`Array<${arrayInner}>`)};`);
  lines.push(`  ${name}_NOT_IN?: ${wrap(`Array<${arrayInner}>`)};`);

  // Category-specific operators
  switch (category) {
    case 'string-like':
      lines.push(`  ${name}_CONTAINS?: ${wrap(inputType)};`);
      lines.push(`  ${name}_STARTS_WITH?: ${wrap(inputType)};`);
      lines.push(`  ${name}_ENDS_WITH?: ${wrap(inputType)};`);
      // _MATCHES only for String (not ID), and only if enabled
      if (type === 'String' && enableMatches)
        lines.push(`  ${name}_MATCHES?: ${wrap(inputType)};`);

      lines.push(`  ${name}_NOT_CONTAINS?: ${wrap(inputType)};`);
      lines.push(`  ${name}_NOT_STARTS_WITH?: ${wrap(inputType)};`);
      lines.push(`  ${name}_NOT_ENDS_WITH?: ${wrap(inputType)};`);
      break;

    case 'numeric-like':
      lines.push(`  ${name}_LT?: ${wrap(inputType)};`);
      lines.push(`  ${name}_LTE?: ${wrap(inputType)};`);
      lines.push(`  ${name}_GT?: ${wrap(inputType)};`);
      lines.push(`  ${name}_GTE?: ${wrap(inputType)};`);
      break;

    case 'enum':
      // Enum has exact, _NOT, _IN, _NOT_IN — already emitted above
      break;

    case 'spatial':
      // Spatial types only support exact, _NOT, _IN, _NOT_IN — already emitted above
      break;
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Relationship operator generation
// ---------------------------------------------------------------------------

function emitRelationshipOperators(
  parentType: string,
  rel: RelationshipDefinition,
  schema?: SchemaMetadata,
  nodeDef?: NodeDefinition,
): string[] {
  const lines: string[] = [];
  const { fieldName, target, isArray } = rel;
  const pascalField = toPascalCase(fieldName);

  // For relationships inherited from an interface (@declareRelationship),
  // use the interface-level ConnectionWhere type name
  let connectionWhereName = `${parentType}${pascalField}ConnectionWhere`;
  if (schema && nodeDef)
    for (const ifaceName of nodeDef.implementsInterfaces) {
      const iface = schema.interfaces.get(ifaceName);
      if (iface?.relationships.has(fieldName)) {
        connectionWhereName = `${ifaceName}${pascalField}ConnectionWhere`;
        break;
      }
    }

  // Aggregate filter operator
  const aggInputName = `${parentType}${pascalField}AggregateInput`;
  lines.push(`  ${fieldName}Aggregate?: InputMaybe<${aggInputName}>;`);

  if (isArray) {
    // Array relationship: full set of operators
    lines.push(`  ${fieldName}?: InputMaybe<${target}Where>;`);
    lines.push(`  ${fieldName}_NOT?: InputMaybe<${target}Where>;`);
    lines.push(
      `  ${fieldName}Connection?: InputMaybe<${connectionWhereName}>;`,
    );
    lines.push(
      `  ${fieldName}Connection_NOT?: InputMaybe<${connectionWhereName}>;`,
    );
    lines.push(`  ${fieldName}_ALL?: InputMaybe<${target}Where>;`);
    lines.push(`  ${fieldName}_NONE?: InputMaybe<${target}Where>;`);
    lines.push(`  ${fieldName}_SINGLE?: InputMaybe<${target}Where>;`);
    lines.push(`  ${fieldName}_SOME?: InputMaybe<${target}Where>;`);
    lines.push(
      `  ${fieldName}Connection_ALL?: InputMaybe<${connectionWhereName}>;`,
    );
    lines.push(
      `  ${fieldName}Connection_NONE?: InputMaybe<${connectionWhereName}>;`,
    );
    lines.push(
      `  ${fieldName}Connection_SINGLE?: InputMaybe<${connectionWhereName}>;`,
    );
    lines.push(
      `  ${fieldName}Connection_SOME?: InputMaybe<${connectionWhereName}>;`,
    );
  } else {
    // Singular relationship: limited operators
    lines.push(`  ${fieldName}?: InputMaybe<${target}Where>;`);
    lines.push(`  ${fieldName}_NOT?: InputMaybe<${target}Where>;`);
    lines.push(
      `  ${fieldName}Connection?: InputMaybe<${connectionWhereName}>;`,
    );
    lines.push(
      `  ${fieldName}Connection_NOT?: InputMaybe<${connectionWhereName}>;`,
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Union Where types (per-member keyed)
// ---------------------------------------------------------------------------

function emitUnionWhereType(name: string, members: string[]): string {
  const sorted = [...members].sort();
  const lines = sorted.map((m) => `  ${m}?: InputMaybe<${m}Where>;`);
  return `export type ${name}Where = {\n${lines.join('\n')}\n};`;
}
