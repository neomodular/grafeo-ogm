// Main classes
export { OGM, OGMWithContext } from './ogm';
export type { OGMConfig } from './ogm';
/** @deprecated Use OGM instead */
export { OGM as SafedoseOGM } from './ogm';
export { Model, isFulltextLeaf, isFulltextIndexEntry } from './model';
export type {
  ModelInterface,
  MutationResponse,
  MutationInfo,
  FulltextIndexEntry,
  FulltextRelationshipEntry,
  FulltextLeaf,
  FulltextInput,
  UnsafeOptions,
} from './model';
export { InterfaceModel } from './interface-model';
export type { InterfaceModelInterface } from './interface-model';

// Errors
export {
  OGMError,
  RecordNotFoundError,
  SubgraphOperationError,
} from './errors';
export { PolicyDeniedError } from './policy/errors';

// Policies (Node-Level Security)
export {
  override,
  permissive,
  restrictive,
  isReadRestrictive,
  isWriteRestrictive,
} from './policy/types';
export type {
  Policy,
  OverridePolicy,
  PermissivePolicy,
  RestrictivePolicy,
  ReadRestrictivePolicy,
  WriteRestrictivePolicy,
  PolicyContext,
  PolicyContextBundle,
  Operation,
  OperationOrWildcard,
  ReadOperation,
  WriteOperation,
  PoliciesByModel,
  PolicyDefaults,
  ResolvedPolicies,
} from './policy/types';

// Schema types
export type {
  SchemaMetadata,
  NodeDefinition,
  InterfaceDefinition,
  RelationshipDefinition,
  RelationshipPropertiesDefinition,
  PropertyDefinition,
  FulltextIndex,
  VectorIndex,
  Neo4jValue,
  WhereInput,
  MutationInput,
} from './schema/types';

// Schema parser
export { parseSchema, pluralize } from './schema/parser';

// Schema utils
export { clearResolveTargetDefCache } from './schema/utils';

// Compilers (for advanced use / testing)
export { WhereCompiler } from './compilers/where.compiler';
export type {
  WhereResult,
  WhereCompilerOptions,
} from './compilers/where.compiler';
export { SelectionCompiler } from './compilers/selection.compiler';
export type { SelectionNode } from './compilers/selection.compiler';
export { SelectNormalizer } from './compilers/select-normalizer';
export { MutationCompiler } from './compilers/mutation.compiler';
export type { MutationResult } from './compilers/mutation.compiler';
export { FulltextCompiler } from './compilers/fulltext.compiler';
export { VectorCompiler } from './compilers/vector.compiler';
export type { VectorResult } from './compilers/vector.compiler';

// Execution
export { Executor } from './execution/executor';
export type { ExecutionContext, OGMLogger } from './execution/executor';
export { ResultMapper } from './execution/result-mapper';

// Type generator
export { generateTypes } from './generator';
export type {
  GenerateTypesOptions,
  GenerateTypesConfig,
  GenerateTypesResult,
  GeneratorWarning,
} from './generator';

// Subgraph operations
export { cloneSubgraph, deleteSubgraph } from './subgraph';
export type {
  SubgraphCloneResult,
  SubgraphConfig,
  SubgraphDeleteResult,
  SubgraphReferenceRelationship,
} from './subgraph';

// Utils
export { sanitizeLuceneQuery } from './utils/lucene';
export {
  assertSafeIdentifier,
  assertSafeLabel,
  assertSortDirection,
  escapeIdentifier,
} from './utils/validation';

// Testing utilities — re-exported from the main entry so consumers
// on legacy module resolvers (TypeScript `moduleResolution: "node"`,
// older Jest configs without `subpath imports` support) can do
// `import { CypherAssert } from 'grafeo-ogm'` without needing a
// `.d.ts` shim or a `moduleNameMapper` workaround. The dedicated
// `grafeo-ogm/testing` subpath export is preserved for callers on
// modern resolvers who prefer the namespaced import.
export {
  CypherAssert,
  Neo4jRecordFactory,
  SelectionSetFactory,
} from './testing';

// CLI configuration — `defineConfig` gives grafeo.config.ts files full type
// inference. The CLI itself (bin "grafeo") lives in dist/cjs/cli and is NOT
// re-exported here, so library consumers never load CLI code or jiti.
export { defineConfig } from './cli/types';
export type {
  GrafeoConfig,
  GrafeoDatabaseConfig,
  GrafeoVectorIndexConfig,
} from './cli/types';
