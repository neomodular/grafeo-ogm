import type {
  SchemaMetadata,
  InterfaceDefinition,
  PropertyDefinition,
  RelationshipDefinition,
} from '../../schema/types';
import { mapScalarType, wrapMaybe, toPascalCase } from './helpers';

/**
 * Emits interface type declarations and their `*Implementation` enums.
 *
 * For each interface in the schema (sorted alphabetically):
 * 1. `export type Entity = { ... }` — only fields declared on the interface
 * 2. `export enum EntityImplementation { ... }` — if there are implementing types
 */
export function emitInterfaceTypes(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  const sortedInterfaces = [...schema.interfaces.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, iface] of sortedInterfaces)
    blocks.push(emitSingleInterface(iface, schema));

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitSingleInterface(
  iface: InterfaceDefinition,
  schema: SchemaMetadata,
): string {
  const parts: string[] = [];

  // --- Interface type ---
  parts.push(emitInterfaceType(iface, schema));

  // --- Implementation enum ---
  if (iface.implementedBy.length > 0) parts.push(emitImplementationEnum(iface));

  return parts.join('\n\n');
}

/**
 * Emits `export type <Interface> = { ... }` with only the fields declared
 * directly on the interface (no `__typename`).
 */
function emitInterfaceType(
  iface: InterfaceDefinition,
  schema: SchemaMetadata,
): string {
  const members: string[] = [];

  // --- Scalar properties ---
  for (const [, prop] of iface.properties) {
    if (prop.isCypher) continue;

    members.push(emitPropertyField(prop, schema));
  }

  // --- Relationship fields ---
  for (const [, rel] of iface.relationships) {
    members.push(emitRelationshipField(rel));
    members.push(emitConnectionField(iface.name, rel));
  }

  return `export type ${iface.name} = {\n${members.join('\n')}\n};`;
}

/**
 * Emits `export enum <Interface>Implementation { ... }`.
 *
 * Members are sorted alphabetically, each with `Name = "Name"`.
 */
function emitImplementationEnum(iface: InterfaceDefinition): string {
  const sorted = [...iface.implementedBy].sort();
  const members = sorted.map((name) => `  ${name} = "${name}",`).join('\n');

  return `export enum ${iface.name}Implementation {\n${members}\n}`;
}

/**
 * Emits a single scalar property line for an interface field.
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
 * Emits the relationship field line for an interface.
 */
function emitRelationshipField(rel: RelationshipDefinition): string {
  if (rel.isArray) return `  ${rel.fieldName}: Array<${rel.target}>;`;

  const optional = rel.isRequired ? '' : '?';
  const type = wrapMaybe(rel.target, rel.isRequired);

  return `  ${rel.fieldName}${optional}: ${type};`;
}

/**
 * Emits the connection field for a relationship on an interface.
 */
function emitConnectionField(
  interfaceName: string,
  rel: RelationshipDefinition,
): string {
  const pascalField = toPascalCase(rel.fieldName);
  const connectionType = `${interfaceName}${pascalField}Connection`;

  return `  ${rel.fieldName}Connection: ${connectionType};`;
}
