import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseSchema } from '../schema/parser';
import type { SchemaMetadata } from '../schema/types';
import { toPascalCase } from './type-emitters/helpers';
import {
  emitHeader,
  emitImports,
  importRefs,
  emitUtilityTypes,
} from './type-emitters/utility-types';
import { emitEnums } from './type-emitters/enum-emitter';
import { emitNodeTypes } from './type-emitters/node-type-emitter';
import { emitInterfaceTypes } from './type-emitters/interface-emitter';
import { emitWhereTypes } from './type-emitters/where-emitter';
import {
  emitConnectionWhereTypes,
  emitConnectionEdgeTypes,
} from './type-emitters/connection-emitter';
import { emitInputTypes } from './type-emitters/input-emitter';
import { emitSortOptions } from './type-emitters/sort-options-emitter';
import { emitAggregationTypes } from './type-emitters/aggregation-emitter';
import { emitMutationResponseTypes } from './type-emitters/mutation-response-emitter';
import { emitFulltextTypes } from './type-emitters/fulltext-emitter';
import { emitVectorTypes } from './type-emitters/vector-emitter';
import { emitSelectFieldTypes } from './type-emitters/select-fields-emitter';
import { emitSelectResultType } from './type-emitters/select-result-emitter';
import {
  emitModelDeclarations,
  emitModelMap,
  emitInterfaceModelMap,
} from './type-emitters/model-map-emitter';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GenerateTypesOptions {
  /** Raw schema.graphql content */
  typeDefs: string;
  /** Output file path */
  outFile: string;
  /** Optional configuration */
  config?: GenerateTypesConfig;
}

export interface GenerateTypesConfig {
  /** Enable MATCHES operator for string fields (default: true) */
  stringMatchesFilter?: boolean;
  /** Format output with prettier (default: true) */
  formatOutput?: boolean;
  /** Custom prettier configuration */
  prettierConfig?: Record<string, unknown>;
  /** Custom header comment prepended to the generated file */
  header?: string;
  /** Package name used in generated import statements (default: 'grafeo-ogm') */
  packageName?: string;
}

export interface GenerateTypesResult {
  /** Absolute path of the written file */
  outputPath: string;
  /** Number of exported types / interfaces / enums */
  typeCount: number;
  /** File size in bytes */
  fileSize: number;
  /** Generation duration in milliseconds */
  durationMs: number;
  /** Non-fatal warnings encountered during generation */
  warnings: GeneratorWarning[];
}

export interface GeneratorWarning {
  code:
    | 'UNKNOWN_DIRECTIVE'
    | 'UNSUPPORTED_TYPE'
    | 'CIRCULAR_REFERENCE'
    | 'FORMATTING_SKIPPED';
  message: string;
  location?: { typeName: string; fieldName?: string };
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class SchemaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaParseError';
  }
}

export class OutputPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputPathError';
  }
}

