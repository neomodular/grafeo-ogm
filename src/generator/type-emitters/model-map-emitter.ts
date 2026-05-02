import type { SchemaMetadata } from '../../schema/types';
import { nodeHasAnyFulltext } from './fulltext-emitter';

/**
 * Emits a model declaration type for each node type, wrapping the generic
 * `ModelInterface` from `grafeo-ogm` with the correct type parameters.
 *
 * When the node has at least one fulltext index (directly or via a
 * relationship-properties type), `<Node>FulltextInput` is passed as the
 * 12th generic (`TFulltext`) on `ModelInterface`. That threads typed
 * fulltext inputs into every method that accepts `fulltext` — `find`,
 * `findFirst`, `findFirstOrThrow`, `count`, `aggregate` — without
 * per-method redeclaration. Logical operators (`OR`/`AND`/`NOT`) recurse
 * over the same per-node input, so typos in index names surface as
 * compile errors at any nesting level.
 *
 * Example output (with fulltext):
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
 *   'books',
 *   BookMutationSelectFields,
 *   BookSort,
 *   BookFulltextInput
 * >;
 * ```
 */
export function emitModelDeclarations(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  const sortedNodes = [...schema.nodes.keys()].sort();

  for (const typeName of sortedNodes) {
    const node = schema.nodes.get(typeName)!;
    const hasRels = node.relationships.size > 0;
    const hasFulltext = nodeHasAnyFulltext(node, schema);
    blocks.push(
      buildModelType(typeName, node.pluralName, hasRels, hasFulltext),
    );
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
  hasFulltext: boolean,
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

  const fulltextGeneric = hasFulltext ? `,\n  ${typeName}FulltextInput` : '';

  const baseAlias = [
    `ModelInterface<`,
    `  ${typeName},`,
    `  ${typeName}SelectFields,`,
    `  ${typeName}Where,`,
    `  ${typeName}CreateInput,`,
    `  ${typeName}UpdateInput,`,
    `  ${connectType},`,
    `  ${disconnectType},`,
    `  ${deleteType},`,
    `  '${pluralName}',`,
    `  ${typeName}MutationSelectFields,`,
    `  ${typeName}Sort${fulltextGeneric}`,
    `>`,
  ].join('\n');

  return `export type ${typeName}Model = ${baseAlias};`;
}

function buildInterfaceModelType(ifaceName: string): string {
  return [
    `export type ${ifaceName}Model = InterfaceModelInterface<`,
    `  ${ifaceName},`,
    `  ${ifaceName}Where,`,
    `  ${ifaceName}Sort`,
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
    `    Sort: ${typeName}Sort;`,
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
    `    Sort: ${ifaceName}Sort;`,
    `  };`,
  ].join('\n');
}

function buildInterfaceModelMapEntry(ifaceName: string): string {
  return [
    `  ${ifaceName}: {`,
    `    Type: ${ifaceName};`,
    `    Where: ${ifaceName}Where;`,
    `    Sort: ${ifaceName}Sort;`,
    `  };`,
  ].join('\n');
}
