import type { SchemaMetadata } from '../../schema/types';

/**
 * Emits mutation response types for every node in the schema:
 * - `CreateInfo` and `UpdateInfo` (emitted once)
 * - `Create{PluralName}MutationResponse` per node
 * - `Update{PluralName}MutationResponse` per node
 */
export function emitMutationResponseTypes(schema: SchemaMetadata): string {
  const blocks: string[] = [];

  // Static info types — emitted once
  blocks.push(emitCreateInfo());
  blocks.push(emitUpdateInfo());
  blocks.push(emitMutationInfoSelectFields());

  // Per-node mutation responses (sorted alphabetically)
  const sortedNodes = [...schema.nodes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [, node] of sortedNodes) {
    const pascalPlural = toPascalPlural(node.pluralName);

    blocks.push(
      `export type Create${pascalPlural}MutationResponse = {\n` +
        `  info: CreateInfo;\n` +
        `  ${node.pluralName}: Array<${node.typeName}>;\n` +
        `};`,
    );

    blocks.push(
      `export type Update${pascalPlural}MutationResponse = {\n` +
        `  info: UpdateInfo;\n` +
        `  ${node.pluralName}: Array<${node.typeName}>;\n` +
        `};`,
    );

    // Per-node mutation select fields
    blocks.push(
      `export type ${node.typeName}MutationSelectFields = {\n` +
        `  info?: MutationInfoSelectFields;\n` +
        `  ${node.pluralName}?: ${node.typeName}SelectFields;\n` +
        `};`,
    );
  }

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitMutationInfoSelectFields(): string {
  return `export type MutationInfoSelectFields = {
  nodesCreated?: boolean;
  nodesDeleted?: boolean;
  relationshipsCreated?: boolean;
  relationshipsDeleted?: boolean;
};`;
}

function emitCreateInfo(): string {
  return `export type CreateInfo = {
  nodesCreated: Scalars["Int"]["output"];
  nodesDeleted?: Scalars["Int"]["output"];
  relationshipsCreated: Scalars["Int"]["output"];
  relationshipsDeleted?: Scalars["Int"]["output"];
};`;
}

function emitUpdateInfo(): string {
  return `export type UpdateInfo = {
  nodesCreated: Scalars["Int"]["output"];
  nodesDeleted?: Scalars["Int"]["output"];
  relationshipsCreated: Scalars["Int"]["output"];
  relationshipsDeleted?: Scalars["Int"]["output"];
};`;
}

/**
 * Converts a plural name (e.g. `charts`) to PascalCase (`Charts`).
 */
function toPascalPlural(pluralName: string): string {
  return pluralName.charAt(0).toUpperCase() + pluralName.slice(1);
}
