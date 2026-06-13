/* eslint-disable @typescript-eslint/no-explicit-any */

import { Driver, Transaction } from 'neo4j-driver';
import { FulltextCompiler } from './compilers/fulltext.compiler';
import { MutationCompiler } from './compilers/mutation.compiler';
import { SelectNormalizer } from './compilers/select-normalizer';
import { SelectionCompiler } from './compilers/selection.compiler';
import { VectorCompiler } from './compilers/vector.compiler';
import {
  WhereCompiler,
  WhereCompilerOptions,
} from './compilers/where.compiler';
import { OGMError } from './errors';
import { Executor, OGMLogger } from './execution/executor';
import { ResultMapper } from './execution/result-mapper';
import { InterfaceModel, InterfaceModelCompilers } from './interface-model';
import {
  FulltextInput,
  Model,
  ModelCompilers,
  ModelPolicyBinding,
} from './model';
import { PolicyResolver } from './policy/resolver';
import type {
  PoliciesByModel,
  Policy,
  PolicyContext,
  PolicyDefaults,
} from './policy/types';
import {
  buildNodeFulltextStatements,
  buildRelationshipFulltextStatements,
  buildUniqueConstraintStatements,
} from './schema/index-statements';
import { parseSchema } from './schema/parser';
import { SchemaMetadata } from './schema/types';
import { clearResolveTargetDefCache } from './schema/utils';
import { cloneSubgraph, deleteSubgraph } from './subgraph/subgraph-operations';
import {
  SubgraphCloneResult,
  SubgraphConfig,
  SubgraphDeleteResult,
} from './subgraph/types';
import { deepFreezeSnapshot } from './utils/deep-freeze';

const POLICY_SET_VERSION = '1.7.0-beta.0';

export interface OGMConfig<
  M extends Record<string, unknown> = Record<string, unknown>,
  C extends PolicyContext = PolicyContext,
> {
  typeDefs: string;
  driver: Driver;
  logger?: OGMLogger;
  features?: {
    filters?: { String?: { MATCHES?: boolean } };
    /**
     * Reject `where` filters that reference a field name not declared
     * on the target type. Default: `false` (preserves pre-1.7.5
     * behaviour where typo'd field names compiled to
     * `n.<typo> = $param` against a non-existent property → empty
     * result silently). When `true`, the where compiler throws
     * `OGMError` on the first unknown field, surfacing the bug at
     * the call site instead of in the result. Recommended for new
     * codebases; opt-in for existing ones to avoid breaking queries
     * that happened to rely on the silent behaviour.
     */
    strictWhere?: boolean;
  };
  /**
   * Map of typeName → policies. Validated against the schema at init.
   *
   * Each entry's policies fire for that exact type AND for any concrete
   * type that implements an interface with the same key. See the v1.7.0
   * inheritance rule (AND-restrictive, OR-permissive).
   */
  policies?: PoliciesByModel<M, C>;
  /** Defaults applied to every policy decision. */
  policyDefaults?: PolicyDefaults;
}

export class OGM<
  TModelMap extends Record<string, unknown> = Record<string, unknown>,
  TInterfaceModelMap extends Record<string, unknown> = Record<string, unknown>,
