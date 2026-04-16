import { DocumentNode } from 'graphql';
import { Driver, int as neo4jInt } from 'neo4j-driver';
import { FulltextCompiler } from './compilers/fulltext.compiler';
import { MutationCompiler } from './compilers/mutation.compiler';
import { SelectNormalizer } from './compilers/select-normalizer';
import {
  SelectionCompiler,
  SelectionNode,
} from './compilers/selection.compiler';
import { WhereCompiler } from './compilers/where.compiler';
import { OGMError, RecordNotFoundError } from './errors';
import { ExecutionContext, Executor, OGMLogger } from './execution/executor';
import { ResultMapper } from './execution/result-mapper';
import { NodeDefinition, SchemaMetadata } from './schema/types';
import {
  assertSafeIdentifier,
  assertSafeLabel,
  assertSortDirection,
  escapeIdentifier,
  mergeParams,
} from './utils/validation';

interface FindOptions {
  limit?: number;
  offset?: number;
  sort?: Array<Record<string, 'ASC' | 'DESC'>>;
}

/** A single fulltext index query entry */
export interface FulltextIndexEntry {
  phrase: string;
  score?: number;
}

/** Relationship fulltext entry — index entries namespaced under a relationship field */
export type FulltextRelationshipEntry = Record<string, FulltextIndexEntry>;

/**
 * Fulltext leaf: a single index query.
 * - Node index: `{ IndexName: { phrase, score? } }`
 * - Relationship index: `{ relFieldName: { IndexName: { phrase, score? } } }`
 */
export type FulltextLeaf = Record<
  string,
  FulltextIndexEntry | FulltextRelationshipEntry
>;

/** Fulltext input with optional logical operators (OR/AND/NOT) */
export type FulltextInput =
  | FulltextLeaf
  | { OR: FulltextInput[] }
  | { AND: FulltextInput[] }
  | { NOT: FulltextInput };

/** Type guard: checks if a fulltext input is a leaf (not a logical operator) */
export function isFulltextLeaf(input: FulltextInput): input is FulltextLeaf {
  return !('OR' in input || 'AND' in input || 'NOT' in input);
}

/** Type guard: checks if a value is a direct index entry (has `phrase`) */
export function isFulltextIndexEntry(
  value: FulltextIndexEntry | FulltextRelationshipEntry,
): value is FulltextIndexEntry {
  return 'phrase' in value;
}

