import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseSchema } from '../schema/parser';
import type { SchemaMetadata } from '../schema/types';
import {
  emitHeader,
  emitImports,
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
  code: 'UNKNOWN_DIRECTIVE' | 'UNSUPPORTED_TYPE' | 'CIRCULAR_REFERENCE';
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
  const sections: string[] = [
    emitHeader(config, packageName),
    emitImports(packageName),
    emitUtilityTypes(),
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
    emitSelectFieldTypes(metadata),
    emitSelectResultType(),
    emitModelDeclarations(metadata),
    emitModelMap(metadata),
    emitInterfaceModelMap(metadata),
  ];

  // 6. Join sections -------------------------------------------------------
  let output = sections.join('\n\n');

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
    } catch {
      warnings.push({
        code: 'UNSUPPORTED_TYPE',
        message:
          'Prettier formatting failed; output written without formatting.',
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
