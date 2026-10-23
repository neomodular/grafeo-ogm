import {
  Kind,
  type DefinitionNode,
  type DirectiveNode,
  type DocumentNode,
  type TypeDefinitionNode,
  type TypeExtensionNode,
} from 'graphql';

import { OGMError } from '../errors';

/** Which definition kind each type-extension kind extends. */
const EXTENDS: Record<TypeExtensionNode['kind'], TypeDefinitionNode['kind']> = {
  [Kind.SCALAR_TYPE_EXTENSION]: Kind.SCALAR_TYPE_DEFINITION,
  [Kind.OBJECT_TYPE_EXTENSION]: Kind.OBJECT_TYPE_DEFINITION,
  [Kind.INTERFACE_TYPE_EXTENSION]: Kind.INTERFACE_TYPE_DEFINITION,
  [Kind.UNION_TYPE_EXTENSION]: Kind.UNION_TYPE_DEFINITION,
  [Kind.ENUM_TYPE_EXTENSION]: Kind.ENUM_TYPE_DEFINITION,
  [Kind.INPUT_OBJECT_TYPE_EXTENSION]: Kind.INPUT_OBJECT_TYPE_DEFINITION,
};

const KIND_WORD: Record<TypeDefinitionNode['kind'], string> = {
  [Kind.SCALAR_TYPE_DEFINITION]: 'scalar',
  [Kind.OBJECT_TYPE_DEFINITION]: 'object',
  [Kind.INTERFACE_TYPE_DEFINITION]: 'interface',
  [Kind.UNION_TYPE_DEFINITION]: 'union',
  [Kind.ENUM_TYPE_DEFINITION]: 'enum',
  [Kind.INPUT_OBJECT_TYPE_DEFINITION]: 'input object',
};

function isTypeExtension(def: DefinitionNode): def is TypeExtensionNode {
  return def.kind in EXTENDS;
}

function isTypeDefinition(def: DefinitionNode): def is TypeDefinitionNode {
  return def.kind in KIND_WORD;
}

type Named = { name: { value: string } };

/** Append `extra` to `base`, rejecting a name that is already present. */
function appendUnique<T extends Named>(
  base: readonly T[] | undefined,
  extra: readonly T[] | undefined,
  describe: (name: string) => string,
): readonly T[] | undefined {
  if (!extra || extra.length === 0) return base;
  const seen = new Set((base ?? []).map((n) => n.name.value));
  for (const node of extra) {
    if (seen.has(node.name.value))
      throw new OGMError(describe(node.name.value));
    seen.add(node.name.value);
  }
  return [...(base ?? []), ...extra];
}

/**
 * v2.13.0 — merge `extend type` / `extend interface` / `extend union` /
 * `extend enum` / `extend input` / `extend scalar` into the type they
 * extend, so the parser sees one definition carrying every field and
 * directive, exactly as if they had been declared inline. Through v2.12.3
 * extensions were skipped: their fields and directives vanished and
 * `create` with such a field threw "Unknown field".
 *
 * Follows graphql-js `buildASTSchema` semantics: an extension may appear
 * before or after its definition; extending an undeclared type, extending
 * with the wrong kind, or redeclaring a field, enum value, union member,
 * implemented interface or type directive is rejected, as is a type
 * defined twice in a document that uses extensions. Extensions are
 * applied in document order; the merged definition keeps the position of
 * the original one. A document without type extensions is returned
 * unchanged (the same object), so such schemas parse exactly as before.
 */
export function mergeTypeExtensions(document: DocumentNode): DocumentNode {
  if (!document.definitions.some(isTypeExtension)) return document;

  const merged = new Map<string, TypeDefinitionNode>();
  for (const def of document.definitions) {
    if (!isTypeDefinition(def)) continue;
    // Which definition would an extension target? graphql-js rejects the
    // ambiguity, and so do we (only when the schema uses extensions).
    if (merged.has(def.name.value))
      throw new OGMError(
        `There can be only one type named "${def.name.value}".`,
      );
    merged.set(def.name.value, def);
  }

  for (const ext of document.definitions) {
    if (!isTypeExtension(ext)) continue;
    const name = ext.name.value;
    const base = merged.get(name);
    if (!base)
      throw new OGMError(
        `Cannot extend type "${name}" because it is not defined.`,
      );
    const expected = EXTENDS[ext.kind];
    if (base.kind !== expected)
      throw new OGMError(
        `Cannot extend non-${KIND_WORD[expected]} type "${name}" ` +
          `(it is declared as ${KIND_WORD[base.kind]}).`,
      );
    merged.set(name, mergeOne(base, ext));
  }

  const definitions: DefinitionNode[] = [];
  for (const def of document.definitions) {
    if (isTypeExtension(def)) continue;
    definitions.push(
      isTypeDefinition(def) ? (merged.get(def.name.value) ?? def) : def,
    );
  }
  return { ...document, definitions };
}

function mergeOne(
  base: TypeDefinitionNode,
  ext: TypeExtensionNode,
): TypeDefinitionNode {
  const name = base.name.value;
  const directives = appendUnique<DirectiveNode>(
    base.directives,
    ext.directives,
    (d) =>
      `Type "${name}" already has directive @${d}; ` +
      `a type extension cannot declare it again.`,
  );
  const result = { ...base, directives } as Record<string, unknown>;

  if ('fields' in ext && ext.fields)
    result.fields = appendUnique<Named>(
      (base as { fields?: readonly Named[] }).fields,
      ext.fields,
      (f) =>
        `Field "${name}.${f}" already exists in the schema. ` +
        `It cannot also be defined in this type extension.`,
    );
  if ('interfaces' in ext && ext.interfaces)
    result.interfaces = appendUnique<Named>(
      (base as { interfaces?: readonly Named[] }).interfaces,
      ext.interfaces,
      (i) => `Type "${name}" can only implement "${i}" once.`,
    );
  if ('types' in ext && ext.types)
    result.types = appendUnique<Named>(
      (base as { types?: readonly Named[] }).types,
      ext.types,
      (t) => `Union "${name}" can only include type "${t}" once.`,
    );
  if ('values' in ext && ext.values)
    result.values = appendUnique<Named>(
      (base as { values?: readonly Named[] }).values,
      ext.values,
      (v) =>
        `Enum value "${name}.${v}" already exists in the schema. ` +
        `It cannot also be defined in this type extension.`,
    );
  return result as unknown as TypeDefinitionNode;
}
