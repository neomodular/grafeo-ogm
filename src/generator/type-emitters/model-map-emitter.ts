import type { SchemaMetadata } from '../../schema/types';

/**
 * Emits a model declaration type for each node type, wrapping the generic
 * `ModelInterface` from `grafeo-ogm` with the correct type parameters.
 *
 * Example output:
 * ```typescript
 * export type BookModel = ModelInterface<
 *   Book,
 *   BookSelectFields,
 *   BookWhere,
 *   BookCreateInput,
 *   BookUpdateInput,
 *   BookConnectInput,
 *   BookDisconnectInput,
 *   BookDeleteInput,
 *   'books'
 * >;
 * ```
 */
export function emitModelDeclarations(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  const sortedNodes = [...schema.nodes.keys()].sort();

  for (const typeName of sortedNodes) {
    const node = schema.nodes.get(typeName)!;
    const hasRels = node.relationships.size > 0;
    blocks.push(buildModelType(typeName, node.pluralName, hasRels));
  }

  // Interface model declarations
  const sortedInterfaces = [...schema.interfaces.keys()].sort();
  for (const ifaceName of sortedInterfaces)
    blocks.push(buildInterfaceModelType(ifaceName));

  return blocks.join('\n\n');
}

/**
 * Emits the `ModelMap` type that maps every node name to its associated
 * generated types (node type, select fields, where, and mutation inputs).
 */
export function emitModelMap(schema: SchemaMetadata): string {
  const entries: string[] = [];

  const sortedNodes = [...schema.nodes.keys()].sort();

  for (const typeName of sortedNodes) {
    const node = schema.nodes.get(typeName)!;
    const hasRels = node.relationships.size > 0;
    entries.push(buildModelMapEntry(typeName, node.pluralName, hasRels));
  }

  // Include interfaces so ogm.model('InterfaceName') gets autocomplete
  const sortedInterfaces = [...schema.interfaces.keys()].sort();
  for (const ifaceName of sortedInterfaces)
    entries.push(buildInterfaceAsModelMapEntry(ifaceName));

  return `export type ModelMap = {\n${entries.join('\n')}\n};`;
}

/**
 * Emits the `InterfaceModelMap` type that maps every interface name to its
 * associated generated types (interface type and where input).
 */
export function emitInterfaceModelMap(schema: SchemaMetadata): string {
  const entries: string[] = [];

  const sortedInterfaces = [...schema.interfaces.keys()].sort();

  for (const ifaceName of sortedInterfaces)
    entries.push(buildInterfaceModelMapEntry(ifaceName));

  if (entries.length === 0) return 'export type InterfaceModelMap = {};';

  return `export type InterfaceModelMap = {\n${entries.join('\n')}\n};`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildModelType(
  typeName: string,
  pluralName: string,
  hasRels: boolean,
): string {
  const connectType = hasRels
    ? `${typeName}ConnectInput`
    : 'Record<string, never>';
  const disconnectType = hasRels
    ? `${typeName}DisconnectInput`
    : 'Record<string, never>';
  const deleteType = hasRels
    ? `${typeName}DeleteInput`
    : 'Record<string, never>';
  return [
    `export type ${typeName}Model = ModelInterface<`,
    `  ${typeName},`,
    `  ${typeName}SelectFields,`,
    `  ${typeName}Where,`,
    `  ${typeName}CreateInput,`,
    `  ${typeName}UpdateInput,`,
    `  ${connectType},`,
    `  ${disconnectType},`,
    `  ${deleteType},`,
    `  '${pluralName}',`,
    `  ${typeName}MutationSelectFields`,
    `>;`,
  ].join('\n');
}

function buildInterfaceModelType(ifaceName: string): string {
  return [
    `export type ${ifaceName}Model = InterfaceModelInterface<`,
    `  ${ifaceName},`,
    `  ${ifaceName}Where`,
    `>;`,
  ].join('\n');
}

function buildModelMapEntry(
  typeName: string,
  pluralName: string,
  hasRels: boolean,
): string {
  const connectType = hasRels
    ? `${typeName}ConnectInput`
    : 'Record<string, never>';
  const disconnectType = hasRels
    ? `${typeName}DisconnectInput`
    : 'Record<string, never>';
  const deleteType = hasRels
    ? `${typeName}DeleteInput`
    : 'Record<string, never>';
  return [
    `  ${typeName}: {`,
    `    Type: ${typeName};`,
    `    SelectFields: ${typeName}SelectFields;`,
    `    MutationSelectFields: ${typeName}MutationSelectFields;`,
    `    Where: ${typeName}Where;`,
    `    CreateInput: ${typeName}CreateInput;`,
    `    UpdateInput: ${typeName}UpdateInput;`,
    `    ConnectInput: ${connectType};`,
    `    DisconnectInput: ${disconnectType};`,
    `    DeleteInput: ${deleteType};`,
    `    PluralKey: '${pluralName}';`,
    `  };`,
  ].join('\n');
}

function buildInterfaceAsModelMapEntry(ifaceName: string): string {
  return [
    `  ${ifaceName}: {`,
    `    Type: ${ifaceName};`,
    `    SelectFields: ${ifaceName}SelectFields;`,
    `    Where: ${ifaceName}Where;`,
    `    CreateInput: Record<string, never>;`,
    `    UpdateInput: Record<string, never>;`,
    `    ConnectInput: Record<string, never>;`,
    `    DisconnectInput: Record<string, never>;`,
    `    DeleteInput: Record<string, never>;`,
    `    PluralKey: never;`,
    `  };`,
  ].join('\n');
}

function buildInterfaceModelMapEntry(ifaceName: string): string {
  return [
    `  ${ifaceName}: {`,
    `    Type: ${ifaceName};`,
    `    Where: ${ifaceName}Where;`,
    `  };`,
  ].join('\n');
}
