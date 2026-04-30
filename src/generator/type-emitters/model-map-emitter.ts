import type { SchemaMetadata } from '../../schema/types';
import { nodeHasAnyFulltext } from './fulltext-emitter';

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
 *   'books',
 *   BookMutationSelectFields,
 *   BookSort
 * >;
 * ```
 *
 * When the node has at least one fulltext index (directly or via a
 * relationship-properties type), the fulltext-accepting methods (`find`,
 * `findFirst`, `findFirstOrThrow`, `count`, `aggregate`) are re-declared with
 * a narrowed `fulltext?: <Node>FulltextInput` so users get autocomplete and
 * typo-checking on index names.
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
    `  ${typeName}Sort`,
    `>`,
  ].join('\n');

  if (!hasFulltext) return `export type ${typeName}Model = ${baseAlias};`;

  return buildModelTypeWithTypedFulltext(typeName, baseAlias);
}

/**
 * Builds a `<Node>Model` alias that keeps every method from `ModelInterface`
 * but replaces the `fulltext` parameter with the node-specific
 * `<Node>FulltextInput`, giving users autocomplete + typo-checking on
 * index names.
 *
 * Uses `Omit<..., 'find' | ...>` to strip the loose variants from the base,
 * then intersects with the refined signatures.
 */
function buildModelTypeWithTypedFulltext(
  typeName: string,
  baseAlias: string,
): string {
  const fulltextInput = `${typeName}FulltextInput`;
  const where = `${typeName}Where`;
  const select = `${typeName}SelectFields`;

  // We only re-declare what we need to change. The shared parameter shapes
  // are inlined to stay decoupled from the non-exported runtime
  // `FindOptions`; `ExecutionContext` is imported from the package.
  const sort = `${typeName}Sort`;

  const findParams = `{
    where?: ${where};
    selectionSet?: string | DocumentNode;
    select?: ${select};
    labels?: string[];
    options?: { limit?: number; offset?: number; sort?: Array<${sort}> };
    fulltext?: ${fulltextInput};
    context?: ExecutionContext;
  }`;

  const findFirstParams = `{
    where?: ${where};
    selectionSet?: string | DocumentNode;
    select?: ${select};
    labels?: string[];
    options?: { offset?: number; sort?: Array<${sort}> };
    fulltext?: ${fulltextInput};
    context?: ExecutionContext;
  }`;

  const countParams = `{
    where?: ${where};
    labels?: string[];
    fulltext?: ${fulltextInput};
    context?: ExecutionContext;
  }`;

  const aggregateParams = `{
    where?: ${where};
    aggregate: { count?: boolean; [field: string]: boolean | undefined };
    labels?: string[];
    fulltext?: ${fulltextInput};
    context?: ExecutionContext;
  }`;

  return [
    `export type ${typeName}Model = Omit<`,
    `  ${baseAlias.split('\n').join('\n  ')},`,
    `  'find' | 'findFirst' | 'findFirstOrThrow' | 'count' | 'aggregate'`,
    `> & {`,
    `  find(params?: ${findParams}): Promise<${typeName}[]>;`,
    `  findFirst(params?: ${findFirstParams}): Promise<${typeName} | null>;`,
    `  findFirstOrThrow(params?: ${findFirstParams}): Promise<${typeName}>;`,
    `  count(params?: ${countParams}): Promise<number>;`,
    `  aggregate(params: ${aggregateParams}): Promise<{ count?: number; [field: string]: unknown }>;`,
    `};`,
  ].join('\n');
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