export interface MutationInfo {
  nodesCreated: number;
  nodesDeleted?: number;
  relationshipsCreated: number;
  relationshipsDeleted?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MutationResponse<T = any, K extends string = any> =
  // When K is 'any' (untyped model), allow any shape; when K is specific, enforce typed result
  string extends K
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    : { info: MutationInfo } & { [P in K]: T[] };

/**
 * Public-facing interface for Model — used in generated XModel type aliases.
 * Excludes internal class properties (selectionSet setter, maxDepth, etc.)
 * so that jest.Mocked<XModel> only requires CRUD methods.
 */
export interface ModelInterface<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TSelect extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TWhere extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TCreateInput extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TUpdateInput extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TConnectInput extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDisconnectInput extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeleteInput extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TPluralKey extends string = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TMutationSelect extends Record<string, unknown> = any,
> {
  find(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    options?: FindOptions;
    fulltext?: FulltextInput;
    context?: ExecutionContext;
  }): Promise<T[]>;
  create(params: {
    input: TCreateInput[];
    labels?: string[];
    selectionSet?: string | DocumentNode;
    select?: TMutationSelect;
    context?: ExecutionContext;
  }): Promise<MutationResponse<T, TPluralKey>>;
  update(params: {
    where?: TWhere;
    update?: TUpdateInput;
    connect?: TConnectInput;
    disconnect?: TDisconnectInput;
    labels?: string[];
    selectionSet?: string | DocumentNode;
    select?: TMutationSelect;
    context?: ExecutionContext;
  }): Promise<MutationResponse<T, TPluralKey>>;
  delete(params: {
    where?: TWhere;
    delete?: TDeleteInput;
    context?: ExecutionContext;
  }): Promise<{ nodesDeleted: number; relationshipsDeleted: number }>;
  aggregate(params: {
    where?: TWhere;
    aggregate: { count?: boolean; [field: string]: boolean | undefined };
    labels?: string[];
    fulltext?: FulltextInput;
    context?: ExecutionContext;
  }): Promise<{ count?: number; [field: string]: unknown }>;
  findFirst?(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    options?: Omit<FindOptions, 'limit'>;
    fulltext?: FulltextInput;
    context?: ExecutionContext;
  }): Promise<T | null>;
  findUnique?(params: {
    where: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<T | null>;
  findFirstOrThrow?(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    options?: Omit<FindOptions, 'limit'>;
    fulltext?: FulltextInput;
    context?: ExecutionContext;
  }): Promise<T>;
  findUniqueOrThrow?(params: {
    where: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<T>;
  count?(params?: {
    where?: TWhere;
    labels?: string[];
    fulltext?: FulltextInput;
    context?: ExecutionContext;
  }): Promise<number>;
  upsert?(params: {
    where: TWhere;
    create: TCreateInput;
    update: TUpdateInput;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<T>;
  createMany?(params: {
    data: TCreateInput[];
    skipDuplicates?: boolean;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<{ count: number }>;
  updateMany?(params: {
    where?: TWhere;
    data: TUpdateInput;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<{ count: number }>;
  deleteMany?(params: {
    where?: TWhere;
    context?: ExecutionContext;
  }): Promise<{ count: number }>;
}

/** Compilers needed for read-only operations (find, aggregate, count). */
export interface QueryCompilers {
  where: WhereCompiler;
  selection: SelectionCompiler;
  fulltext: FulltextCompiler;
}

/** Additional compilers needed for write operations (create, update, delete). */
export interface MutationCompilers {
  selectNormalizer: SelectNormalizer;
  mutation: MutationCompiler;
}

/** All compilers used by Model. */
export interface ModelCompilers extends QueryCompilers, MutationCompilers {}

export class Model<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TSelect extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TWhere extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TCreateInput extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TUpdateInput extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TConnectInput extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDisconnectInput extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeleteInput extends Record<string, unknown> = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TPluralKey extends string = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TMutationSelect extends Record<string, unknown> = any,
> implements ModelInterface<
  T,
  TSelect,
  TWhere,
  TCreateInput,
  TUpdateInput,
  TConnectInput,
  TDisconnectInput,
  TDeleteInput,
  TPluralKey,
  TMutationSelect
> {
  private _selectionSet: string | undefined;
  private _parsedSelection: SelectionNode[] | undefined;
  private _maxDepth: number = 5;
  private _defaultSelection: SelectionNode[] | undefined;

  /**
   * Global selection cache capped at 500 entries. No eviction — assumes bounded
   * selection set variety (fixed set of selectionSet strings used across resolvers).
   * In practice, NestJS services use a fixed set of selection strings, so growth is bounded.
   */
  private static _selectionCache = new Map<string, SelectionNode[]>();

  /** Clear the static selection cache. Useful in tests to prevent cross-test pollution. */
  static clearSelectionCache(): void {
    Model._selectionCache.clear();
  }

  private whereCompiler: WhereCompiler;
  private selectionCompiler: SelectionCompiler;
  private selectNormalizer: SelectNormalizer;
  private mutationCompiler: MutationCompiler;
  private fulltextCompiler: FulltextCompiler;
  private executor: Executor;

  constructor(
    private nodeDef: NodeDefinition,
    private schema: SchemaMetadata,
    driver: Driver,
    compilers?: ModelCompilers,
    logger?: OGMLogger,
  ) {
    this.whereCompiler = compilers?.where ?? new WhereCompiler(schema);
    this.selectionCompiler =
      compilers?.selection ?? new SelectionCompiler(schema, this.whereCompiler);
    this.selectNormalizer =
      compilers?.selectNormalizer ?? new SelectNormalizer(schema);
    this.mutationCompiler = compilers?.mutation ?? new MutationCompiler(schema);
    this.fulltextCompiler = compilers?.fulltext ?? new FulltextCompiler(schema);
    this.executor = new Executor(driver, logger);
  }

  /** Override the default RETURN clause -- legacy escape hatch */
  set selectionSet(value: string | DocumentNode) {
    if (typeof value === 'string') {
      this._selectionSet = value;
      this._parsedSelection = this.selectionCompiler.parseSelectionSet(value);
    } else {
      // DocumentNode -- convert to string first
      const str =
        typeof value === 'object' && 'loc' in value && value.loc?.source?.body
          ? value.loc.source.body
          : String(value);
      this._selectionSet = str;
      this._parsedSelection = this.selectionCompiler.parseSelectionSet(str);
    }
  }

  set maxDepth(value: number) {
    this._maxDepth = value;
  }

  // --- find -----------------------------------------------------------------

  async find(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    options?: FindOptions;
    fulltext?: FulltextInput;
    context?: ExecutionContext;
  }): Promise<T[]> {
    if (params?.select && params?.selectionSet)
      throw new OGMError(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );

    const cypherParts: string[] = [];
    const allParams: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    // Determine selection
    let selection: SelectionNode[];
    if (params?.select)
      selection = this.selectNormalizer.normalize(params.select, this.nodeDef);
    else if (params?.selectionSet) {
      const selStr =
        typeof params.selectionSet === 'string'
          ? params.selectionSet
          : (params.selectionSet.loc?.source?.body ??
            String(params.selectionSet));
      if (Model._selectionCache.has(selStr))
        selection = Model._selectionCache.get(selStr)!;
      else {
        selection = this.selectionCompiler.parseSelectionSet(selStr);
        if (Model._selectionCache.size < 500)
          Model._selectionCache.set(selStr, selection);
      }
    } else if (this._parsedSelection) selection = this._parsedSelection;
    else
      // Default: return all scalar properties
      selection = this.defaultSelection();

    // Fulltext or MATCH
    if (params?.fulltext) {
      const ft = this.fulltextCompiler.compile(
        params.fulltext,
        this.nodeDef,
        'n',
      );
      cypherParts.push(ft.cypher);
      mergeParams(allParams, ft.params);

      // Add label filter in WHERE for fulltext queries
      const labelFilters: string[] = [
        `n:${escapeIdentifier(this.nodeDef.label)}`,
      ];
      if (params.labels)
        for (const label of params.labels)
          labelFilters.push(`n:${assertSafeLabel(label)}`);

      // Compile WHERE
      const whereResult = this.whereCompiler.compile(
        params?.where,
        'n',
        this.nodeDef,
        paramCounter,
      );
      mergeParams(allParams, whereResult.params);

      const whereParts = [labelFilters.join(' AND ')];
      if (ft.scoreThreshold !== undefined)
        whereParts.push('score >= $ft_score');

      if (whereResult.cypher) whereParts.push(whereResult.cypher);

      cypherParts.push(`WHERE ${whereParts.join(' AND ')}`);
    } else {
      // Standard MATCH
      const validatedLabels = (params?.labels ?? []).map((l) =>
        assertSafeLabel(l),
      );
      const labels = [escapeIdentifier(this.nodeDef.label), ...validatedLabels];
      cypherParts.push(`MATCH (n:${labels.join(':')})`);

      // WHERE
      const whereResult = this.whereCompiler.compile(
        params?.where,
        'n',
        this.nodeDef,
        paramCounter,
      );
      if (whereResult.cypher) {
        cypherParts.push(`WHERE ${whereResult.cypher}`);
        mergeParams(allParams, whereResult.params);
      }
    }

    // RETURN
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.nodeDef,
      this._maxDepth,
      0,
      allParams,
      paramCounter,
    );
    cypherParts.push(`RETURN ${returnClause}`);

    // OPTIONS (sort, limit, offset)
    if (params?.options) {
      const optCypher = this.compileOptions(params.options, allParams);
      if (optCypher) cypherParts.push(optCypher);
    }

    const cypher = cypherParts.join('\n');
    const result = await this.executor.execute(
      cypher,
      allParams,
      params?.context,
    );
    return ResultMapper.mapRecords(result.records, 'n') as T[];
  }

  // --- create ---------------------------------------------------------------

  async create(params: {
    input: TCreateInput[];
    labels?: string[];
    selectionSet?: string | DocumentNode;
    select?: TMutationSelect;
    context?: ExecutionContext;
  }): Promise<MutationResponse<T, TPluralKey>> {
    if (params.select && params.selectionSet)
      throw new OGMError(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );

    const { cypher, params: mutParams } = this.mutationCompiler.compileCreate(
      params.input,
      this.nodeDef,
      params.labels,
    );

    let finalCypher: string;
    if (params.select)
      finalCypher = this.applySelectToMutation(
        cypher,
        params.select,
        mutParams,
      );
    else
      finalCypher = this.applySelectionSetToMutation(
        cypher,
        params.selectionSet ?? this._selectionSet,
        mutParams,
      );

    const result = await this.executor.execute(
      finalCypher,
      mutParams,
      params.context,
    );
    const summary = result.summary;
    const counters = summary.counters.updates();
    const mapped = ResultMapper.mapRecords(result.records, 'n') as T[];

    if (params.select)
      return this.buildSelectResult(
        params.select,
        counters,
        mapped,
      ) as MutationResponse<T, TPluralKey>;

    return {
      info: {
        nodesCreated: counters.nodesCreated,
        nodesDeleted: counters.nodesDeleted,
        relationshipsCreated: counters.relationshipsCreated,
        relationshipsDeleted: counters.relationshipsDeleted,
      },
      [this.nodeDef.pluralName]: mapped,
    } as MutationResponse<T, TPluralKey>;
  }

  // --- update ---------------------------------------------------------------

  async update(params: {
    where?: TWhere;
    update?: TUpdateInput;
    connect?: TConnectInput;
    disconnect?: TDisconnectInput;
    labels?: string[];
    selectionSet?: string | DocumentNode;
    select?: TMutationSelect;
    context?: ExecutionContext;
  }): Promise<MutationResponse<T, TPluralKey>> {
    if (params.select && params.selectionSet)
      throw new OGMError(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );

    const paramCounter = { count: 0 };
    const whereResult = this.whereCompiler.compile(
      params.where,
      'n',
      this.nodeDef,
      paramCounter,
    );

    const { cypher, params: mutParams } = this.mutationCompiler.compileUpdate(
      params.where ?? {},
      params.update as Record<string, unknown> | undefined,
      params.connect as Record<string, unknown> | undefined,
      params.disconnect as Record<string, unknown> | undefined,
      this.nodeDef,
      whereResult,
      params.labels,
    );

    let finalCypher: string;
    if (params.select)
      finalCypher = this.applySelectToMutation(
        cypher,
        params.select,
        mutParams,
      );
    else
      finalCypher = this.applySelectionSetToMutation(
        cypher,
        params.selectionSet ?? this._selectionSet,
        mutParams,
      );

    const result = await this.executor.execute(
      finalCypher,
      mutParams,
      params.context,
    );
    const summary = result.summary;
    const counters = summary.counters.updates();
    const mapped = ResultMapper.mapRecords(result.records, 'n') as T[];

    if (params.select)
      return this.buildSelectResult(
        params.select,
        counters,
        mapped,
      ) as MutationResponse<T, TPluralKey>;

    return {
      info: {
        nodesCreated: counters.nodesCreated,
        nodesDeleted: counters.nodesDeleted,
        relationshipsCreated: counters.relationshipsCreated,
        relationshipsDeleted: counters.relationshipsDeleted,
      },
      [this.nodeDef.pluralName]: mapped,
    } as MutationResponse<T, TPluralKey>;
  }

  // --- delete ---------------------------------------------------------------

  async delete(params: {
    where?: TWhere;
    delete?: TDeleteInput;
    context?: ExecutionContext;
  }): Promise<{ nodesDeleted: number; relationshipsDeleted: number }> {
    const paramCounter = { count: 0 };
    const whereResult = this.whereCompiler.compile(
      params.where,
      'n',
      this.nodeDef,
      paramCounter,
    );

    const { cypher, params: mutParams } = this.mutationCompiler.compileDelete(
      this.nodeDef,
      whereResult,
      params.delete,
    );

    const result = await this.executor.execute(
      cypher,
      mutParams,
      params.context,
    );
    const counters = result.summary.counters.updates();
    return {
      nodesDeleted: counters.nodesDeleted,
      relationshipsDeleted: counters.relationshipsDeleted,
    };
  }

  // --- aggregate ------------------------------------------------------------

  async aggregate(params: {
    where?: TWhere;
    aggregate: { count?: boolean; [field: string]: boolean | undefined };
    labels?: string[];
    fulltext?: FulltextInput;
    context?: ExecutionContext;
  }): Promise<{ count?: number; [field: string]: unknown }> {
    const cypherParts: string[] = [];
    const allParams: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    if (params.fulltext) {
      const ft = this.fulltextCompiler.compile(
        params.fulltext,
        this.nodeDef,
        'n',
      );
      cypherParts.push(ft.cypher);
      mergeParams(allParams, ft.params);

      const labelFilters = [`n:${escapeIdentifier(this.nodeDef.label)}`];
      if (params.labels)
        for (const label of params.labels)
          labelFilters.push(`n:${assertSafeLabel(label)}`);

      const whereResult = this.whereCompiler.compile(
        params.where,
        'n',
        this.nodeDef,
        paramCounter,
      );
      mergeParams(allParams, whereResult.params);

      const whereParts = [labelFilters.join(' AND ')];
      if (ft.scoreThreshold !== undefined)
        whereParts.push('score >= $ft_score');

      if (whereResult.cypher) whereParts.push(whereResult.cypher);

      cypherParts.push(`WHERE ${whereParts.join(' AND ')}`);
    } else {
      const validatedLabels = (params.labels ?? []).map((l) =>
        assertSafeLabel(l),
      );
      const labels = [escapeIdentifier(this.nodeDef.label), ...validatedLabels];
      cypherParts.push(`MATCH (n:${labels.join(':')})`);

      const whereResult = this.whereCompiler.compile(
        params.where,
        'n',
        this.nodeDef,
        paramCounter,
      );
      if (whereResult.cypher) {
        cypherParts.push(`WHERE ${whereResult.cypher}`);
        mergeParams(allParams, whereResult.params);
      }
    }

    // Build RETURN clause for aggregation
    const returnParts: string[] = [];
    if (params.aggregate.count) returnParts.push('count(n) AS count');

    for (const [field, enabled] of Object.entries(params.aggregate)) {
      if (field === 'count' || !enabled) continue;
      assertSafeIdentifier(field, 'aggregate field');
      returnParts.push(`min(n.${escapeIdentifier(field)}) AS ${field}_min`);
      returnParts.push(`max(n.${escapeIdentifier(field)}) AS ${field}_max`);
      returnParts.push(`avg(n.${escapeIdentifier(field)}) AS ${field}_avg`);
    }

    cypherParts.push(`RETURN ${returnParts.join(', ')}`);

    const cypher = cypherParts.join('\n');
    const result = await this.executor.execute(
      cypher,
      allParams,
      params.context,
    );

    if (result.records.length === 0)
      return params.aggregate.count ? { count: 0 } : {};

    const record = result.records[0];
    const aggregateResult: Record<string, unknown> = {};

    if (params.aggregate.count) {
      const countVal = record.get('count');
      aggregateResult.count = ResultMapper.convertNeo4jTypes(countVal);
    }

    for (const [field, enabled] of Object.entries(params.aggregate)) {
      if (field === 'count' || !enabled) continue;
      aggregateResult[field] = {
        min: ResultMapper.convertNeo4jTypes(record.get(`${field}_min`)),
        max: ResultMapper.convertNeo4jTypes(record.get(`${field}_max`)),
        average: ResultMapper.convertNeo4jTypes(record.get(`${field}_avg`)),
      };
    }

    return aggregateResult;
  }

  // --- setLabels ------------------------------------------------------------

  async setLabels(params: {
    where: TWhere;
    addLabels?: string[];
    removeLabels?: string[];
    context?: ExecutionContext;
  }): Promise<void> {
    const paramCounter = { count: 0 };
    const whereResult = this.whereCompiler.compile(
      params.where,
      'n',
      this.nodeDef,
      paramCounter,
    );

    const { cypher, params: mutParams } =
      this.mutationCompiler.compileSetLabels(
        this.nodeDef,
        whereResult,
        params.addLabels,
        params.removeLabels,
      );

    await this.executor.execute(cypher, mutParams, params.context);
  }

  // --- findFirst / findUnique ------------------------------------------------

  async findFirst(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    options?: Omit<FindOptions, 'limit'>;
    fulltext?: FulltextInput;
    context?: ExecutionContext;
  }): Promise<T | null> {
    const results = await this.find({
      ...params,
      options: { ...params?.options, limit: 1 },
    });
    return results[0] ?? null;
  }

  async findUnique(params: {
    where: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<T | null> {
    return this.findFirst(params);
  }

  async findFirstOrThrow(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    options?: Omit<FindOptions, 'limit'>;
    fulltext?: FulltextInput;
    context?: ExecutionContext;
  }): Promise<T> {
    const result = await this.findFirst(params);
    if (result === null)
      throw new RecordNotFoundError(
        this.nodeDef.typeName,
        params?.where as Record<string, unknown> | undefined,
      );
    return result;
  }

  async findUniqueOrThrow(params: {
    where: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<T> {
    const result = await this.findUnique(params);
    if (result === null)
      throw new RecordNotFoundError(
        this.nodeDef.typeName,
        params.where as Record<string, unknown>,
      );
    return result;
  }

  // --- count ----------------------------------------------------------------

  async count(params?: {
    where?: TWhere;
    labels?: string[];
    fulltext?: FulltextInput;
    context?: ExecutionContext;
  }): Promise<number> {
    const result = await this.aggregate({
      where: params?.where,
      aggregate: { count: true },
      labels: params?.labels,
      fulltext: params?.fulltext,
      context: params?.context,
    });
    return (result.count as number) ?? 0;
  }

  // --- upsert ---------------------------------------------------------------

  async upsert(params: {
    where: TWhere;
    create: TCreateInput;
    update: TUpdateInput;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<T> {
    if (params.select && params.selectionSet)
      throw new OGMError(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );

    const { cypher, params: mergeParams } = this.mutationCompiler.compileMerge(
      params.where as Record<string, unknown>,
      params.create as Record<string, unknown>,
      params.update as Record<string, unknown>,
      this.nodeDef,
      params.labels,
    );

    let finalCypher: string;
    if (params.select)
      finalCypher = this.applySelectToUpsert(
        cypher,
        params.select,
        mergeParams,
      );
    else
      finalCypher = this.applySelectionSetToUpsert(
        cypher,
        params.selectionSet ?? this._selectionSet,
        mergeParams,
      );

    const result = await this.executor.execute(
      finalCypher,
      mergeParams,
      params.context,
    );
    const mapped = ResultMapper.mapRecords(result.records, 'n') as T[];
    return mapped[0] ?? (null as unknown as T);
  }

  // --- createMany -----------------------------------------------------------

  async createMany(params: {
    data: TCreateInput[];
    skipDuplicates?: boolean;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<{ count: number }> {
    const { cypher, params: mutParams } =
      this.mutationCompiler.compileCreateMany(
        params.data as Record<string, unknown>[],
        this.nodeDef,
        params.skipDuplicates,
        params.labels,
      );

    const result = await this.executor.execute(
      cypher,
      mutParams,
      params.context,
    );
    const record = result.records[0];
    const count = record
      ? ResultMapper.convertNeo4jTypes(record.get('count'))
      : 0;
    return { count: count as number };
  }

  // --- updateMany ----------------------------------------------------------

  async updateMany(params: {
    where?: TWhere;
    data: TUpdateInput;
    labels?: string[];
    context?: ExecutionContext;
  }): Promise<{ count: number }> {
    const paramCounter = { count: 0 };
    const whereResult = this.whereCompiler.compile(
      params.where,
      'n',
      this.nodeDef,
      paramCounter,
    );

    const { cypher, params: mutParams } = this.mutationCompiler.compileUpdate(
      params.where ?? {},
      params.data as Record<string, unknown>,
      undefined, // no connect
      undefined, // no disconnect
      this.nodeDef,
      whereResult,
      params.labels,
      'count',
    );

    const result = await this.executor.execute(
      cypher,
      mutParams,
      params.context,
    );
    const record = result.records[0];
    const count = record
      ? ResultMapper.convertNeo4jTypes(record.get('count'))
      : 0;
    return { count: count as number };
  }

  // --- deleteMany ----------------------------------------------------------

  async deleteMany(params: {
    where?: TWhere;
    context?: ExecutionContext;
  }): Promise<{ count: number }> {
    const paramCounter = { count: 0 };
    const whereResult = this.whereCompiler.compile(
      params.where,
      'n',
      this.nodeDef,
      paramCounter,
    );

    const { cypher, params: mutParams } = this.mutationCompiler.compileDelete(
      this.nodeDef,
      whereResult,
      undefined, // no cascade
    );

    const result = await this.executor.execute(
      cypher,
      mutParams,
      params.context,
    );
    const counters = result.summary.counters.updates();
    return { count: counters.nodesDeleted };
  }

  // --- Private helpers ------------------------------------------------------

  private defaultSelection(): SelectionNode[] {
    if (this._defaultSelection) return this._defaultSelection;
    const nodes: SelectionNode[] = [];
    for (const [, prop] of this.nodeDef.properties) {
      if (prop.isCypher) continue;
      nodes.push({
        fieldName: prop.name,
        isScalar: true,
        isRelationship: false,
        isConnection: false,
      });
    }
    this._defaultSelection = nodes;
    return nodes;
  }

  /**
   * Replace the plain "RETURN n" in mutation cypher with a projected RETURN
   * when a selectionSet is provided, enabling relationship traversals.
   */
  private applySelectionSetToMutation(
    cypher: string,
    selectionSet: string | DocumentNode | undefined,
    params: Record<string, unknown>,
  ): string {
    if (!selectionSet) return cypher;

    const selStr =
      typeof selectionSet === 'string'
        ? selectionSet
        : (selectionSet.loc?.source?.body ?? String(selectionSet));

    let selection: SelectionNode[];
    if (Model._selectionCache.has(selStr))
      selection = Model._selectionCache.get(selStr)!;
    else {
      selection = this.selectionCompiler.parseSelectionSet(selStr);
      if (Model._selectionCache.size < 500)
        Model._selectionCache.set(selStr, selection);
    }

    // Mutation selectionSets use the pattern: { <pluralName> { <actual fields> } }
    // or { info { ... } <pluralName> { <actual fields> } }
    // Unwrap the outer response key to get the inner node fields.
    if (
      selection.length === 1 &&
      !selection[0].isScalar &&
      selection[0].children?.length
    ) {
      const outer = selection[0];
      if (
        outer.fieldName === this.nodeDef.pluralName ||
        !this.nodeDef.relationships.has(outer.fieldName)
      )
        selection = outer.children!;
    } else if (selection.length > 1) {
      // Multi-field mutation response (e.g., { info { ... } drugs { id } })
      // Find the field matching the plural name and use its children.
      const entityField = selection.find(
        (s) =>
          s.fieldName === this.nodeDef.pluralName &&
          !s.isScalar &&
          s.children?.length,
      );
      if (entityField) selection = entityField.children!;
    }

    const paramCounter = { count: 0 };
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.nodeDef,
      this._maxDepth,
      0,
      params,
      paramCounter,
    );

    return cypher.replace(/RETURN n\s*$/, `RETURN ${returnClause}`);
  }

  /**
   * Apply a type-safe `select` object to a mutation's RETURN clause.
   * Only projects entity fields when select[pluralName] is present.
   */
  private applySelectToMutation(
    cypher: string,
    select: Record<string, unknown>,
    params: Record<string, unknown>,
  ): string {
    const entitySelect = select[this.nodeDef.pluralName];
    if (!entitySelect || typeof entitySelect !== 'object') return cypher;

    const selection = this.selectNormalizer.normalize(
      entitySelect as Record<string, unknown>,
      this.nodeDef,
    );
    const paramCounter = { count: 0 };
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.nodeDef,
      this._maxDepth,
      0,
      params,
      paramCounter,
    );
    return cypher.replace(/RETURN n\s*$/, `RETURN ${returnClause}`);
  }

  /**
   * Build a narrowed result object based on which keys are present in `select`.
   */
  private buildSelectResult(
    select: Record<string, unknown>,
    counters: Record<string, number>,
    mapped: T[],
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (select.info && typeof select.info === 'object') {
      const infoSelect = select.info as Record<string, boolean>;
      const info: Record<string, number> = {};
      for (const [key, val] of Object.entries(infoSelect))
        if (val && key in counters) info[key] = counters[key];

      result.info = info;
    }
    if (select[this.nodeDef.pluralName])
      result[this.nodeDef.pluralName] = mapped;

    return result;
  }

  /**
   * Replace "RETURN n" in upsert cypher with a projected RETURN clause.
   */
  private applySelectionSetToUpsert(
    cypher: string,
    selectionSet: string | DocumentNode | undefined,
    params: Record<string, unknown>,
  ): string {
    if (!selectionSet) return cypher;

    const selStr =
      typeof selectionSet === 'string'
        ? selectionSet
        : (selectionSet.loc?.source?.body ?? String(selectionSet));

    let selection: SelectionNode[];
    if (Model._selectionCache.has(selStr))
      selection = Model._selectionCache.get(selStr)!;
    else {
      selection = this.selectionCompiler.parseSelectionSet(selStr);
      if (Model._selectionCache.size < 500)
        Model._selectionCache.set(selStr, selection);
    }

    const paramCounter = { count: 0 };
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.nodeDef,
      this._maxDepth,
      0,
      params,
      paramCounter,
    );

    return cypher.replace(/RETURN n\s*$/, `RETURN ${returnClause}`);
  }

  /**
   * Apply a type-safe `select` object to an upsert's RETURN clause.
   */
  private applySelectToUpsert(
    cypher: string,
    select: Record<string, unknown>,
    params: Record<string, unknown>,
  ): string {
    const selection = this.selectNormalizer.normalize(select, this.nodeDef);
    const paramCounter = { count: 0 };
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.nodeDef,
      this._maxDepth,
      0,
      params,
      paramCounter,
    );
    return cypher.replace(/RETURN n\s*$/, `RETURN ${returnClause}`);
  }

  private compileOptions(
    options: FindOptions,
    params: Record<string, unknown>,
  ): string {
    const parts: string[] = [];

    if (options.sort && options.sort.length > 0) {
      const sortItems = options.sort.map((sortObj) => {
        const [field, direction] = Object.entries(sortObj)[0];
        assertSafeIdentifier(field, 'sort field');
        const validDirection = assertSortDirection(direction);
        return `n.${escapeIdentifier(field)} ${validDirection}`;
      });
      parts.push(`ORDER BY ${sortItems.join(', ')}`);
    }

    if (options.offset != null) {
      const offset = Math.trunc(Number(options.offset));
      if (!Number.isFinite(offset) || offset < 0)
        throw new OGMError('offset must be a non-negative integer');
      params.options_offset = neo4jInt(offset);
      parts.push(`SKIP $options_offset`);
    }

    if (options.limit != null) {
      const limit = Math.trunc(Number(options.limit));
      if (!Number.isFinite(limit) || limit < 0)
        throw new OGMError('limit must be a non-negative integer');
      // Cap at 10,000 to prevent runaway queries
      const MAX_LIMIT = 10_000;
      params.options_limit = neo4jInt(Math.min(limit, MAX_LIMIT));
      parts.push(`LIMIT $options_limit`);
    }

    return parts.join('\n');
  }
}
