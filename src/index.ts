// Main classes
export { OGM } from './ogm';
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
} from './model';
export { InterfaceModel } from './interface-model';
export type { InterfaceModelInterface } from './interface-model';

// Errors
export {
  OGMError,
  RecordNotFoundError,
  SubgraphOperationError,
} from './errors';

// Schema types
export type {
  SchemaMetadata,
  NodeDefinition,
  InterfaceDefinition,
  RelationshipDefinition,
  RelationshipPropertiesDefinition,
  PropertyDefinition,
  FulltextIndex,
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