export class EmptySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptySchemaError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countExportedTypes(source: string): number {
  const patterns = [/export type /g, /export interface /g, /export enum /g];
  let count = 0;
  for (const pattern of patterns) {
    const matches = source.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

const IMPORT_PATTERN = /^import (?:type )?\{([^}]*)\}/gm;

const DECLARATION_PATTERN =
  /^export (?:declare )?(?:type|interface|enum|const enum|class|const|function) ([A-Za-z_$][\w$]*)/gm;

/**
 * Reject output that declares the same identifier twice. Generated names
 * concatenate owner and field (`<Owner><PascalField>ConnectionWhere`, ...),
 * a scheme inherited from @neo4j/graphql that must not change, so e.g.
 * `User.postComments` and `UserPost.comments` both produce
 * `UserPostCommentsConnectionWhere`. Through v2.4.7 such schemas generated
 * a file with duplicate declarations (TS2300) that did not compile; now
 * generation fails with the clashing names and the schema elements that
 * produce them.
 */
function assertUniqueTypeNames(output: string, schema: SchemaMetadata): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  // v2.5.3 — imported names are local declarations too; pre-2.5.3 a clash
  // with one (TS2440) went unreported.
  for (const match of output.matchAll(IMPORT_PATTERN))
    for (const spec of match[1].split(','))
      seen.add(
        spec
          .trim()
          .split(/\s+as\s+/)
          .pop()!,
      );
  for (const match of output.matchAll(DECLARATION_PATTERN)) {
    const name = match[1];
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  if (duplicates.size === 0) return;

  const MAX_LISTED = 5;
  const lines = [...duplicates]
    .slice(0, MAX_LISTED)
    .map(
      (name) =>
        `  - "${name}" is produced by: ${describeNameSources(name, schema).join(', ')}`,
    );
  if (duplicates.size > MAX_LISTED)
    lines.push(`  ... and ${duplicates.size - MAX_LISTED} more`);

  throw new SchemaParseError(
    `Generated type names collide (${duplicates.size} duplicate declaration` +
      `${duplicates.size === 1 ? '' : 's'}); the generated file would not compile:\n` +
      `${lines.join('\n')}\n` +
      'Rename one of the clashing types or relationship fields.',
  );
}

/**
 * Best-effort attribution of a generated identifier to schema elements:
 * relationship fields whose `<Owner><PascalField>` (or aggregation
 * `<Owner><Target><PascalField>`) prefix it carries, plus types with that
 * exact name. Falls back to types whose name prefixes it.
 */
function describeNameSources(name: string, schema: SchemaMetadata): string[] {
  const sources: string[] = [];
  const owners = [
    ...[...schema.nodes.values()].map((n) => ({
      name: n.typeName,
      rels: n.relationships,
    })),
    ...[...schema.interfaces.values()].map((i) => ({
      name: i.name,
      rels: i.relationships,
    })),
  ];
  for (const owner of owners)
    for (const rel of owner.rels.values()) {
      const pascal = toPascalCase(rel.fieldName);
      if (
        name.startsWith(`${owner.name}${pascal}`) ||
        name.startsWith(`${owner.name}${rel.target}${pascal}`)
      )
        sources.push(`${owner.name}.${rel.fieldName}`);
    }

  const typeNames = [
    ...schema.nodes.keys(),
    ...schema.interfaces.keys(),
    ...schema.relationshipProperties.keys(),
    ...schema.enums.keys(),
    ...(schema.unions?.keys() ?? []),
  ];
  for (const t of typeNames) if (t === name) sources.push(`type ${t}`);

  if (sources.length < 2)
    for (const t of typeNames.sort((a, b) => b.length - a.length))
      if (t !== name && name.startsWith(t)) sources.push(`type ${t}`);

  return sources.length > 0 ? [...new Set(sources)] : ['(unknown)'];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parse a GraphQL schema, emit TypeScript type declarations, and write the
 * result to disk.
 */
export async function generateTypes(
  options: GenerateTypesOptions,
): Promise<GenerateTypesResult> {
  const start = performance.now();
  const warnings: GeneratorWarning[] = [];

  // 1. Parse schema --------------------------------------------------------
  let metadata: SchemaMetadata;
  try {
    metadata = parseSchema(options.typeDefs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SchemaParseError(`Failed to parse schema: ${message}`);
  }

  // 2. Validate output directory -------------------------------------------
  const outDir = path.dirname(path.resolve(options.outFile));
  if (!fs.existsSync(outDir))
    throw new OutputPathError(`Output directory does not exist: ${outDir}`);

  // 3. Validate non-empty schema -------------------------------------------
  if (metadata.nodes.size === 0)
    throw new EmptySchemaError(
      'Schema contains no node types. At least one type is required.',
    );

  // 4. Build resolved config -----------------------------------------------
  const config: Required<
    Pick<GenerateTypesConfig, 'stringMatchesFilter' | 'formatOutput'>
  > &
    GenerateTypesConfig = {
    stringMatchesFilter: options.config?.stringMatchesFilter ?? true,
    formatOutput: options.config?.formatOutput ?? true,
    prettierConfig: options.config?.prettierConfig,
    header: options.config?.header,
  };

  // 5. Emit sections in order ----------------------------------------------
  const packageName = options.config?.packageName ?? 'grafeo-ogm';
  // v2.5.3 — alias an import the schema also declares (see `importRefs`).
  const refs = importRefs(
    new Set([
      ...metadata.nodes.keys(),
      ...metadata.interfaces.keys(),
      ...metadata.unions.keys(),
      ...metadata.enums.keys(),
      ...metadata.relationshipProperties.keys(),
    ]),
  );
  const sections: string[] = [
    emitHeader(config, packageName),
    emitImports(packageName, refs),
    emitUtilityTypes(metadata.customScalars),
    emitEnums(metadata),
    emitNodeTypes(metadata),
    emitInterfaceTypes(metadata),
    emitWhereTypes(metadata, config),
    emitConnectionWhereTypes(metadata),
    emitInputTypes(metadata),
    emitSortOptions(metadata),
    emitConnectionEdgeTypes(metadata),
    emitAggregationTypes(metadata),
    emitMutationResponseTypes(metadata),
    emitFulltextTypes(metadata),
    emitVectorTypes(metadata),
    emitSelectFieldTypes(metadata),
    emitSelectResultType(),
    emitModelDeclarations(metadata, refs),
    emitModelMap(metadata),
    emitInterfaceModelMap(metadata),
  ];

  // 6. Join sections -------------------------------------------------------
  let output = sections.join('\n\n');
  assertUniqueTypeNames(output, metadata);

  // 7. Count types ---------------------------------------------------------
  const typeCount = countExportedTypes(output);

  // 8. Format with prettier (optional) -------------------------------------
  if (config.formatOutput)
    try {
      const prettier = await import('prettier');
      output = await prettier.format(output, {
        parser: 'typescript',
        ...config.prettierConfig,
      });
    } catch (error) {
      // The common case is "prettier isn't installed" (it's an OPTIONAL peer,
      // not bundled, to keep the runtime footprint minimal) — surface an
      // actionable message rather than a bare failure. A genuine formatting
      // error reports its detail instead.
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string } | null)?.code;
      const notInstalled =
        code === 'MODULE_NOT_FOUND' ||
        code === 'ERR_MODULE_NOT_FOUND' ||
        /cannot find (module|package) ['"]?prettier/i.test(message);
      warnings.push({
        code: 'FORMATTING_SKIPPED',
        message: notInstalled
          ? 'prettier is not installed — generated types were written ' +
            'unformatted. Run `npm i -D prettier` for formatted output, or set ' +
            '`generate.formatOutput: false` to silence this warning.'
          : `prettier formatting failed (${message}) — output written unformatted.`,
      });
    }

  // 9. Write to disk -------------------------------------------------------
  const resolvedPath = path.resolve(options.outFile);
  fs.writeFileSync(resolvedPath, output, 'utf-8');

  // 10. Return result ------------------------------------------------------
  const durationMs = Math.round(performance.now() - start);
  const fileSize = Buffer.byteLength(output, 'utf-8');

  return {
    outputPath: resolvedPath,
    typeCount,
    fileSize,
    durationMs,
    warnings,
  };
}
