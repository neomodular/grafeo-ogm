import { DocumentNode } from 'graphql';
import { Driver, int as neo4jInt } from 'neo4j-driver';
import { FulltextCompiler } from './compilers/fulltext.compiler';
import { MutationCompiler } from './compilers/mutation.compiler';
import { SelectNormalizer } from './compilers/select-normalizer';
import {
  SelectionCompiler,
  SelectionNode,
} from './compilers/selection.compiler';
import { VectorCompiler } from './compilers/vector.compiler';
import { WhereCompiler } from './compilers/where.compiler';
import { OGMError, RecordNotFoundError } from './errors';
import { ExecutionContext, Executor, OGMLogger } from './execution/executor';
import { ResultMapper } from './execution/result-mapper';
import { PolicyDeniedError } from './policy/errors';
import { hashCtx } from './policy/resolver';
import { isWriteRestrictive } from './policy/types';
import type {
  Operation,
  PolicyContext,
  PolicyContextBundle,
  PolicyDefaults,
  ResolvedPolicies,
} from './policy/types';
import { NodeDefinition, SchemaMetadata } from './schema/types';
import { CypherFieldScope } from './utils/cypher-field-projection';
import { compileSortClause } from './utils/cypher-sort-projection';
import {
  assertSafeIdentifier,
  assertSafeLabel,
  escapeIdentifier,
  mergeParams,
} from './utils/validation';

/**
 * Internal binding handed to `Model` by `OGM.withContext(ctx)`. Carries
 * the per-request ctx, a resolver function, defaults, and a logger
 * reference for `unsafe` bypass logging.
 *
 * NOT exported — created and consumed inside the OGM.
 */
export interface ModelPolicyBinding {
  ctx: PolicyContext;
  resolve: (
    typeName: string,
    op: Operation,
    ctx: PolicyContext,
  ) => ResolvedPolicies | null;
  defaults: PolicyDefaults;
  logger?: OGMLogger;
  /** Set when this binding belongs to a `unsafe.bypassPolicies()` OGM. */
  globalBypass?: boolean;
  /** Stable version string for audit metadata. */
  policySetVersion: string;
}

/**
 * Optional per-call escape hatch on every Model method's params bag.
 */
export interface UnsafeOptions {
  bypassPolicies?: boolean;
}