> {
  private config: OGMConfig<TModelMap>;
  private schema!: SchemaMetadata;
  private models: Map<string, Model<unknown>> = new Map();
  private interfaceModels: Map<string, InterfaceModel<unknown>> = new Map();
  private modelCompilers!: ModelCompilers;
  private interfaceModelCompilers!: InterfaceModelCompilers;
  private policyRegistry: ReadonlyMap<string, ReadonlyArray<Policy>>;
  private policyResolver: PolicyResolver;
  private policyDefaults: PolicyDefaults;
  /** Marker for `unsafe.bypassPolicies()` clones. */
  private globalBypass = false;

  constructor(config: OGMConfig<TModelMap>) {
    this.config = config;
    // Parse schema synchronously so model() works before init()
    this.schema = parseSchema(this.config.typeDefs);

    const whereOptions: WhereCompilerOptions = {};
    if (config.features?.filters?.String?.MATCHES === false)
      whereOptions.disabledOperators = new Set(['_MATCHES'] as const);
    if (config.features?.strictWhere === true) whereOptions.strictWhere = true;

    const where = new WhereCompiler(this.schema, whereOptions);
    const selection = new SelectionCompiler(this.schema, where);
    const fulltext = new FulltextCompiler(this.schema);
    const vector = new VectorCompiler();

    this.modelCompilers = {
      where,
      selection,
      selectNormalizer: new SelectNormalizer(this.schema),
      mutation: new MutationCompiler(this.schema),
      fulltext,
      vector,
    };

    this.interfaceModelCompilers = {
      where,
      selection,
      fulltext,
    };

    // Build the policy registry and validate against the schema. An OGM
    // configured WITHOUT policies builds an empty registry — all model
    // calls take the v1.6.0 byte-identical fast path (no resolution work).
    const registry = new Map<string, ReadonlyArray<Policy>>();
    if (config.policies)
      for (const [typeName, policies] of Object.entries(config.policies)) {
        if (!policies || policies.length === 0) continue;
        if (
          !this.schema.nodes.has(typeName) &&
          !this.schema.interfaces.has(typeName)
        )
          throw new OGMError(
            `OGMConfig.policies references unknown type "${typeName}". ` +
              `Allowed: any node or interface name in the typeDefs.`,
          );
        registry.set(typeName, policies as ReadonlyArray<Policy>);
      }

    this.policyRegistry = registry;
    this.policyResolver = new PolicyResolver(registry, this.schema);
    this.policyDefaults = {
      onDeny: config.policyDefaults?.onDeny ?? 'empty',
      auditMetadata: config.policyDefaults?.auditMetadata ?? true,
    };

    // Surface a runtime warning when an interface has policies registered
    // but one or more of its implementers do NOT. The CASE-per-label
    // emission in `InterfaceModel.find()` falls back to interface-only
    // enforcement on those branches (see CHANGELOG "Known limits"); a
    // missing implementer policy is therefore semantically meaningful
    // and should not pass silently. Users who intend that behavior can
    // suppress the warning by registering an explicit empty policy
    // array on the implementer or by registering a permissive that
    // mirrors the interface.
    if (registry.size > 0 && config.logger?.warn)
      for (const [typeName, policies] of registry) {
        const ifaceDef = this.schema.interfaces.get(typeName);
        if (!ifaceDef) continue;
        if (!policies || policies.length === 0) continue;
        const missing: string[] = [];
        for (const impl of ifaceDef.implementedBy)
          if (!registry.has(impl)) missing.push(impl);
        if (missing.length > 0)
          config.logger.warn(
            '[OGM] interface "%s" has policies but implementer(s) %s have no registered policies. ' +
              'InterfaceModel queries will fall back to interface-level enforcement only on those branches. ' +
              'If this is intentional, register an explicit empty policy array on each implementer.',
            typeName,
            missing.map((m) => `"${m}"`).join(', '),
          );
      }
  }

  /** Internal cloning hook used by `unsafe.bypassPolicies()`. */
  private cloneAsBypassed(): OGM<TModelMap, TInterfaceModelMap> {
    const clone = Object.create(OGM.prototype) as OGM<
      TModelMap,
      TInterfaceModelMap
    >;
    Object.assign(clone, this);
    (clone as unknown as { models: Map<string, unknown> }).models = new Map();
    (
      clone as unknown as { interfaceModels: Map<string, unknown> }
    ).interfaceModels = new Map();
    (clone as unknown as { globalBypass: boolean }).globalBypass = true;
    return clone;
  }

  /**
   * Vend a `Model` augmented with the per-request `ctx`. The returned
   * surface mirrors `OGM.model(name)` exactly — Models constructed via
   * `withContext` share the OGM's compilers and resolver but carry a
   * frozen `ctx` snapshot used in every policy decision.
   *
   * Discard the returned wrapper after the request finishes — it must
   * NOT outlive the ctx.
   */
  withContext<C extends PolicyContext>(
    ctx: C,
  ): OGMWithContext<TModelMap, TInterfaceModelMap, C> {
    if (typeof ctx !== 'object' || ctx === null)
      throw new OGMError('withContext: ctx must be a non-null object.');
    return new OGMWithContext<TModelMap, TInterfaceModelMap, C>({
      schema: this.schema,
      driver: this.config.driver,
      compilers: this.modelCompilers,
      interfaceCompilers: this.interfaceModelCompilers,
      logger: this.config.logger,
      // v1.8.7 — deep snapshot, not shallow freeze. `Object.freeze({
      // ...ctx })` left nested ctx state (`ctx.user.roles`) mutable, so
      // a policy callback could escalate the context seen by every
      // subsequent policy decision in the same request.
      ctx: deepFreezeSnapshot({ ...ctx }) as C,
      resolver: this.policyResolver,
      defaults: this.policyDefaults,
      globalBypass: this.globalBypass,
    });
  }

  /**
   * Escape hatches for opting OUT of policy enforcement. Use sparingly
   * and only at well-audited boundaries (data migrations, admin scripts,
   * explicit cross-tenant tooling).
   */
  readonly unsafe = {
    /**
     * Returns an OGM identical to the current one but with all policies
     * disabled. Logs a warning on every call. Discard immediately after
     * the bypass operation completes.
     */
    bypassPolicies: (): OGM<TModelMap, TInterfaceModelMap> => {
      if (this.config.logger?.warn)
        this.config.logger.warn('[OGM] unsafe.bypassPolicies invoked');
      return this.cloneAsBypassed();
    },
  };

  /** Internal: expose the resolver for the wrapper. */
  _internalResolver(): PolicyResolver {
    return this.policyResolver;
  }

  /** Internal: expose defaults for the wrapper. */
  _internalDefaults(): PolicyDefaults {
    return this.policyDefaults;
  }

  /** Internal: expose registry for tests. */
  _internalPolicyRegistry(): ReadonlyMap<string, ReadonlyArray<Policy>> {
    return this.policyRegistry;
  }

  async init(): Promise<void> {
    // Schema is already parsed in constructor.
    // init() is kept for backward compatibility and for any future async setup.
  }

  async assertIndexesAndConstraints(options?: {
    options?: { create?: boolean };
  }): Promise<void> {
    if (!options?.options?.create) return;

    // v1.9.0 — statement generation extracted to schema/index-statements.ts
    // (shared with the CLI's `db push` planner). Statement text and
    // execution order are byte-identical to the pre-extraction inline
    // version: node fulltext, relationship fulltext, unique constraints.
    const statements = [
      ...buildNodeFulltextStatements(this.schema),
      ...buildRelationshipFulltextStatements(this.schema),
      ...buildUniqueConstraintStatements(this.schema),
    ];

    const session = this.config.driver.session();
    try {
      for (const statement of statements) await session.run(statement.cypher);
    } finally {
      await session.close();
    }
  }

  model<K extends string & keyof TModelMap>(
    name: K,
  ): Model<
    TModelMap[K] extends { Type: infer T } ? T : Record<string, unknown>,
    TModelMap[K] extends {
      SelectFields: infer S extends Record<string, unknown>;
    }
      ? S
      : Record<string, unknown>,
    TModelMap[K] extends { Where: infer W extends Record<string, unknown> }
      ? W
      : Record<string, unknown>,
    TModelMap[K] extends {
      CreateInput: infer C extends Record<string, unknown>;
    }
      ? C
      : Record<string, unknown>,
    TModelMap[K] extends {
      UpdateInput: infer U extends Record<string, unknown>;
    }
      ? U
      : Record<string, unknown>,
    TModelMap[K] extends {
      ConnectInput: infer Co extends Record<string, unknown>;
    }
      ? Co
      : Record<string, unknown>,
    TModelMap[K] extends {
      DisconnectInput: infer D extends Record<string, unknown>;
    }
      ? D
      : Record<string, unknown>,
    TModelMap[K] extends {
      DeleteInput: infer De extends Record<string, unknown>;
    }
      ? De
      : Record<string, unknown>,
    TModelMap[K] extends {
      PluralKey: infer PK extends string;
    }
      ? PK
      : string,
    TModelMap[K] extends {
      MutationSelectFields: infer MS extends Record<string, unknown>;
    }
      ? MS
      : Record<string, unknown>,
    TModelMap[K] extends { Sort: infer So }
      ? So
      : Record<string, 'ASC' | 'DESC'>,
    TModelMap[K] extends { Fulltext: infer F } ? F : FulltextInput
  >;
  /** @deprecated Legacy overload for backward compatibility with @neo4j/graphql-ogm. Use the single-generic overload instead. */
  model<_T, K extends string>(
    name: K,
  ): Model<any, any, any, any, any, any, any, any, any, any, any, any>;
  model<T = Record<string, unknown>>(
    name: string,
  ): Model<T, any, any, any, any, any, any, any, any, any, any, any>;
  model(
    name: string,
  ): Model<any, any, any, any, any, any, any, any, any, any, any, any> {
    const existing = this.models.get(name);
    if (existing) return existing;

    const nodeDef = this.schema.nodes.get(name);
    if (nodeDef) {
      // OGM.model() (no withContext) NEVER attaches a policy binding —
      // it preserves byte-identical Cypher with v1.6.0 for callers
      // who haven't opted into NLS. The bypassed clone explicitly
      // attaches a globalBypass binding so the unsafe.bypassPolicies
      // logger warning fires on every per-method call.
      const policyBinding = this.globalBypass
        ? ({
            ctx: {} as PolicyContext,
            resolve: () => null,
            defaults: this.policyDefaults,
            logger: this.config.logger,
            globalBypass: true,
            policySetVersion: POLICY_SET_VERSION,
          } satisfies ModelPolicyBinding)
        : undefined;

      const model = new Model(
        nodeDef,
        this.schema,
        this.config.driver,
        this.modelCompilers,
        this.config.logger,
        policyBinding,
      );
      this.models.set(name, model as Model<unknown>);
      return model;
    }

    // v1.8.3 fix — pre-1.8.3, when `name` matched an interface (not a
    // node), this method silently returned an `InterfaceModel` cast to
    // `any`. The TypeScript signature on `model<K>(name)` promised a
    // `Model<T>` with full CRUD, but the runtime delivered an
    // `InterfaceModel` whose mutation methods (create/update/delete/
    // upsert/setLabels) throw at the prototype level. The first
    // mutation call from typed code thus failed with
    // `TypeError: this.create is not a function` — a confusing crash
    // that pointed at the call site instead of the misnamed lookup.
    //
    // We now throw an OGMError immediately, naming both the mistake and
    // the correct API. `interfaceModel(name)` was always the right
    // entry point for read-only queries spanning all implementing types.
    const interfaceDef = this.schema.interfaces.get(name);
    if (interfaceDef)
      throw new OGMError(
        `"${name}" is an interface, not a node type. Use ` +
          `\`ogm.interfaceModel('${name}')\` instead. ` +
          `model() returns Model<T> with full CRUD; interfaceModel() ` +
          `returns InterfaceModel<T> with read-only queries that span ` +
          `all implementing types.`,
      );

    throw new OGMError(
      `Unknown type: ${name}. Not found in nodes or interfaces.`,
    );
  }

  interfaceModel<K extends string & keyof TInterfaceModelMap>(
    name: K,
  ): InterfaceModel<
    TInterfaceModelMap[K] extends { Type: infer T }
      ? T
      : Record<string, unknown>,
    TInterfaceModelMap[K] extends { Where: infer W }
      ? W
      : Record<string, unknown>,
    TInterfaceModelMap[K] extends { Sort: infer So }
      ? So
      : Record<string, 'ASC' | 'DESC'>
  >;
  interfaceModel<T = Record<string, unknown>>(name: string): InterfaceModel<T>;
  interfaceModel(name: string): InterfaceModel<any, any, any> {
    const existing = this.interfaceModels.get(name);
    if (existing) return existing as InterfaceModel<any, any, any>;

    const interfaceDef = this.schema.interfaces.get(name);
    if (!interfaceDef) throw new OGMError(`Unknown interface type: ${name}`);

    const model = new InterfaceModel(
      interfaceDef,
      this.schema,
      this.config.driver,
      this.interfaceModelCompilers,
    );
    this.interfaceModels.set(name, model as InterfaceModel<unknown>);
    return model;
  }

  /**
   * Clear all internal caches and release model references.
   * Call when disposing the OGM instance (e.g., in tests or module teardown).
   */
  close(): void {
    this.models.clear();
    this.interfaceModels.clear();
    this.modelCompilers.mutation.clearCaches();
    this.modelCompilers.selection.clearCache();
    this.modelCompilers.selectNormalizer.clearCache();
    Model.clearSelectionCache();
    clearResolveTargetDefCache();
  }

  // --- $queryRaw / $executeRaw -----------------------------------------------

  /**
   * Execute a raw Cypher query and return mapped results.
   * Uses OGM-managed sessions with debug logging.
   */
  async $queryRaw<T = Record<string, unknown>>(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    if (Executor.debug && this.config.logger) {
      this.config.logger.debug('[OGM $queryRaw] Cypher: %s', cypher);
      this.config.logger.debug(
        '[OGM $queryRaw] Params: %s',
        JSON.stringify(params, null, 2),
      );
    }

    const session = this.config.driver.session();
    try {
      const result = await session.run(cypher, params);
      return ResultMapper.mapRecords(result.records) as T[];
    } finally {
      await session.close();
    }
  }

  /**
   * Execute a raw Cypher write operation and return affected counts.
   * Uses OGM-managed sessions with debug logging.
   */
  async $executeRaw(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<{ recordsAffected: number }> {
    if (Executor.debug && this.config.logger) {
      this.config.logger.debug('[OGM $executeRaw] Cypher: %s', cypher);
      this.config.logger.debug(
        '[OGM $executeRaw] Params: %s',
        JSON.stringify(params, null, 2),
      );
    }

    const session = this.config.driver.session();
    try {
      const result = await session.run(cypher, params);
      const counters = result.summary.counters.updates();
      const recordsAffected =
        (counters.nodesCreated ?? 0) +
        (counters.nodesDeleted ?? 0) +
        (counters.relationshipsCreated ?? 0) +
        (counters.relationshipsDeleted ?? 0) +
        (counters.propertiesSet ?? 0);
      return { recordsAffected };
    } finally {
      await session.close();
    }
  }

  // --- $transaction ----------------------------------------------------------

  /**
   * Execute a callback within a Neo4j transaction.
   * Automatically commits on success and rolls back on error.
   * The callback receives an `ExecutionContext` to pass into model methods.
   *
   * Overloads:
   * - Callback: `$transaction(async (ctx) => { ... })` — interactive transaction
   * - Sequential: `$transaction([(ctx) => op1(ctx), (ctx) => op2(ctx)])` — array of operations
   */
  async $transaction<R>(
    fn: (ctx: { transaction: Transaction }) => Promise<R>,
  ): Promise<R>;
  async $transaction<T extends unknown[]>(operations: {
    [K in keyof T]: (ctx: { transaction: Transaction }) => Promise<T[K]>;
  }): Promise<T>;
  async $transaction<R>(
    fnOrOps:
      | ((ctx: { transaction: Transaction }) => Promise<R>)
      | Array<(ctx: { transaction: Transaction }) => Promise<unknown>>,
  ): Promise<R | unknown[]> {
    const session = this.config.driver.session();
    const tx = session.beginTransaction();
    try {
      let result: R | unknown[];
      if (Array.isArray(fnOrOps)) {
        // Sequential: execute each operation in order within the same tx
        const results: unknown[] = [];
        const ctx = { transaction: tx };
        for (const op of fnOrOps) results.push(await op(ctx));

        result = results;
      } else result = await fnOrOps({ transaction: tx });

      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      await session.close();
    }
  }

  // --- $cloneSubgraph / $deleteSubgraph -----------------------------------------

  /**
   * Clone a content subgraph rooted at the given source node.
   *
   * If a `transaction` is provided, uses it directly (caller manages commit/rollback).
   * Otherwise opens a session and transaction internally; commits on success, rolls back on error.
   */
  async $cloneSubgraph(
    sourceRootId: string,
    config: SubgraphConfig,
    transaction?: Transaction,
  ): Promise<SubgraphCloneResult> {
    if (transaction)
      return cloneSubgraph(
        sourceRootId,
        config,
        transaction,
        this.config.logger,
      );

    const session = this.config.driver.session();
    const tx = session.beginTransaction();
    try {
      const result = await cloneSubgraph(
        sourceRootId,
        config,
        tx,
        this.config.logger,
      );
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Delete a content subgraph rooted at the given node.
   *
   * If a `transaction` is provided, uses it directly (caller manages commit/rollback).
   * Otherwise opens a session and transaction internally; commits on success, rolls back on error.
   */
  async $deleteSubgraph(
    rootId: string,
    config: SubgraphConfig,
    transaction?: Transaction,
  ): Promise<SubgraphDeleteResult> {
    if (transaction)
      return deleteSubgraph(rootId, config, transaction, this.config.logger);

    const session = this.config.driver.session();
    const tx = session.beginTransaction();
    try {
      const result = await deleteSubgraph(
        rootId,
        config,
        tx,
        this.config.logger,
      );
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      await session.close();
    }
  }
}

/**
 * Per-request wrapper around an `OGM` that injects `ctx` into every
 * `model(name)` call. Hand-rolled (not a Proxy) for explicit type
 * inference. Each `model(name)` call returns a NEW `Model` instance
 * carrying a `policyBinding` keyed on this wrapper's frozen ctx.
 */
export class OGMWithContext<
  TModelMap extends Record<string, unknown> = Record<string, unknown>,
  TInterfaceModelMap extends Record<string, unknown> = Record<string, unknown>,
  C extends PolicyContext = PolicyContext,
> {
  private readonly schema: SchemaMetadata;
  private readonly driver: Driver;
  private readonly compilers: ModelCompilers;
  private readonly interfaceCompilers: InterfaceModelCompilers;
  private readonly logger: OGMLogger | undefined;
  private readonly ctx: C;
  private readonly resolver: PolicyResolver;
  private readonly defaults: PolicyDefaults;
  private readonly globalBypass: boolean;
  private readonly cache = new Map<string, Model<unknown>>();
  private readonly interfaceCache = new Map<string, InterfaceModel<unknown>>();

  constructor(args: {
    schema: SchemaMetadata;
    driver: Driver;
    compilers: ModelCompilers;
    interfaceCompilers: InterfaceModelCompilers;
    logger: OGMLogger | undefined;
    ctx: C;
    resolver: PolicyResolver;
    defaults: PolicyDefaults;
    globalBypass: boolean;
  }) {
    this.schema = args.schema;
    this.driver = args.driver;
    this.compilers = args.compilers;
    this.interfaceCompilers = args.interfaceCompilers;
    this.logger = args.logger;
    this.ctx = args.ctx;
    this.resolver = args.resolver;
    this.defaults = args.defaults;
    this.globalBypass = args.globalBypass;
  }

  model<K extends string & keyof TModelMap>(
    name: K,
  ): Model<
    TModelMap[K] extends { Type: infer T } ? T : Record<string, unknown>,
    TModelMap[K] extends {
      SelectFields: infer S extends Record<string, unknown>;
    }
      ? S
      : Record<string, unknown>,
    TModelMap[K] extends { Where: infer W extends Record<string, unknown> }
      ? W
      : Record<string, unknown>,
    TModelMap[K] extends {
      CreateInput: infer Cin extends Record<string, unknown>;
    }
      ? Cin
      : Record<string, unknown>,
    TModelMap[K] extends {
      UpdateInput: infer U extends Record<string, unknown>;
    }
      ? U
      : Record<string, unknown>,
    TModelMap[K] extends {
      ConnectInput: infer Co extends Record<string, unknown>;
    }
      ? Co
      : Record<string, unknown>,
    TModelMap[K] extends {
      DisconnectInput: infer D extends Record<string, unknown>;
    }
      ? D
      : Record<string, unknown>,
    TModelMap[K] extends {
      DeleteInput: infer De extends Record<string, unknown>;
    }
      ? De
      : Record<string, unknown>,
    TModelMap[K] extends {
      PluralKey: infer PK extends string;
    }
      ? PK
      : string,
    TModelMap[K] extends {
      MutationSelectFields: infer MS extends Record<string, unknown>;
    }
      ? MS
      : Record<string, unknown>,
    TModelMap[K] extends { Sort: infer So }
      ? So
      : Record<string, 'ASC' | 'DESC'>,
    TModelMap[K] extends { Fulltext: infer F } ? F : FulltextInput
  >;
  model<T = Record<string, unknown>>(
    name: string,
  ): Model<T, any, any, any, any, any, any, any, any, any, any, any>;
  model(
    name: string,
  ): Model<any, any, any, any, any, any, any, any, any, any, any, any> {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const nodeDef = this.schema.nodes.get(name);
    if (nodeDef) {
      const policyBinding: ModelPolicyBinding = {
        ctx: this.ctx as PolicyContext,
        resolve: (typeName, op, ctx) =>
          this.resolver.resolve(typeName, op, ctx),
        defaults: this.defaults,
        logger: this.logger,
        globalBypass: this.globalBypass,
        policySetVersion: POLICY_SET_VERSION,
      };
      const model = new Model(
        nodeDef,
        this.schema,
        this.driver,
        this.compilers,
        this.logger,
        policyBinding,
      );
      this.cache.set(name, model as Model<unknown>);
      return model;
    }

    // v1.8.7 — mirror of the v1.8.3 guard on `OGM.model()`. The context
    // wrapper kept the pre-1.8.3 fallthrough: an interface name returned
    // an `InterfaceModel` cast to `any`, so the first mutation call from
    // typed code crashed with `TypeError: this.create is not a function`.
    // Since the wrapper is the entry point every NLS consumer uses on
    // every request, it must enforce the same contract as the base OGM.
    const interfaceDef = this.schema.interfaces.get(name);
    if (interfaceDef)
      throw new OGMError(
        `"${name}" is an interface, not a node type. Use ` +
          `\`interfaceModel('${name}')\` on this context wrapper instead. ` +
          `model() returns Model<T> with full CRUD; interfaceModel() ` +
          `returns InterfaceModel<T> with read-only queries that span ` +
          `all implementing types.`,
      );

    throw new OGMError(
      `Unknown type: ${name}. Not found in nodes or interfaces.`,
    );
  }

  interfaceModel<K extends string & keyof TInterfaceModelMap>(
    name: K,
  ): InterfaceModel<
    TInterfaceModelMap[K] extends { Type: infer T }
      ? T
      : Record<string, unknown>,
    TInterfaceModelMap[K] extends { Where: infer W }
      ? W
      : Record<string, unknown>,
    TInterfaceModelMap[K] extends { Sort: infer So }
      ? So
      : Record<string, 'ASC' | 'DESC'>
  >;
  interfaceModel<T = Record<string, unknown>>(name: string): InterfaceModel<T>;
  interfaceModel(name: string): InterfaceModel<any, any, any> {
    // v1.8.7 — pre-1.8.7 this delegated through `model(name)`, relying on
    // the interface fallthrough removed above (and returning a `Model`
    // cast to `InterfaceModel` when handed a NODE name — the inverse type
    // lie). It now owns construction and mirrors the base
    // `OGM.interfaceModel()` contract: unknown or non-interface names
    // throw immediately.
    const existing = this.interfaceCache.get(name);
    if (existing) return existing as InterfaceModel<any, any, any>;

    const interfaceDef = this.schema.interfaces.get(name);
    if (!interfaceDef) throw new OGMError(`Unknown interface type: ${name}`);

    const model = new InterfaceModel(
      interfaceDef,
      this.schema,
      this.driver,
      this.interfaceCompilers,
      {
        ctx: this.ctx as PolicyContext,
        resolve: (typeName, op, ctx) =>
          this.resolver.resolve(typeName, op, ctx),
        defaults: this.defaults,
        logger: this.logger,
        globalBypass: this.globalBypass,
        policySetVersion: POLICY_SET_VERSION,
      },
    );
    this.interfaceCache.set(name, model as InterfaceModel<unknown>);
    return model;
  }
}
