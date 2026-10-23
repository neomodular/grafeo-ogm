import { DocumentNode } from 'graphql';
import { Driver, int as neo4jInt, QueryResult } from 'neo4j-driver';
import { FulltextCompiler } from './compilers/fulltext.compiler';
import {
  MutationCompiler,
  type MatchGuard,
} from './compilers/mutation.compiler';
import { SelectNormalizer } from './compilers/select-normalizer';
import {
  SelectionCompiler,
  SelectionNode,
} from './compilers/selection.compiler';
import { VectorCompiler } from './compilers/vector.compiler';
import { WhereCompiler } from './compilers/where.compiler';
import type { CompiledPolicyFragments } from './compilers/where.compiler';
import { OGMError, RecordNotFoundError } from './errors';
import { ExecutionContext, Executor, OGMLogger } from './execution/executor';
import { ResultMapper } from './execution/result-mapper';
import { PolicyDeniedError } from './policy/errors';
import {
  addedLabelTypes,
  evaluateLabelCreatePolicies,
  removedLabelTypes,
} from './policy/labels';
import {
  assertNestedCreatesAllowed,
  assertNestedUpdatesAllowed,
  evaluateCreatePolicies,
  evaluateWriteRestrictives,
  targetBundle,
} from './policy/nested-writes';
import {
  buildExplainPlan,
  EXPLAIN_OUTCOMES,
  EXPLAIN_VISIBLE,
  interpretExplainRow,
  resolveExplainLimit,
} from './policy/explain';
import { hashCtx, projectResolution } from './policy/resolver';
import { NO_ROOT_POLICY } from './policy/types';
import type {
  DetailedResolution,
  Operation,
  PolicyContext,
  PolicyContextBundle,
  PolicyDefaults,
  PolicyExplanation,
  ResolvedPolicies,
} from './policy/types';
import { nodeLabelExpr } from './schema/labels';
import { NodeDefinition, SchemaMetadata } from './schema/types';
import { getTargetLabelString } from './schema/utils';
import { CypherFieldScope } from './utils/cypher-field-projection';
import {
  compileSortClause,
  orderBeforeProjection,
} from './utils/cypher-sort-projection';
import { lenientStrictMode, StrictMode } from './utils/strict-mode';
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
  /**
   * Full resolution (nothing dropped) for `explainPolicies`. Optional so
   * hand-built bindings stay valid; `OGMWithContext` always supplies it.
   */
  resolveDetailed?: (
    typeName: string,
    op: Operation,
    ctx: PolicyContext,
  ) => DetailedResolution | null;
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
  /**
   * v2.6.0 — the OGM's strict-mode switch and warn-once logger, shared by
   * every compiler. Optional for hand-built compiler bundles (lenient).
   */
  strictMode?: StrictMode;
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
  private strictMode: StrictMode;

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
      compilers?.selectNormalizer ??
      new SelectNormalizer(schema, compilers?.strictMode);
    this.mutationCompiler =
      compilers?.mutation ??
      new MutationCompiler(schema, { whereCompiler: this.whereCompiler });
    this.fulltextCompiler = compilers?.fulltext ?? new FulltextCompiler(schema);
    this.vectorCompiler = compilers?.vector ?? new VectorCompiler();
    this.executor = new Executor(driver, logger);
    this.policyBinding = policyBinding;
    this.logger = logger;
    this.strictMode = compilers?.strictMode ?? lenientStrictMode();
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

    // v2.3.0 — a root with no policy for `op` still gets a bundle
    // (`NO_ROOT_POLICY`: no root clause) so target-type policies stay
    // enforced on everything reached through relationships. Pre-2.3.0 this
    // returned `null`, turning policy-free types into gateways around
    // their neighbours' policies.
    const resolved =
      binding.resolve(this.nodeDef.typeName, op, binding.ctx) ?? NO_ROOT_POLICY;

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
   * Run an `update` / `updateMany` statement built by `compile`.
   *
   * v2.8.0 — finding F1. A nested delete reached through a cycle (chart ->
   * tags -> charts) can delete a node the statement still holds, and a
   * later clause that reads or writes it fails with `EntityNotFound`.
   * Strict mode compiles the alive guard up front. Default mode runs the
   * v2.7.0 statement unchanged, so every statement that worked keeps its
   * Cypher and result; when one with such a delete fails with
   * `EntityNotFound` in a transaction the OGM owns (auto-commit, or a
   * caller `session`), the failed attempt has been rolled back and it is
   * re-run once with the guard: the deleted node's remaining writes are
   * skipped and a deleted root is left out of the result. In a caller's
   * `transaction` the server has already rolled the transaction back, so
   * the error is rethrown (and warned about once).
   */
  private async executeUpdate(
    compile: (guardDeleted: boolean) => {
      cypher: string;
      params: Record<string, unknown>;
      cycleDelete?: boolean;
    },
    context: ExecutionContext | undefined,
    operation: 'update' | 'updateMany',
    audit: (
      context: ExecutionContext | undefined,
    ) => ExecutionContext | undefined,
  ): Promise<QueryResult> {
    const first = compile(this.strictMode.strict);
    try {
      return await this.executor.execute(
        first.cypher,
        first.params,
        audit(context),
      );
    } catch (err) {
      if (
        !first.cycleDelete ||
        this.strictMode.strict ||
        (err as { code?: unknown } | null)?.code !==
          'Neo.ClientError.Statement.EntityNotFound'
      )
        throw err;
      if (context?.executionContext ?? context?.transaction) {
        this.strictMode.warn(
          'cycle-delete-in-transaction',
          `${this.nodeDef.typeName}\u0000${operation}`,
          `${operation} on ${this.nodeDef.typeName} failed with EntityNotFound: a nested delete reached through a cycle ` +
            `removed a node the statement still reads or writes. Outside a caller transaction the OGM re-runs such ` +
            `a statement with the deleted node's remaining writes skipped; in a caller transaction it cannot.`,
          'skip the remaining writes of a deleted node, and leave a deleted root out of the result, in any transaction',
        );
        throw err;
      }
      const guarded = compile(true);
      return this.executor.execute(
        guarded.cypher,
        guarded.params,
        audit(context),
      );
    }
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
    /**
     * `explainPolicies` call — tags `explain: true` and, like a global
     * bypass, is ALWAYS recorded even with `auditMetadata: false`.
     */
    explain = false,
    /**
     * v2.10.1 — policies of OTHER types (or operations) the call applied
     * because a runtime label put the node in that type; listed after the
     * root's own (see `src/policy/labels.ts`).
     */
    extraEvaluated: ReadonlyArray<string> = [],
  ): ExecutionContext | undefined {
    if (!this.policyBinding) return context;
    if (
      this.policyBinding.defaults.auditMetadata === false &&
      !this.policyBinding.globalBypass &&
      !explain
    )
      return context;

    const evaluated = bundle?.resolved.evaluated ?? [];
    const metadata: Record<string, unknown> = {
      ogmPolicySetVersion: this.policyBinding.policySetVersion,
      ctxFingerprint: hashCtx(this.policyBinding.ctx),
      modelType: this.nodeDef.typeName,
      operation,
      policiesEvaluated: [...evaluated, ...extraEvaluated],
      bypassed,
    };
    if (explain) metadata.explain = true;

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
      const labelFilters: string[] = [`n:${nodeLabelExpr(this.nodeDef)}`];
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
      const labels = [nodeLabelExpr(this.nodeDef), ...validatedLabels];
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
    cypherParts.push(...orderBeforeProjection(opts.post));
    cypherParts.push(`RETURN ${returnClause}`);

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

  // --- explainPolicies ------------------------------------------------------

  /**
   * Explain, per candidate node, the outcome of every `read` policy that
   * `find` would enforce for this model's bound context (GitHub issue #6).
   *
   * **This is a deliberate policy bypass.** Candidates are selected by
   * `where` / `labels` exactly as `find` selects them, but the root policy
   * predicate is REPORTED instead of applied — nodes the bound context
   * cannot see ARE returned, with `visible: false`. Use it only on
   * admin-only diagnostic paths. Every call logs a `warn` and is tagged
   * `explain: true` in transaction metadata, even with
   * `auditMetadata: false`.
   *
   * - `visible` is the exact enforcement verdict: the query projects the
   *   same composed predicate `find` puts in its WHERE, and the verdict
   *   recomputed from the per-policy outcomes must agree with it or the
   *   call throws — it never returns a possibly-wrong explanation.
   * - Relationships in the selection are still filtered by their own
   *   target-type policies, exactly as in `find`; only the root type's
   *   policies are explained.
   * - When the executor opens its own session it is READ-mode, so the
   *   server rejects any write. A caller-supplied `transaction` /
   *   `session` is used as-is — the caller owns its access mode.
   * - `options.limit` defaults to 100 and may not exceed 1,000.
   */
  async explainPolicies(params?: {
    where?: TWhere;
    selectionSet?: string | DocumentNode;
    select?: TSelect;
    labels?: string[];
    options?: FindOptions<TSort>;
    context?: ExecutionContext;
  }): Promise<PolicyExplanation<T>[]> {
    if (params?.select && params?.selectionSet)
      throw new OGMError(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );

    const binding = this.policyBinding;
    if (binding?.globalBypass)
      throw new OGMError(
        'explainPolicies cannot run on a policy-bypassed OGM (ogm.unsafe.bypassPolicies()): there are no enforced policies to explain.',
      );
    const resolveDetailed = binding?.resolveDetailed;
    if (!binding || !resolveDetailed)
      throw new OGMError(
        `explainPolicies requires a policy-bound model. Obtain it via ogm.withContext(ctx).model('${this.nodeDef.typeName}').`,
      );

    const limit = resolveExplainLimit(params?.options?.limit);

    if (this.logger?.warn)
      this.logger.warn(
        '[OGM] explainPolicies on type "%s" returns rows regardless of policy outcome (diagnostic policy bypass)',
        this.nodeDef.typeName,
      );

    // Resolve ONCE and derive the compile input from the same object the
    // report is built from — keeps fragments aligned with entries.
    const ctx = binding.ctx;
    const detailed = resolveDetailed(this.nodeDef.typeName, 'read', ctx);
    // Always bound (v2.3.0): a root without policies still enforces the
    // policies of the types its selection / traversals reach, like `find`.
    const policyContext: PolicyContextBundle = {
      ctx,
      operation: 'read',
      resolved: detailed ? projectResolution(detailed) : NO_ROOT_POLICY,
      defaults: binding.defaults,
      resolveForType: (typeName, targetOp) =>
        binding.resolve(typeName, targetOp, ctx),
    };

    const cypherParts: string[] = [];
    const allParams: Record<string, unknown> = {};
    const paramCounter = { count: 0 };
    const selection = this.resolveSelection(params ?? {});

    const validatedLabels = (params?.labels ?? []).map((l) =>
      assertSafeLabel(l),
    );
    const labels = [nodeLabelExpr(this.nodeDef), ...validatedLabels];
    cypherParts.push(`MATCH (n:${labels.join(':')})`);

    // Candidate WHERE — compiled exactly as `find` compiles it (same
    // order, counter, prelude scope, policy-aware traversal), with the
    // root policy clause returned separately instead of AND-stitched.
    const where = this.whereCompiler.compileForExplain(
      params?.where,
      'n',
      this.nodeDef,
      paramCounter,
      policyContext,
    );
    if (where.preludes.length > 0) cypherParts.push(...where.preludes);
    mergeParams(allParams, where.params);
    const policyClause: string | null = where.policy?.clause ?? null;
    const fragments: CompiledPolicyFragments | null =
      where.policy?.fragments ?? null;
    if (where.userCypher) cypherParts.push(`WHERE ${where.userCypher}`);

    // Project the outcomes right after the candidate WHERE: the `@cypher`
    // `__where_*` aliases the fragments reference are only in scope here
    // (selection / sort preludes carry just their own preserveVars).
    const plan = buildExplainPlan(detailed, fragments);
    const visibleExpr =
      policyClause === null ? 'true' : `coalesce((${policyClause}), false)`;
    cypherParts.push(
      `WITH n, [${plan.outcomeExpressions.join(', ')}] AS ${EXPLAIN_OUTCOMES}, ${visibleExpr} AS ${EXPLAIN_VISIBLE}`,
    );

    const explainVars = [EXPLAIN_OUTCOMES, EXPLAIN_VISIBLE];
    const selectScope = new CypherFieldScope('n', explainVars, '__sel');
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
    const opts = this.compileOptions({ ...params?.options, limit }, allParams, [
      ...explainVars,
      ...selectScope.carried(),
    ]);

    if (selectScope.hasAny()) cypherParts.push(...selectScope.emit());
    if (opts.pre) cypherParts.push(opts.pre);
    cypherParts.push(...orderBeforeProjection(opts.post));
    cypherParts.push(
      `RETURN ${returnClause}, ${EXPLAIN_OUTCOMES}, ${EXPLAIN_VISIBLE}`,
    );

    const result = await this.executor.execute(
      cypherParts.join('\n'),
      allParams,
      this.withAuditMetadata(
        params?.context,
        policyContext,
        'read',
        false,
        true,
      ),
      { accessMode: 'READ' },
    );

    return result.records.map((record, row) => ({
      node: ResultMapper.mapRecord(record, 'n') as T,
      ...interpretExplainRow(
        plan,
        record.get(EXPLAIN_OUTCOMES),
        record.get(EXPLAIN_VISIBLE),
        this.nodeDef.typeName,
        row,
      ),
    }));
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
    // v2.10.1 — `labels` naming another declared type: the node is created
    // as that type too, so that type's `create` policies apply to each
    // input (default deny + WITH CHECK), as for a nested create. Pre-2.10.1
    // only the label string was validated, so a context that could not
    // create a `Secret` minted one with `Public.create({ labels: ['Secret'] })`.
    const labelPolicies = evaluateLabelCreatePolicies(
      policyContext,
      this.nodeDef,
      addedLabelTypes(this.schema, this.nodeDef, params.labels, true),
      params.input as unknown as Record<string, unknown>[],
      'create',
    );
    assertNestedCreatesAllowed(
      this.schema,
      this.nodeDef,
      params.input as unknown as Record<string, unknown>[],
      policyContext,
    );

    // ONE counter for the whole statement: nested connect filters and their
    // target-policy predicates (mutation compiler), then the selection's
    // connection-where params, all draw from it — no `param<N>` collisions.
    const paramCounter = { count: 0 };
    const { cypher, params: mutParams } = this.mutationCompiler.compileCreate(
      params.input,
      this.nodeDef,
      params.labels,
      // v2.3.0 — connect targets inside the create input are gated by the
      // TARGET type's read policy (pre-2.3.0 the create path threaded none).
      policyContext ?? undefined,
      paramCounter,
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
        'create',
        Boolean(params.unsafe?.bypassPolicies),
        false,
        labelPolicies,
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
    assertNestedUpdatesAllowed(
      this.schema,
      this.nodeDef,
      params.update as Record<string, unknown> | undefined,
      policyContext,
    );

    const compile = (guardDeleted: boolean) => {
      const paramCounter = { count: 0 };
      const whereResult = this.whereCompiler.compile(
        params.where,
        'n',
        this.nodeDef,
        paramCounter,
        policyContext ? { policyContext } : undefined,
      );

      const {
        cypher,
        params: mutParams,
        cycleDelete,
      } = this.mutationCompiler.compileUpdate(
        params.where ?? {},
        params.update as Record<string, unknown> | undefined,
        params.connect as Record<string, unknown> | undefined,
        params.disconnect as Record<string, unknown> | undefined,
        this.nodeDef,
        whereResult,
        params.labels,
        'node',
        // Thread the caller's update bundle + shared param counter so every
        // connect/disconnect target MATCH AND-stitches the TARGET type's
        // `read` policy (see MutationCompiler.buildTargetPolicyPredicate).
        policyContext ?? undefined,
        paramCounter,
        guardDeleted,
      );

      const readPolicyContext = this.resolvePolicyContext(
        'read',
        params.unsafe,
      );
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
      return { cypher: finalCypher, params: mutParams, cycleDelete };
    };

    const result = await this.executeUpdate(
      compile,
      params.context,
      'update',
      (context) =>
        this.withAuditMetadata(
          context,
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
      // v2.3.0 — each cascade target is gated by its own `delete` policy.
      policyContext ?? undefined,
      paramCounter,
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
    // "No aggregate policy registered" is `NO_ROOT_POLICY` (identity), not
    // a null bundle — a bound model always carries one since v2.3.0.
    let policyContext = this.resolvePolicyContext('aggregate', params.unsafe);
    if (!policyContext || policyContext.resolved === NO_ROOT_POLICY)
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

      const labelFilters = [`n:${nodeLabelExpr(this.nodeDef)}`];
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
      const labels = [nodeLabelExpr(this.nodeDef), ...validatedLabels];
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
      // v2.4.8 — a `@cypher` field has no stored property, so `min(n.f)`
      // read nothing: null min/max/average and a sum of 0, silently.
      if (this.nodeDef.properties.get(field)?.isCypher)
        throw new OGMError(
          `Cannot aggregate @cypher field "${this.nodeDef.typeName}.${field}": it is computed per node, not stored, ` +
            `so min/max/average/sum would read a missing property. Aggregate a stored field, or compute the ` +
            `aggregate in a custom Cypher query.`,
        );
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
      } else if (category === 'numericList') {
        // v2.6.0 — the keys the generated types declare, with no value:
        // a list has no average / sum (pre-2.6.0 the query failed).
        entry.average = null;
        entry.sum = null;
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

    // v2.10.1 — labels that another declared type carries
    // (`src/policy/labels.ts`). Adding one is a `create` on that type:
    // checked here, before compile, on an empty input (the call carries no
    // properties); the MATCH then also needs the root `read` filter, since
    // the node becomes reachable through that type's model. Removing one is
    // a `delete` on the type: its `delete` row filter joins the MATCH.
    // Pre-2.10.1 only the root `update` filter ran, so a context that
    // could not create a `Secret` converted its own row into one, and a
    // context that could update but not read a `Secret` relabelled it as
    // an unprotected type and read it there.
    const addTypes = policyContext
      ? addedLabelTypes(this.schema, this.nodeDef, params.addLabels, false)
      : [];
    const leftTypes = policyContext
      ? removedLabelTypes(this.schema, params.removeLabels)
      : [];
    const labelPolicies = evaluateLabelCreatePolicies(
      policyContext,
      this.nodeDef,
      addTypes,
      [{}],
      'setLabels',
    );
    // One `@cypher` scope for the root `update` filter and the label
    // guards, so their preludes form a single WITH chain.
    const scope =
      policyContext && (addTypes.length > 0 || leftTypes.length > 0)
        ? new CypherFieldScope('n', [], '__where')
        : undefined;

    const paramCounter = { count: 0 };
    const whereResult = this.whereCompiler.compile(
      params.where,
      'n',
      this.nodeDef,
      paramCounter,
      policyContext
        ? scope
          ? { policyContext, scope }
          : { policyContext }
        : undefined,
    );
    if (policyContext && scope)
      this.applyLabelChangeGuards(
        whereResult,
        policyContext,
        addTypes.length > 0,
        leftTypes,
        paramCounter,
        scope,
        labelPolicies,
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
        false,
        labelPolicies,
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

    // WITH CHECK restrictives are evaluated against both `create` and
    // `update` inputs at the application layer. Permissive default-deny
    // applies — see PolicyDeniedError. v2.6.1 — the `update` ROW filter is
    // also applied, to the node the MERGE matches (`compileUpdateGuard`):
    // an existing node the context cannot update is left untouched and the
    // call returns null, as a direct `update` matches 0 rows. Pre-2.6.1
    // only the WITH CHECK ran, so any existing node could be rewritten.
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
    // v2.10.1 — `labels` naming another declared type: the node is created
    // as that type too, so its `create` policies apply (default deny + WITH
    // CHECK on the `create` input). In default mode the labels also go on
    // the EXISTING node the MERGE matches (see `labelsOnMatchedNodes`),
    // which may carry further labels: its WITH CHECK runs on the `update`
    // input, and the matched node must also pass the root `read` filter
    // (`compileRelabelGuard`) — it becomes reachable through that type's
    // model. Strict mode puts the labels in ON CREATE SET only.
    const relabelsMatched = !this.strictMode.strict;
    const labelTypes = addedLabelTypes(
      this.schema,
      this.nodeDef,
      params.labels,
      !relabelsMatched,
    );
    const labelInputs = [params.create as Record<string, unknown>];
    if (relabelsMatched)
      labelInputs.push(params.update as Record<string, unknown>);
    const labelPolicies = evaluateLabelCreatePolicies(
      createPolicy,
      this.nodeDef,
      labelTypes,
      labelInputs,
      'upsert',
    );

    // Shared counter so the update guard's and the selection's params don't
    // collide with anything already in mergeParams.
    const paramCounter = { count: 0 };
    const { cypher, params: mergeParams } = this.mutationCompiler.compileMerge(
      params.where as Record<string, unknown>,
      params.create as Record<string, unknown>,
      params.update as Record<string, unknown>,
      this.nodeDef,
      params.labels,
      this.compileRelabelGuard(
        updatePolicy,
        paramCounter,
        ['__matched'],
        relabelsMatched && labelTypes.length > 0,
        labelPolicies,
      ),
    );

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
        false,
        labelPolicies,
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
    // v2.10.1 — `labels` naming another declared type: every node is
    // created as that type too, so its `create` policies apply to each item
    // (default deny + WITH CHECK), as for a nested create. With
    // skipDuplicates in default mode the labels also go on the EXISTING
    // nodes the MERGE matches, which may carry further labels (any shared
    // label counts); otherwise the created nodes' label set is known.
    const relabelsMatched =
      Boolean(params.skipDuplicates) && !this.strictMode.strict;
    const labelTypes = addedLabelTypes(
      this.schema,
      this.nodeDef,
      params.labels,
      !relabelsMatched,
    );
    const labelPolicies = evaluateLabelCreatePolicies(
      policyContext,
      this.nodeDef,
      labelTypes,
      params.data as unknown as Record<string, unknown>[],
      'createMany',
    );

    // v2.6.1 — with skipDuplicates, default-mode `labels` are also SET on
    // the EXISTING nodes the MERGE matches: a label change, gated by the
    // `update` row filter as `setLabels` is. Pre-2.6.1 every matched node
    // was relabelled. No compile-time throw: the call is a create, and a
    // context without an update permissive simply relabels no matched node.
    // (`policyContext` is null exactly when no policy is bound or a bypass
    // is active, so the update bundle is resolved only when it can apply.)
    // v2.10.1 — a matched node relabelled into another declared type must
    // also pass the root `read` filter (`compileRelabelGuard`).
    const updateGuard =
      policyContext &&
      params.skipDuplicates &&
      params.labels &&
      params.labels.length > 0
        ? this.compileRelabelGuard(
            this.resolvePolicyContext('update', params.unsafe),
            { count: 0 },
            [],
            relabelsMatched && labelTypes.length > 0,
            labelPolicies,
          )
        : undefined;
    const { cypher, params: mutParams } =
      this.mutationCompiler.compileCreateMany(
        params.data as Record<string, unknown>[],
        this.nodeDef,
        params.skipDuplicates,
        params.labels,
        updateGuard,
      );

    const result = await this.executor.execute(
      cypher,
      mutParams,
      this.withAuditMetadata(
        params.context,
        policyContext,
        'create',
        Boolean(params.unsafe?.bypassPolicies),
        false,
        labelPolicies,
      ),
    );
    // v2.5.0 — with skipDuplicates the MERGE row count includes the
    // existing nodes it matched, so the count comes from the write counters:
    // the nodes actually created, as Prisma returns. Pre-2.5.0 it was
    // `count(n)`, which counted skipped duplicates too.
    if (params.skipDuplicates)
      return { count: result.summary.counters.updates().nodesCreated };
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
    assertNestedUpdatesAllowed(
      this.schema,
      this.nodeDef,
      params.data as Record<string, unknown> | undefined,
      policyContext,
    );

    const compile = (guardDeleted: boolean) => {
      const paramCounter = { count: 0 };
      const whereResult = this.whereCompiler.compile(
        params.where,
        'n',
        this.nodeDef,
        paramCounter,
        policyContext ? { policyContext } : undefined,
      );

      return this.mutationCompiler.compileUpdate(
        params.where ?? {},
        params.data as Record<string, unknown>,
        undefined, // no connect
        undefined, // no disconnect
        this.nodeDef,
        whereResult,
        params.labels,
        'count',
        // `data` may still carry nested connect/disconnect ops, so thread the
        // policy bundle + shared counter for target `read` enforcement.
        policyContext ?? undefined,
        paramCounter,
        guardDeleted,
      );
    };

    const result = await this.executeUpdate(
      compile,
      params.context,
      'updateMany',
      (context) =>
        this.withAuditMetadata(
          context,
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
    const labelFilters: string[] = [`n:${nodeLabelExpr(this.nodeDef)}`];
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
    // v2.6.0 — strict mode parses some selectionSets differently, and this
    // cache is shared by every OGM, so strict entries get their own key.
    // Default-mode keys are unchanged.
    const cacheKey = this.strictMode.strict ? `strict\u0000${selStr}` : selStr;
    const cached = Model._selectionCache.get(cacheKey);
    if (cached) {
      this.selectionCompiler.replayParseWarnings(cached);
      return cached;
    }
    const parsed = this.selectionCompiler.parseSelectionSet(selStr);
    if (Model._selectionCache.size < 500)
      Model._selectionCache.set(cacheKey, parsed);
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
    // v2.6.3 — selectionSet field names are checked against the schema
    // (#23): strict throws on an unknown field, 2.x warns.
    const parsed = params.selectionSet
      ? this.parseSelectionSetCached(params.selectionSet)
      : this._parsedSelection;
    if (parsed) {
      this.selectionCompiler.assertKnownFields(parsed, this.nodeDef);
      return parsed;
    }
    return this.defaultSelection();
  }

  // --- Private helpers ------------------------------------------------------

  /**
   * Root `'create'` checks (default-deny + WITH CHECK) — shared with every
   * nested create via `src/policy/nested-writes.ts`.
   */
  private evaluateCreatePolicies(
    bundle: PolicyContextBundle | null,
    inputs: TCreateInput[],
  ): void {
    evaluateCreatePolicies(
      bundle,
      this.nodeDef.typeName,
      inputs as unknown as Record<string, unknown>[],
    );
  }

  /**
   * Root WITH CHECK for create/update input — shared with every nested
   * write via `src/policy/nested-writes.ts`.
   */
  private evaluateWriteRestrictives(
    bundle: PolicyContextBundle | null,
    operation: Operation,
    input: Record<string, unknown> | undefined,
  ): void {
    evaluateWriteRestrictives(bundle, this.nodeDef.typeName, operation, input);
  }

  /**
   * v2.6.1 — the root `update` row filter on `n`, for a MERGE-based write
   * (upsert, createMany with skipDuplicates) to apply to the nodes it
   * MATCHES. The same clause a direct `update` puts in its WHERE
   * (permissives OR-ed, restrictives AND-ed, `false` when no permissive
   * applies). `undefined` when no policy is bound, a bypass is active, the
   * type has no `update` policy or an override fires — the MERGE is then
   * compiled exactly as before.
   */
  private compileUpdateGuard(
    bundle: PolicyContextBundle | null,
    paramCounter: { count: number },
    preserveVars: ReadonlyArray<string> = [],
  ): MatchGuard | undefined {
    if (!bundle) return undefined;
    const guard = this.whereCompiler.compile(
      undefined,
      'n',
      this.nodeDef,
      paramCounter,
      { policyContext: bundle, preserveVars },
    );
    return guard.cypher ? guard : undefined;
  }

  /**
   * v2.10.1 — the matched-node guard of a MERGE-based write whose runtime
   * `labels` put the EXISTING node it matches into another declared type
   * (`src/policy/labels.ts`): the root `update` row filter
   * (`compileUpdateGuard`) AND the root `read` row filter — the node
   * becomes reachable through that type's model, so the context must be
   * able to see it through this one. Both compile into one `@cypher`
   * scope, so their preludes form a single WITH chain. The `read`
   * policies that applied are appended to `evaluated` (audit metadata).
   * Without `requireRead` this is exactly `compileUpdateGuard`.
   */
  private compileRelabelGuard(
    bundle: PolicyContextBundle | null,
    paramCounter: { count: number },
    preserveVars: ReadonlyArray<string>,
    requireRead: boolean,
    evaluated: string[],
  ): MatchGuard | undefined {
    if (!bundle || !requireRead)
      return this.compileUpdateGuard(bundle, paramCounter, preserveVars);
    const readBundle = targetBundle(bundle, this.nodeDef.typeName, 'read');
    this.assertNotDeniedAtCompile(readBundle, 'read');
    const scope = new CypherFieldScope('n', preserveVars, '__where');
    const update = this.whereCompiler.compile(
      undefined,
      'n',
      this.nodeDef,
      paramCounter,
      { policyContext: bundle, scope },
    );
    const read = this.whereCompiler.compile(
      undefined,
      'n',
      this.nodeDef,
      paramCounter,
      { policyContext: readBundle, scope },
    );
    evaluated.push(...readBundle.resolved.evaluated);
    const clauses = [update.cypher, read.cypher].filter(Boolean);
    if (clauses.length === 0) return undefined;
    const params: Record<string, unknown> = {};
    mergeParams(params, update.params);
    mergeParams(params, read.params);
    const guard: MatchGuard = {
      cypher:
        clauses.length === 1
          ? clauses[0]
          : clauses.map((c) => `(${c})`).join(' AND '),
      params,
    };
    if (scope.hasAny()) guard.preludes = scope.emit();
    return guard;
  }

  /**
   * v2.10.1 — AND the label-change guards of `setLabels` into its compiled
   * MATCH filter (`src/policy/labels.ts`):
   *
   * - `requireRead` (a declared type's label is ADDED): the root `read`
   *   row filter — `PolicyDeniedError` before compile under
   *   `onDeny: 'throw'` when no read permissive applies;
   * - for every type in `leftTypes` (a label it carries is REMOVED): its
   *   `delete` row filter, as `(NOT n:<type labels> OR <clause>)` — the
   *   root's own clause as is — with the direct delete's compile-time
   *   default deny under `onDeny: 'throw'`. A `delete` policy that needs a
   *   `@cypher` projection is rejected, as in nested-write target filters.
   *
   * `whereResult` was compiled into `scope` (root `update` filter); the
   * read guard joins the same scope and the chain is emitted once. The
   * policies that applied are appended to `evaluated` (audit metadata).
   */
  private applyLabelChangeGuards(
    whereResult: {
      cypher: string;
      params: Record<string, unknown>;
      preludes?: string[];
    },
    bundle: PolicyContextBundle,
    requireRead: boolean,
    leftTypes: ReadonlyArray<NodeDefinition>,
    paramCounter: { count: number },
    scope: CypherFieldScope,
    evaluated: string[],
  ): void {
    const guards: string[] = [];
    if (requireRead) {
      const readBundle = targetBundle(bundle, this.nodeDef.typeName, 'read');
      this.assertNotDeniedAtCompile(readBundle, 'read');
      const read = this.whereCompiler.compile(
        undefined,
        'n',
        this.nodeDef,
        paramCounter,
        { policyContext: readBundle, scope },
      );
      if (read.cypher) {
        guards.push(read.cypher);
        mergeParams(whereResult.params, read.params);
      }
      evaluated.push(...readBundle.resolved.evaluated);
    }
    for (const def of leftTypes) {
      const resolved = bundle.resolveForType(def.typeName, 'delete');
      if (!resolved || resolved.overridden) continue;
      if (
        bundle.defaults.onDeny === 'throw' &&
        resolved.permissives.length === 0
      )
        throw new PolicyDeniedError({
          typeName: def.typeName,
          operation: 'delete',
          reason: 'no-permissive-matched',
        });
      const clause = this.whereCompiler.compileTargetPolicyClause(
        def.typeName,
        'n',
        'delete',
        bundle,
        paramCounter,
      );
      if (clause.preludes.length > 0)
        throw new OGMError(
          `Policy on "${def.typeName}" requires @cypher field projection, which is not supported ` +
            `in the label guard of setLabels. Refactor the policy to use stored properties.`,
        );
      if (clause.cypher === null) continue;
      mergeParams(whereResult.params, clause.params);
      evaluated.push(...resolved.evaluated);
      guards.push(
        def.typeName === this.nodeDef.typeName
          ? clause.cypher
          : `NOT n:${getTargetLabelString(def)} OR ${clause.cypher}`,
      );
    }
    if (guards.length > 0) {
      const extra = guards.map((g) => `(${g})`).join(' AND ');
      whereResult.cypher = whereResult.cypher
        ? `(${whereResult.cypher}) AND ${extra}`
        : extra;
    }
    if (scope.hasAny()) whereResult.preludes = scope.emit();
  }

  private defaultSelection(): SelectionNode[] {
    if (this._defaultSelection) return this._defaultSelection;
    // v1.8.4 — `__typename` is always emitted in default projections to
    // match `@neo4j/graphql-ogm` behaviour. Apollo Client cache
    // normalisation, type-discriminated unions in TS callers, and any
    // consumer that uses `__typename` as a discriminator depend on it
    // being present. SelectionCompiler resolves the field by checking
    // the schema (line 164 of selection.compiler.ts) — for concrete
    // types it emits the constant string, for unions/interfaces it
    // emits a `head([... labels(n) ...])` expression.
    //
    // Pre-1.8.4, `__typename` was auto-emitted only on abstract
    // targets (relationships pointing at unions/interfaces). Concrete
    // top-level reads got back raw scalar properties without it.
    const nodes: SelectionNode[] = [
      {
        fieldName: '__typename',
        isScalar: true,
        isRelationship: false,
        isConnection: false,
      },
    ];
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
   * Swap the trailing `RETURN n` of a mutation/upsert statement for the
   * projected RETURN, stitching any `@cypher` CALL preludes in front of it.
   *
   * A `CALL { ... }` subquery may not directly follow an updating clause
   * (`SET`, `CREATE`, `MERGE ... ON CREATE SET`) — Neo4j 5.x rejects it with
   * "WITH is required between SET and CALL" (newer servers relax this). The
   * leading `WITH n` closes the write part; `n` is the only variable the
   * projection reads, and the original tail was a bare `RETURN n`.
   */
  private stitchMutationProjection(
    cypher: string,
    selectScope: CypherFieldScope,
    returnClause: string,
  ): string {
    const replacement = selectScope.hasAny()
      ? `WITH n\n${selectScope.emit().join('\n')}\nRETURN ${returnClause}`
      : `RETURN ${returnClause}`;
    return cypher.replace(/RETURN n\s*$/, replacement);
  }

  /**
   * v2.6.1 — filter a mutation's returned rows by the root type's `read`
   * policy: the write still happens, but a node the context cannot read
   * (in its post-write state) is not returned, as `find` would not return
   * it. Pre-2.6.1 create / update / upsert returned every node they wrote,
   * so a context allowed to update (or create) a node it could not read got
   * it back in full. Nested selections already applied their target read
   * policies; this adds the root.
   *
   * Inserts `WITH n [@cypher preludes] WHERE <read clause>` before the
   * trailing `RETURN n` (a WITH closes the write part, invariant 1; the
   * WHERE only drops rows, invariant 2). No-op — byte-identical — when no
   * policy is bound, a bypass is active, the type has no read policy or an
   * override fires.
   */
  private applyRootReadFilter(
    cypher: string,
    params: Record<string, unknown>,
    paramCounter: { count: number },
    policyContext: PolicyContextBundle | null,
  ): string {
    if (!policyContext) return cypher;
    const read = this.whereCompiler.compile(
      undefined,
      'n',
      this.nodeDef,
      paramCounter,
      { policyContext },
    );
    if (!read.cypher) return cypher;
    mergeParams(params, read.params);
    const lines = ['WITH n', ...(read.preludes ?? []), `WHERE ${read.cypher}`];
    // A replacer function: the clause holds `$param` text, which a
    // replacement STRING would scan for `$&`-style patterns.
    return cypher.replace(
      /RETURN n\s*$/,
      () => `${lines.join('\n')}\nRETURN n`,
    );
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
    cypher = this.applyRootReadFilter(
      cypher,
      params,
      paramCounter,
      policyContext,
    );
    let selection: SelectionNode[];

    if (selectionSet) {
      selection = this.parseSelectionSetCached(selectionSet);
      // v2.6.3 — `{ info { … } }` alone selects only the mutation
      // counters: its fields are not node fields, so they are not checked.
      let infoOnly = false;

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
        ) {
          infoOnly =
            outer.fieldName === 'info' &&
            outer.fieldName !== this.nodeDef.pluralName;
          selection = outer.children!;
        }
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
      // v2.6.3 — check the node fields (#23); a root `info` is allowed.
      if (!infoOnly)
        this.selectionCompiler.assertKnownFields(selection, this.nodeDef, true);
    } else
      // v1.8.4 — no selectionSet provided. Project via `defaultSelection`
      // (which now includes `__typename`) instead of bailing out and
      // leaving the bare `RETURN n`. Pre-1.8.4, the raw Node return
      // path produced `{ id, title, ... }` without `__typename`. The
      // projected path produces `{ __typename, id, title, ... }` —
      // additive change, same fields plus the GraphQL discriminator.
      selection = this.defaultSelection();

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

    return this.stitchMutationProjection(cypher, selectScope, returnClause);
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
    cypher = this.applyRootReadFilter(
      cypher,
      params,
      paramCounter,
      policyContext,
    );
    const entitySelect = select[this.nodeDef.pluralName];
    // v1.8.4 — when typed select doesn't request the entity field
    // (e.g., `select: { info: {...} }` only), pre-1.8.4 left a bare
    // `RETURN n` that produced raw Node properties. The response
    // builder dropped them anyway, but the wire still carried them.
    // Now we still bail (no entities expected → no projection needed)
    // since `buildSelectResult` won't surface the mapped rows in the
    // response. This branch is deliberately untouched — the
    // `__typename` requirement applies when the caller actually
    // receives entities.
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
    return this.stitchMutationProjection(cypher, selectScope, returnClause);
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
    cypher = this.applyRootReadFilter(
      cypher,
      params,
      paramCounter,
      policyContext,
    );
    // v1.8.4 — symmetric with `applySelectionSetToMutation`: project
    // via `defaultSelection()` (which includes `__typename`) when no
    // selectionSet is provided, instead of leaving the bare `RETURN n`.
    const selection = selectionSet
      ? this.parseSelectionSetCached(selectionSet)
      : this.defaultSelection();
    // v2.6.3 — check selectionSet field names (#23).
    if (selectionSet)
      this.selectionCompiler.assertKnownFields(selection, this.nodeDef);

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

    return this.stitchMutationProjection(cypher, selectScope, returnClause);
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
    cypher = this.applyRootReadFilter(
      cypher,
      params,
      paramCounter,
      policyContext,
    );
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
    return this.stitchMutationProjection(cypher, selectScope, returnClause);
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
type FieldAggregateCategory = 'numeric' | 'numericList' | 'temporal' | 'other';

function resolveFieldAggregateCategory(
  fieldName: string,
  nodeDef: NodeDefinition,
): FieldAggregateCategory {
  const prop = nodeDef.properties.get(fieldName);
  if (!prop) return 'other';
  if (prop.type === 'Int' || prop.type === 'Float')
    // v2.6.0 — an `[Int]` / `[Float]` list has no avg / sum: the server
    // rejects `avg(n.list)`, which failed the whole aggregate query.
    return prop.isArray ? 'numericList' : 'numeric';
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