interface FindOptions<TSort = Record<string, 'ASC' | 'DESC'>> {
  limit?: number;
  offset?: number;
  sort?: TSort[];
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
  TSort = Record<string, 'ASC' | 'DESC'>,
  TFulltext = FulltextInput,
> {
  find(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    options?: FindOptions<TSort>;
    fulltext?: TFulltext;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<T[]>;
  create(params: {
    input: TCreateInput[];
    labels?: string[];
    selectionSet?: string | DocumentNode;
    select?: TMutationSelect;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
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
    unsafe?: UnsafeOptions;
  }): Promise<MutationResponse<T, TPluralKey>>;
  delete(params: {
    where?: TWhere;
    delete?: TDeleteInput;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<{ nodesDeleted: number; relationshipsDeleted: number }>;
  aggregate(params: {
    where?: TWhere;
    aggregate: { count?: boolean; [field: string]: boolean | undefined };
    labels?: string[];
    fulltext?: TFulltext;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<{ count?: number; [field: string]: unknown }>;
  findFirst?(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    options?: Omit<FindOptions<TSort>, 'limit'>;
    fulltext?: TFulltext;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<T | null>;
  findUnique?(params: {
    where: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<T | null>;
  findFirstOrThrow?(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    options?: Omit<FindOptions<TSort>, 'limit'>;
    fulltext?: TFulltext;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<T>;
  findUniqueOrThrow?(params: {
    where: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<T>;
  count?(params?: {
    where?: TWhere;
    labels?: string[];
    fulltext?: TFulltext;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<number>;
  upsert?(params: {
    where: TWhere;
    create: TCreateInput;
    update: TUpdateInput;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<T>;
  createMany?(params: {
    data: TCreateInput[];
    skipDuplicates?: boolean;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<{ count: number }>;
  updateMany?(params: {
    where?: TWhere;
    data: TUpdateInput;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<{ count: number }>;
  deleteMany?(params: {
    where?: TWhere;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<{ count: number }>;
  searchByVector?(params: {
    indexName: string;
    vector: number[];
    k: number;
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<Array<{ node: T; score: number }>>;
  searchByPhrase?(params: {
    indexName: string;
    phrase: string;
    k: number;
    providerConfig?: Record<string, unknown>;
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<Array<{ node: T; score: number }>>;
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

/**
 * All compilers used by Model.
 *
 * `vector` is kept on `ModelCompilers` (not on `QueryCompilers`) because
 * vector search is a Model-only read-path concern and `InterfaceModel`
 * (which shares `QueryCompilers`) does not support it. Keeping it outside
 * `MutationCompilers` preserves that interface's "writes only" meaning.
 * Marked optional for backward compatibility with callers constructing
 * `ModelCompilers` literals before v1.3.0.
 */
export interface ModelCompilers extends QueryCompilers, MutationCompilers {
  vector?: VectorCompiler;
}

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
  TSort = Record<string, 'ASC' | 'DESC'>,
  TFulltext = FulltextInput,
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
  TMutationSelect,
  TSort,
  TFulltext
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
  private vectorCompiler: VectorCompiler;
  private executor: Executor;
  private policyBinding: ModelPolicyBinding | undefined;
  private logger: OGMLogger | undefined;

  constructor(
    private nodeDef: NodeDefinition,
    private schema: SchemaMetadata,
    driver: Driver,
    compilers?: ModelCompilers,
    logger?: OGMLogger,
    policyBinding?: ModelPolicyBinding,
  ) {
    this.whereCompiler = compilers?.where ?? new WhereCompiler(schema);
    this.selectionCompiler =
      compilers?.selection ?? new SelectionCompiler(schema, this.whereCompiler);
    this.selectNormalizer =
      compilers?.selectNormalizer ?? new SelectNormalizer(schema);
    this.mutationCompiler = compilers?.mutation ?? new MutationCompiler(schema);
    this.fulltextCompiler = compilers?.fulltext ?? new FulltextCompiler(schema);
    this.vectorCompiler = compilers?.vector ?? new VectorCompiler();
    this.executor = new Executor(driver, logger);
    this.policyBinding = policyBinding;
    this.logger = logger;
  }

  /**
   * Build a `PolicyContextBundle` for a single operation. Returns
   * `null` when no policies are bound (v1.6.0 path) or when the call
   * site requested `unsafe.bypassPolicies`. The latter case logs a
   * warning via the configured logger so the bypass is auditable.
   *
   * For default-deny `'throw'` mode, callers must throw BEFORE compile
   * — checked here and propagated by `assertNotDeniedAtCompile`.
   */
  private resolvePolicyContext(
    op: Operation,
    unsafe?: UnsafeOptions,
  ): PolicyContextBundle | null {
    const binding = this.policyBinding;
    if (!binding) return null;

    if (binding.globalBypass) {
      if (this.logger?.warn)
        this.logger.warn(
          '[OGM] policies bypassed via unsafe.bypassPolicies on type "%s" op "%s"',
          this.nodeDef.typeName,
          op,
        );
      return null;
    }

    if (unsafe?.bypassPolicies) {
      if (this.logger?.warn)
        this.logger.warn(
          '[OGM] per-call unsafe.bypassPolicies on type "%s" op "%s"',
          this.nodeDef.typeName,
          op,
        );
      return null;
    }

    const resolved = binding.resolve(this.nodeDef.typeName, op, binding.ctx);
    if (!resolved) return null;

    return {
      ctx: binding.ctx,
      operation: op,
      resolved,
      defaults: binding.defaults,
      resolveForType: (typeName, targetOp) =>
        binding.resolve(typeName, targetOp, binding.ctx),
    };
  }

  /**
   * Throw `PolicyDeniedError` when default-deny is set to `'throw'` AND
   * the resolved policy set has no permissive that could match. This
   * path runs BEFORE compile so calls fail at the call site.
   */
  private assertNotDeniedAtCompile(
    bundle: PolicyContextBundle | null,
    operation: Operation,
  ): void {
    if (!bundle) return;
    if (bundle.resolved.overridden) return;
    if (bundle.defaults.onDeny !== 'throw') return;
    if (bundle.resolved.permissives.length === 0)
      throw new PolicyDeniedError({
        typeName: this.nodeDef.typeName,
        operation,
        reason: 'no-permissive-matched',
      });
  }

  /**
   * Build `ExecutionContext` with audit metadata when policies are
   * configured. Preserves the user's transaction/session selection.
   */
  private withAuditMetadata(
    context: ExecutionContext | undefined,
    bundle: PolicyContextBundle | null,
    operation: Operation,
    bypassed: boolean,
  ): ExecutionContext | undefined {
    if (!this.policyBinding) return context;
    if (
      this.policyBinding.defaults.auditMetadata === false &&
      !this.policyBinding.globalBypass
    )
      return context;

    const evaluated = bundle?.resolved.evaluated ?? [];
    const metadata: Record<string, unknown> = {
      ogmPolicySetVersion: this.policyBinding.policySetVersion,
      ctxFingerprint: hashCtx(this.policyBinding.ctx),
      modelType: this.nodeDef.typeName,
      operation,
      policiesEvaluated: [...evaluated],
      bypassed,
    };

    if (context?.metadata)
      return { ...context, metadata: { ...context.metadata, ...metadata } };
    if (context) return { ...context, metadata };
    return { metadata };
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
    options?: FindOptions<TSort>;
    fulltext?: TFulltext;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<T[]> {
    if (params?.select && params?.selectionSet)
      throw new OGMError(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );

    const policyContext = this.resolvePolicyContext('read', params?.unsafe);
    this.assertNotDeniedAtCompile(policyContext, 'read');

    const cypherParts: string[] = [];
    const allParams: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    // Determine selection — delegated to the shared dispatcher so `find`,
    // `searchByVector`, and `searchByPhrase` all resolve selection identically.
    const selection = this.resolveSelection(params ?? {});

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

      // Compile WHERE — preserve `score` because the fulltext CALL bound
      // it and the WHERE itself may reference it via `score >= $ft_score`.
      const whereResult = this.whereCompiler.compile(
        params?.where,
        'n',
        this.nodeDef,
        paramCounter,
        { preserveVars: ['score'], policyContext: policyContext ?? undefined },
      );
      mergeParams(allParams, whereResult.params);

      // Stitch any `@cypher` field preludes between the fulltext call and
      // the WHERE so the projected aliases are in scope.
      if (whereResult.preludes && whereResult.preludes.length > 0)
        cypherParts.push(...whereResult.preludes);

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
        policyContext ? { policyContext } : undefined,
      );
      if (whereResult.preludes && whereResult.preludes.length > 0)
        cypherParts.push(...whereResult.preludes);
      if (whereResult.cypher) {
        cypherParts.push(`WHERE ${whereResult.cypher}`);
        mergeParams(allParams, whereResult.params);
      } else if (whereResult.preludes && whereResult.preludes.length > 0)
        // Even when the WHERE body is empty, still merge params (fulltext
        // subscript path already does this above; keep the no-where branch
        // consistent so future preludes that emit params don't drop them).
        mergeParams(allParams, whereResult.params);
    }

    // RETURN — the SELECT scope captures any `@cypher` field projections
    // referenced at the top level of the selection. Its CALL preludes
    // are stitched into the pipeline BEFORE the RETURN (and BEFORE the
    // sort prelude so ORDER BY `__sort_*` aliases share the same WITH
    // chain); the sort prelude carries the SELECT aliases forward via
    // preserveVars below.
    const selectScope = new CypherFieldScope('n', [], '__sel');
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.nodeDef,
      this._maxDepth,
      0,
      allParams,
      paramCounter,
      selectScope,
      policyContext,
    );

    // OPTIONS (sort, limit, offset) — `pre` holds CALL subqueries + WITH
    // projections for any `@cypher` sorts and must be inserted BEFORE the
    // RETURN; `post` is the trailing ORDER BY / SKIP / LIMIT.
    const opts = params?.options
      ? this.compileOptions(params.options, allParams, selectScope.carried())
      : { pre: '', post: '' };

    if (selectScope.hasAny()) cypherParts.push(...selectScope.emit());
    if (opts.pre) cypherParts.push(opts.pre);
    cypherParts.push(`RETURN ${returnClause}`);
    if (opts.post) cypherParts.push(opts.post);

    const cypher = cypherParts.join('\n');
    const result = await this.executor.execute(
      cypher,
      allParams,
      this.withAuditMetadata(
        params?.context,
        policyContext,
        'read',
        Boolean(params?.unsafe?.bypassPolicies),
      ),
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
    unsafe?: UnsafeOptions;
  }): Promise<MutationResponse<T, TPluralKey>> {
    if (params.select && params.selectionSet)
      throw new OGMError(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );

    const policyContext = this.resolvePolicyContext('create', params.unsafe);
    this.evaluateCreatePolicies(policyContext, params.input);

    const { cypher, params: mutParams } = this.mutationCompiler.compileCreate(
      params.input,
      this.nodeDef,
      params.labels,
    );

    // Shared counter so the selection's connection-where params don't collide
    // with anything the mutation compiler already emitted into mutParams.
    const paramCounter = { count: 0 };
    const readPolicyContext = this.resolvePolicyContext('read', params.unsafe);
    let finalCypher: string;
    if (params.select)
      finalCypher = this.applySelectToMutation(
        cypher,
        params.select,
        mutParams,
        paramCounter,
        readPolicyContext,
      );
    else
      finalCypher = this.applySelectionSetToMutation(
        cypher,
        params.selectionSet ?? this._selectionSet,
        mutParams,
        paramCounter,
        readPolicyContext,
      );

    const result = await this.executor.execute(
      finalCypher,
      mutParams,
      this.withAuditMetadata(
        params.context,
        policyContext,
        'create',
        Boolean(params.unsafe?.bypassPolicies),
      ),
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
    unsafe?: UnsafeOptions;
  }): Promise<MutationResponse<T, TPluralKey>> {
    if (params.select && params.selectionSet)
      throw new OGMError(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );

    const policyContext = this.resolvePolicyContext('update', params.unsafe);
    this.assertNotDeniedAtCompile(policyContext, 'update');
    this.evaluateWriteRestrictives(
      policyContext,
      'update',
      params.update as Record<string, unknown> | undefined,
    );

    const paramCounter = { count: 0 };
    const whereResult = this.whereCompiler.compile(
      params.where,
      'n',
      this.nodeDef,
      paramCounter,
      policyContext ? { policyContext } : undefined,
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

    const readPolicyContext = this.resolvePolicyContext('read', params.unsafe);
    let finalCypher: string;
    if (params.select)
      finalCypher = this.applySelectToMutation(
        cypher,
        params.select,
        mutParams,
        paramCounter,
        readPolicyContext,
      );
    else
      finalCypher = this.applySelectionSetToMutation(
        cypher,
        params.selectionSet ?? this._selectionSet,
        mutParams,
        paramCounter,
        readPolicyContext,
      );

    const result = await this.executor.execute(
      finalCypher,
      mutParams,
      this.withAuditMetadata(
        params.context,
        policyContext,
        'update',
        Boolean(params.unsafe?.bypassPolicies),
      ),
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
    unsafe?: UnsafeOptions;
  }): Promise<{ nodesDeleted: number; relationshipsDeleted: number }> {
    const policyContext = this.resolvePolicyContext('delete', params.unsafe);
    this.assertNotDeniedAtCompile(policyContext, 'delete');
    // Note: WriteRestrictives do not target 'delete' (deletes have no
    // input bag to validate). Row filtering for delete is enforced via
    // ReadRestrictives in the WHERE clause below.

    const paramCounter = { count: 0 };
    const whereResult = this.whereCompiler.compile(
      params.where,
      'n',
      this.nodeDef,
      paramCounter,
      policyContext ? { policyContext } : undefined,
    );

    const { cypher, params: mutParams } = this.mutationCompiler.compileDelete(
      this.nodeDef,
      whereResult,
      params.delete,
    );

    const result = await this.executor.execute(
      cypher,
      mutParams,
      this.withAuditMetadata(
        params.context,
        policyContext,
        'delete',
        Boolean(params.unsafe?.bypassPolicies),
      ),
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
    fulltext?: TFulltext;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<{ count?: number; [field: string]: unknown }> {
    // aggregate prefers 'aggregate' policies but falls back to 'read'
    // per design decision #7. The fallback only applies when no
    // 'aggregate'-specific policy is registered for this type.
    let policyContext = this.resolvePolicyContext('aggregate', params.unsafe);
    if (!policyContext)
      policyContext = this.resolvePolicyContext('read', params.unsafe);
    this.assertNotDeniedAtCompile(policyContext, 'aggregate');

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
        { preserveVars: ['score'], policyContext: policyContext ?? undefined },
      );
      mergeParams(allParams, whereResult.params);

      if (whereResult.preludes && whereResult.preludes.length > 0)
        cypherParts.push(...whereResult.preludes);

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
        policyContext ? { policyContext } : undefined,
      );
      if (whereResult.preludes && whereResult.preludes.length > 0)
        cypherParts.push(...whereResult.preludes);
      if (whereResult.cypher) {
        cypherParts.push(`WHERE ${whereResult.cypher}`);
        mergeParams(allParams, whereResult.params);
      } else if (whereResult.preludes && whereResult.preludes.length > 0)
        mergeParams(allParams, whereResult.params);
    }

    // Build RETURN clause for aggregation. Per-property emission: avg /
    // sum are only emitted for numeric types (Int / Float). Pre-1.7.4
    // we emitted them unconditionally, so `aggregate({ name: true })`
    // on a String field came back with `average: null` from
    // `avg(n.name)` (Neo4j returns null for non-numeric avg). Now we
    // look up the schema type and skip aggregations that don't apply.
    const returnParts: string[] = [];
    if (params.aggregate.count) returnParts.push('count(n) AS count');

    const fieldTypeCategories = new Map<string, FieldAggregateCategory>();
    for (const [field, enabled] of Object.entries(params.aggregate)) {
      if (field === 'count' || !enabled) continue;
      assertSafeIdentifier(field, 'aggregate field');
      const category = resolveFieldAggregateCategory(field, this.nodeDef);
      fieldTypeCategories.set(field, category);
      const escaped = escapeIdentifier(field);
      returnParts.push(`min(n.${escaped}) AS ${field}_min`);
      returnParts.push(`max(n.${escaped}) AS ${field}_max`);
      if (category === 'numeric') {
        returnParts.push(`avg(n.${escaped}) AS ${field}_avg`);
        returnParts.push(`sum(n.${escaped}) AS ${field}_sum`);
      }
    }

    cypherParts.push(`RETURN ${returnParts.join(', ')}`);

    const cypher = cypherParts.join('\n');
    const result = await this.executor.execute(
      cypher,
      allParams,
      this.withAuditMetadata(
        params.context,
        policyContext,
        'aggregate',
        Boolean(params.unsafe?.bypassPolicies),
      ),
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
      const category = fieldTypeCategories.get(field) ?? 'other';
      const entry: Record<string, unknown> = {
        min: ResultMapper.convertNeo4jTypes(record.get(`${field}_min`)),
        max: ResultMapper.convertNeo4jTypes(record.get(`${field}_max`)),
      };
      if (category === 'numeric') {
        entry.average = ResultMapper.convertNeo4jTypes(
          record.get(`${field}_avg`),
        );
        entry.sum = ResultMapper.convertNeo4jTypes(record.get(`${field}_sum`));
      }
      aggregateResult[field] = entry;
    }

    return aggregateResult;
  }

  // --- setLabels ------------------------------------------------------------

  async setLabels(params: {
    where: TWhere;
    addLabels?: string[];
    removeLabels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<void> {
    const policyContext = this.resolvePolicyContext('update', params.unsafe);
    this.assertNotDeniedAtCompile(policyContext, 'update');

    const paramCounter = { count: 0 };
    const whereResult = this.whereCompiler.compile(
      params.where,
      'n',
      this.nodeDef,
      paramCounter,
      policyContext ? { policyContext } : undefined,
    );

    const { cypher, params: mutParams } =
      this.mutationCompiler.compileSetLabels(
        this.nodeDef,
        whereResult,
        params.addLabels,
        params.removeLabels,
      );

    await this.executor.execute(
      cypher,
      mutParams,
      this.withAuditMetadata(
        params.context,
        policyContext,
        'update',
        Boolean(params.unsafe?.bypassPolicies),
      ),
    );
  }

  // --- findFirst / findUnique ------------------------------------------------

  async findFirst(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    options?: Omit<FindOptions<TSort>, 'limit'>;
    fulltext?: TFulltext;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
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
    unsafe?: UnsafeOptions;
  }): Promise<T | null> {
    return this.findFirst(params);
  }

  async findFirstOrThrow(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    options?: Omit<FindOptions<TSort>, 'limit'>;
    fulltext?: TFulltext;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
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
    unsafe?: UnsafeOptions;
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
    fulltext?: TFulltext;
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<number> {
    const result = await this.aggregate({
      where: params?.where,
      aggregate: { count: true },
      labels: params?.labels,
      fulltext: params?.fulltext,
      context: params?.context,
      unsafe: params?.unsafe,
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
    unsafe?: UnsafeOptions;
  }): Promise<T> {
    if (params.select && params.selectionSet)
      throw new OGMError(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );

    // MERGE has no WHERE we can stitch into so we evaluate restrictives
    // against both `create` and `update` inputs at the application layer.
    // Permissive default-deny applies — see PolicyDeniedError.
    const updatePolicy = this.resolvePolicyContext('update', params.unsafe);
    const createPolicy = this.resolvePolicyContext('create', params.unsafe);
    this.assertNotDeniedAtCompile(updatePolicy, 'update');
    if (
      createPolicy &&
      !createPolicy.resolved.overridden &&
      createPolicy.resolved.permissives.length === 0
    )
      throw new PolicyDeniedError({
        typeName: this.nodeDef.typeName,
        operation: 'create',
        reason: 'no-permissive-matched',
      });
    this.evaluateWriteRestrictives(
      updatePolicy,
      'update',
      params.update as Record<string, unknown> | undefined,
    );
    this.evaluateWriteRestrictives(
      createPolicy,
      'create',
      params.create as Record<string, unknown> | undefined,
    );

    const { cypher, params: mergeParams } = this.mutationCompiler.compileMerge(
      params.where as Record<string, unknown>,
      params.create as Record<string, unknown>,
      params.update as Record<string, unknown>,
      this.nodeDef,
      params.labels,
    );

    // Shared counter so the selection's connection-where params don't collide
    // with anything already in mergeParams.
    const paramCounter = { count: 0 };
    const readPolicyContext = this.resolvePolicyContext('read', params.unsafe);
    let finalCypher: string;
    if (params.select)
      finalCypher = this.applySelectToUpsert(
        cypher,
        params.select,
        mergeParams,
        paramCounter,
        readPolicyContext,
      );
    else
      finalCypher = this.applySelectionSetToUpsert(
        cypher,
        params.selectionSet ?? this._selectionSet,
        mergeParams,
        paramCounter,
        readPolicyContext,
      );

    const result = await this.executor.execute(
      finalCypher,
      mergeParams,
      this.withAuditMetadata(
        params.context,
        updatePolicy ?? createPolicy,
        'update',
        Boolean(params.unsafe?.bypassPolicies),
      ),
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
    unsafe?: UnsafeOptions;
  }): Promise<{ count: number }> {
    const policyContext = this.resolvePolicyContext('create', params.unsafe);
    this.evaluateCreatePolicies(
      policyContext,
      params.data as unknown as TCreateInput[],
    );

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
      this.withAuditMetadata(
        params.context,
        policyContext,
        'create',
        Boolean(params.unsafe?.bypassPolicies),
      ),
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
    unsafe?: UnsafeOptions;
  }): Promise<{ count: number }> {
    const policyContext = this.resolvePolicyContext('update', params.unsafe);
    this.assertNotDeniedAtCompile(policyContext, 'update');
    this.evaluateWriteRestrictives(
      policyContext,
      'update',
      params.data as Record<string, unknown> | undefined,
    );

    const paramCounter = { count: 0 };
    const whereResult = this.whereCompiler.compile(
      params.where,
      'n',
      this.nodeDef,
      paramCounter,
      policyContext ? { policyContext } : undefined,
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
      this.withAuditMetadata(
        params.context,
        policyContext,
        'update',
        Boolean(params.unsafe?.bypassPolicies),
      ),
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
    unsafe?: UnsafeOptions;
  }): Promise<{ count: number }> {
    const policyContext = this.resolvePolicyContext('delete', params.unsafe);
    this.assertNotDeniedAtCompile(policyContext, 'delete');
    // Note: WriteRestrictives do not target 'delete'. ReadRestrictives
    // on the WHERE clause provide the row filter below.

    const paramCounter = { count: 0 };
    const whereResult = this.whereCompiler.compile(
      params.where,
      'n',
      this.nodeDef,
      paramCounter,
      policyContext ? { policyContext } : undefined,
    );

    const { cypher, params: mutParams } = this.mutationCompiler.compileDelete(
      this.nodeDef,
      whereResult,
      undefined, // no cascade
    );

    const result = await this.executor.execute(
      cypher,
      mutParams,
      this.withAuditMetadata(
        params.context,
        policyContext,
        'delete',
        Boolean(params.unsafe?.bypassPolicies),
      ),
    );
    const counters = result.summary.counters.updates();
    return { count: counters.nodesDeleted };
  }

  // --- searchByVector / searchByPhrase --------------------------------------

  /**
   * Run a top-k vector similarity search against a pre-computed embedding.
   *
   * The emitted Cypher binds the matched node to `n` via
   * `db.index.vector.queryNodes(...) YIELD node AS n, score`, then applies
   * the node's label (plus any additional `labels`) and the user-supplied
   * `where` as a post-filter. The selection is compiled through the same
   * pipeline as `find()`, so `select` / `selectionSet` semantics match.
   *
   * **Requirements**
   * - Neo4j **5.11+** (for `db.index.vector.queryNodes`).
   * - A vector index must be created out-of-band via
   *   `CREATE VECTOR INDEX ... FOR (n:Label) ON n.embedding OPTIONS { ... }`.
   *   grafeo-ogm does not create vector indexes automatically.
   *
   * **`k` clamping** — `k` is silently clamped to the range `[1, 1000]` by
   * the compiler to prevent unbounded result sets. Requests for `k > 1000`
   * will return at most 1000 results without a runtime warning.
   *
   * @returns Array of `{ node, score }` pairs ordered as returned by the
   * Neo4j vector index (most similar first).
   */
  async searchByVector(params: {
    indexName: string;
    vector: number[];
    k: number;
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<Array<{ node: T; score: number }>> {
    return this.runVectorSearch({
      params,
      compile: (paramCounter) =>
        this.vectorCompiler.compileByVector({
          indexName: params.indexName,
          vector: params.vector,
          k: params.k,
          nodeDef: this.nodeDef,
          paramCounter,
        }),
    });
  }

  /**
   * Run a top-k vector similarity search keyed on a text phrase. Requires
   * the matching `@vector` index to declare a `provider` so Neo4j's
   * `genai.vector.encode` can produce the embedding server-side.
   *
   * `providerConfig` (API tokens, model overrides, etc.) is passed as a
   * Cypher parameter, never interpolated into the query string.
   *
   * **Requirements**
   * - Neo4j **5.11+** with the **GenAI plugin** installed
   *   (`genai.vector.encode` is shipped by the plugin, not core).
   * - The matching `@vector` index in your schema must set `provider` (e.g.
   *   `"OpenAI"`, `"VertexAI"`). Without it, `searchByPhrase` throws an
   *   `OGMError` at compile time.
   * - A vector index must exist in the database (create it manually via
   *   `CREATE VECTOR INDEX ...`).
   *
   * **`k` clamping** — same as `searchByVector`: silently clamped to
   * `[1, 1000]` to prevent unbounded result sets.
   */
  async searchByPhrase(params: {
    indexName: string;
    phrase: string;
    k: number;
    providerConfig?: Record<string, unknown>;
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    context?: ExecutionContext;
    unsafe?: UnsafeOptions;
  }): Promise<Array<{ node: T; score: number }>> {
    return this.runVectorSearch({
      params,
      compile: (paramCounter) =>
        this.vectorCompiler.compileByPhrase({
          indexName: params.indexName,
          phrase: params.phrase,
          k: params.k,
          providerConfig: params.providerConfig,
          nodeDef: this.nodeDef,
          paramCounter,
        }),
    });
  }

  /**
   * Shared pipeline for `searchByVector` / `searchByPhrase`. Handles the
   * selection resolution, label filter, user WHERE composition, projection
   * compilation, and record mapping. The CALL prelude is supplied by the
   * caller so that the vector vs. phrase branches share everything else.
   */
  private async runVectorSearch(args: {
    params: {
      where?: TWhere;
      selectionSet?: string | DocumentNode;
      select?: TSelect;
      labels?: string[];
      context?: ExecutionContext;
      unsafe?: UnsafeOptions;
    };
    compile: (paramCounter: { count: number }) => {
      cypher: string;
      params: Record<string, unknown>;
    };
  }): Promise<Array<{ node: T; score: number }>> {
    const { params } = args;

    if (params.select && params.selectionSet)
      throw new OGMError(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );

    const policyContext = this.resolvePolicyContext('read', params.unsafe);
    this.assertNotDeniedAtCompile(policyContext, 'read');

    const allParams: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    // 1. Compile the CALL prelude (binds `n` and `score`).
    const call = args.compile(paramCounter);
    mergeParams(allParams, call.params);

    // 2. Resolve the selection — mirror find()'s dispatch.
    const selection = this.resolveSelection(params);

    // 3. Build the label filter. The vector index can match anything with
    //    the indexed property, so we constrain to the expected label(s).
    const labelFilters: string[] = [
      `n:${escapeIdentifier(this.nodeDef.label)}`,
    ];
    if (params.labels)
      for (const label of params.labels)
        labelFilters.push(`n:${assertSafeLabel(label)}`);

    // 4. Compile the user WHERE (optional) and AND it into the label filter.
    //    The vector CALL binds `n` and `score` — any `@cypher` field preludes
    //    must carry `score` forward in their WITH or the trailing RETURN
    //    would lose it.
    const whereResult = this.whereCompiler.compile(
      params.where,
      'n',
      this.nodeDef,
      paramCounter,
      { preserveVars: ['score'], policyContext: policyContext ?? undefined },
    );
    mergeParams(allParams, whereResult.params);

    const whereParts = [labelFilters.join(' AND ')];
    if (whereResult.cypher) whereParts.push(whereResult.cypher);

    // 5. Compile the projection through the shared selection pipeline.
    //    Same scope rules as find(): `@cypher` SELECT fields project here
    //    and the prelude is stitched between the WHERE and the RETURN.
    //    The vector pipeline binds `score` from the CALL — preserve it so
    //    the trailing `RETURN ..., score` still has it in scope.
    const selectScope = new CypherFieldScope('n', ['score'], '__sel');
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.nodeDef,
      this._maxDepth,
      0,
      allParams,
      paramCounter,
      selectScope,
      policyContext,
    );

    const lines: string[] = [call.cypher];
    if (whereResult.preludes && whereResult.preludes.length > 0)
      lines.push(...whereResult.preludes);
    lines.push(`WHERE ${whereParts.join(' AND ')}`);
    if (selectScope.hasAny()) lines.push(...selectScope.emit());
    lines.push(`RETURN ${returnClause}, score`);

    const cypher = lines.join('\n');

    // 6. Execute and map each record into { node, score }.
    const result = await this.executor.execute(
      cypher,
      allParams,
      this.withAuditMetadata(
        params.context,
        policyContext,
        'read',
        Boolean(params.unsafe?.bypassPolicies),
      ),
    );
    return result.records.map((record) => ({
      node: ResultMapper.convertNeo4jTypes(record.get('n')) as T,
      score: ResultMapper.convertNeo4jTypes(record.get('score')) as number,
    }));
  }

  /**
   * Parse a selectionSet string (or DocumentNode) with LRU caching. Extracted
   * from the four previously-duplicated resolve-selection sites so one cache
   * dance lives in one place. Cache is capped at 500 entries (same as before).
   */
  private parseSelectionSetCached(
    selectionSet: string | DocumentNode,
  ): SelectionNode[] {
    const selStr =
      typeof selectionSet === 'string'
        ? selectionSet
        : (selectionSet.loc?.source?.body ?? String(selectionSet));
    const cached = Model._selectionCache.get(selStr);
    if (cached) return cached;
    const parsed = this.selectionCompiler.parseSelectionSet(selStr);
    if (Model._selectionCache.size < 500)
      Model._selectionCache.set(selStr, parsed);
    return parsed;
  }

  /**
   * Resolve a `SelectionNode[]` from `select` / `selectionSet` / the
   * instance-level selectionSet / defaults — matching `find()`'s behavior.
   */
  private resolveSelection(params: {
    selectionSet?: string | DocumentNode;
    select?: TSelect;
  }): SelectionNode[] {
    if (params.select)
      return this.selectNormalizer.normalize(params.select, this.nodeDef);
    if (params.selectionSet)
      return this.parseSelectionSetCached(params.selectionSet);
    if (this._parsedSelection) return this._parsedSelection;
    return this.defaultSelection();
  }

  // --- Private helpers ------------------------------------------------------

  /**
   * Evaluate `'create'` policies in JS BEFORE the mutation runs.
   *
   * - Override → all input is allowed.
   * - Permissive → at least one (whose `appliesWhen` matches) must
   *   accept each input via `when(ctx)` returning a non-empty partial.
   * - Restrictive → must hold for every input. Restrictives whose
   *   `when(ctx, input)` returns false trigger `PolicyDeniedError`.
   *
   * Note: the where-predicate from a permissive `when(ctx)` is treated
   * as a SHAPE check — it only documents which fields the user is
   * allowed to set; we do NOT compile-and-run the partial against the
   * input. (Validating shape against a where-partial is out of scope
   * for v1.7.0.) Restrictive `when(ctx, input)` is the canonical
   * "WITH CHECK" hook.
   */
  private evaluateCreatePolicies(
    bundle: PolicyContextBundle | null,
    inputs: TCreateInput[],
  ): void {
    if (!bundle || bundle.resolved.overridden) return;

    if (
      bundle.resolved.permissives.length === 0 &&
      bundle.defaults.onDeny === 'throw'
    )
      throw new PolicyDeniedError({
        typeName: this.nodeDef.typeName,
        operation: 'create',
        reason: 'no-permissive-matched',
      });
    if (
      bundle.resolved.permissives.length === 0 &&
      bundle.defaults.onDeny !== 'throw'
    )
      throw new PolicyDeniedError({
        typeName: this.nodeDef.typeName,
        operation: 'create',
        reason: 'no-permissive-matched',
        detail:
          'create operations cannot rely on default-deny silent-empty; at least one permissive must apply.',
      });

    for (const input of inputs)
      for (const r of bundle.resolved.restrictives) {
        // Only WriteRestrictives participate at the application layer.
        // ReadRestrictives bound to 'create' are nonsensical (no row to
        // filter) and the constructor would have flagged a mixed
        // operations array; this guard is defense in depth.
        if (!isWriteRestrictive(r)) continue;
        if (r.appliesWhen && !r.appliesWhen(bundle.ctx)) continue;
        const verdict = r.when(
          bundle.ctx,
          input as unknown as Record<string, unknown>,
        );
        if (verdict === false)
          throw new PolicyDeniedError({
            typeName: this.nodeDef.typeName,
            operation: 'create',
            reason: 'restrictive-rejected-input',
            policyName: r.name,
          });
      }
  }

  /**
   * Evaluate WRITE-side restrictive policies (create/update) at the
   * application layer. Each `WriteRestrictive` is invoked exactly once
   * with `(ctx, input)`; returning `false` rejects the operation with
   * `PolicyDeniedError`.
   *
   * ReadRestrictives are NOT consumed here — they enforce row-filter
   * semantics via the compiled WHERE clause (see `WhereCompiler`). Only
   * write-side restrictives have "WITH CHECK" semantics that need
   * application-layer evaluation.
   *
   * For `delete`, there is no input to validate; deletes are filtered
   * solely via ReadRestrictives on the WHERE clause. Calling this with
   * `operation: 'delete'` is a no-op (no WriteRestrictives target
   * delete).
   */
  private evaluateWriteRestrictives(
    bundle: PolicyContextBundle | null,
    operation: Operation,
    input: Record<string, unknown> | undefined,
  ): void {
    if (!bundle || bundle.resolved.overridden) return;
    for (const r of bundle.resolved.restrictives) {
      if (!isWriteRestrictive(r)) continue;
      // Compile-time gate: appliesWhen returning false drops the
      // policy entirely for this operation.
      if (r.appliesWhen && !r.appliesWhen(bundle.ctx)) continue;
      const verdict = r.when(bundle.ctx, input ?? {});
      if (verdict === false)
        throw new PolicyDeniedError({
          typeName: this.nodeDef.typeName,
          operation,
          reason: 'restrictive-rejected-input',
          policyName: r.name,
        });
    }
  }

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
   *
   * If the projection references `@cypher` scalar fields, the corresponding
   * CALL preludes are stitched immediately before the new RETURN.
   */
  private applySelectionSetToMutation(
    cypher: string,
    selectionSet: string | DocumentNode | undefined,
    params: Record<string, unknown>,
    paramCounter: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string {
    if (!selectionSet) return cypher;

    let selection = this.parseSelectionSetCached(selectionSet);

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

    const selectScope = new CypherFieldScope('n', [], '__sel');
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.nodeDef,
      this._maxDepth,
      0,
      params,
      paramCounter,
      selectScope,
      policyContext,
    );

    const replacement = selectScope.hasAny()
      ? `${selectScope.emit().join('\n')}\nRETURN ${returnClause}`
      : `RETURN ${returnClause}`;
    return cypher.replace(/RETURN n\s*$/, replacement);
  }

  /**
   * Apply a type-safe `select` object to a mutation's RETURN clause.
   * Only projects entity fields when select[pluralName] is present.
   */
  private applySelectToMutation(
    cypher: string,
    select: Record<string, unknown>,
    params: Record<string, unknown>,
    paramCounter: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string {
    const entitySelect = select[this.nodeDef.pluralName];
    if (!entitySelect || typeof entitySelect !== 'object') return cypher;

    const selection = this.selectNormalizer.normalize(
      entitySelect as Record<string, unknown>,
      this.nodeDef,
    );
    const selectScope = new CypherFieldScope('n', [], '__sel');
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.nodeDef,
      this._maxDepth,
      0,
      params,
      paramCounter,
      selectScope,
      policyContext,
    );
    const replacement = selectScope.hasAny()
      ? `${selectScope.emit().join('\n')}\nRETURN ${returnClause}`
      : `RETURN ${returnClause}`;
    return cypher.replace(/RETURN n\s*$/, replacement);
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
    paramCounter: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string {
    if (!selectionSet) return cypher;

    const selection = this.parseSelectionSetCached(selectionSet);

    const selectScope = new CypherFieldScope('n', [], '__sel');
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.nodeDef,
      this._maxDepth,
      0,
      params,
      paramCounter,
      selectScope,
      policyContext,
    );

    const replacement = selectScope.hasAny()
      ? `${selectScope.emit().join('\n')}\nRETURN ${returnClause}`
      : `RETURN ${returnClause}`;
    return cypher.replace(/RETURN n\s*$/, replacement);
  }

  /**
   * Apply a type-safe `select` object to an upsert's RETURN clause.
   */
  private applySelectToUpsert(
    cypher: string,
    select: Record<string, unknown>,
    params: Record<string, unknown>,
    paramCounter: { count: number },
    policyContext: PolicyContextBundle | null = null,
  ): string {
    const selection = this.selectNormalizer.normalize(select, this.nodeDef);
    const selectScope = new CypherFieldScope('n', [], '__sel');
    const returnClause = this.selectionCompiler.compile(
      selection,
      'n',
      this.nodeDef,
      this._maxDepth,
      0,
      params,
      paramCounter,
      selectScope,
      policyContext,
    );
    const replacement = selectScope.hasAny()
      ? `${selectScope.emit().join('\n')}\nRETURN ${returnClause}`
      : `RETURN ${returnClause}`;
    return cypher.replace(/RETURN n\s*$/, replacement);
  }

  private compileOptions(
    options: FindOptions<TSort>,
    params: Record<string, unknown>,
    /**
     * Variables already projected into scope by an earlier prelude (e.g.
     * `__sel_*` aliases for `@cypher` SELECT fields). These must be carried
     * forward by every `WITH` the sort prelude emits so that the trailing
     * RETURN can still reference them.
     */
    preserveVars: ReadonlyArray<string> = [],
  ): { pre: string; post: string } {
    const postParts: string[] = [];
    let pre = '';

    if (options.sort && options.sort.length > 0) {
      const compiled = compileSortClause({
        sort: options.sort as ReadonlyArray<Record<string, unknown>>,
        nodeVar: 'n',
        propertyLookup: (field) => this.nodeDef.properties.get(field),
        preserveVars,
      });
      pre = compiled.pre;
      if (compiled.orderBy) postParts.push(compiled.orderBy);
    }

    if (options.offset != null) {
      const offset = Math.trunc(Number(options.offset));
      if (!Number.isFinite(offset) || offset < 0)
        throw new OGMError('offset must be a non-negative integer');
      params.options_offset = neo4jInt(offset);
      postParts.push(`SKIP $options_offset`);
    }

    if (options.limit != null) {
      const limit = Math.trunc(Number(options.limit));
      if (!Number.isFinite(limit) || limit < 0)
        throw new OGMError('limit must be a non-negative integer');
      // Cap at 10,000 to prevent runaway queries
      const MAX_LIMIT = 10_000;
      params.options_limit = neo4jInt(Math.min(limit, MAX_LIMIT));
      postParts.push(`LIMIT $options_limit`);
    }

    return { pre, post: postParts.join('\n') };
  }
}

/**
 * Aggregate categories for type-aware emission. `numeric` covers
 * `Int` / `Float` (where `avg` and `sum` are well-defined). `temporal`
 * (`DateTime` / `Date` / `Time`) supports `min` / `max` only —
 * Neo4j's `avg` is undefined on temporals. `other` (`String` / `ID` /
 * `Boolean` / `Point` / etc.) supports `min` / `max` lexicographically.
 *
 * Note: `shortest` / `longest` (which the codegen exposes for `String`
 * / `ID`) are not yet runtime-supported — they require a `reduce`
 * over `collect()` that breaks the simple RETURN-aggregation pattern.
 * Tracked for a future release; the codegen-emitted keys remain
 * `undefined` at runtime until then.
 */
type FieldAggregateCategory = 'numeric' | 'temporal' | 'other';

function resolveFieldAggregateCategory(
  fieldName: string,
  nodeDef: NodeDefinition,
): FieldAggregateCategory {
  const prop = nodeDef.properties.get(fieldName);
  if (!prop) return 'other';
  if (prop.type === 'Int' || prop.type === 'Float') return 'numeric';
  if (
    prop.type === 'DateTime' ||
    prop.type === 'Date' ||
    prop.type === 'Time' ||
    prop.type === 'LocalDateTime' ||
    prop.type === 'LocalTime'
  )
    return 'temporal';
  return 'other';
}
