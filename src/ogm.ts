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
import { Model, ModelCompilers } from './model';
import { parseSchema } from './schema/parser';
import { SchemaMetadata } from './schema/types';
import { clearResolveTargetDefCache } from './schema/utils';
import { cloneSubgraph, deleteSubgraph } from './subgraph/subgraph-operations';
import {
  SubgraphCloneResult,
  SubgraphConfig,
  SubgraphDeleteResult,
} from './subgraph/types';
import { assertSafeIdentifier, assertSafeLabel } from './utils/validation';

export interface OGMConfig {
  typeDefs: string;
  driver: Driver;
  logger?: OGMLogger;
  features?: { filters?: { String?: { MATCHES?: boolean } } };
}

export class OGM<
  TModelMap extends Record<string, unknown> = Record<string, unknown>,
  TInterfaceModelMap extends Record<string, unknown> = Record<string, unknown>,
> {
  private config: OGMConfig;
  private schema!: SchemaMetadata;
  private models: Map<string, Model<unknown>> = new Map();
  private interfaceModels: Map<string, InterfaceModel<unknown>> = new Map();
  private modelCompilers!: ModelCompilers;
  private interfaceModelCompilers!: InterfaceModelCompilers;
  private relPropsToRelType: Map<string, string> = new Map();

  constructor(config: OGMConfig) {
    this.config = config;
    // Parse schema synchronously so model() works before init()
    this.schema = parseSchema(this.config.typeDefs);

    const whereOptions: WhereCompilerOptions = {};
    if (config.features?.filters?.String?.MATCHES === false)
      whereOptions.disabledOperators = new Set(['_MATCHES'] as const);

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

    // Pre-build reverse lookup: propsTypeName → relationship type
    for (const [, nodeDef] of this.schema.nodes)
      for (const [, relDef] of nodeDef.relationships)
        if (relDef.properties && !this.relPropsToRelType.has(relDef.properties))
          this.relPropsToRelType.set(relDef.properties, relDef.type);
  }

  async init(): Promise<void> {
    // Schema is already parsed in constructor.
    // init() is kept for backward compatibility and for any future async setup.
  }

  async assertIndexesAndConstraints(options?: {
    options?: { create?: boolean };
  }): Promise<void> {
    if (!options?.options?.create) return;

    const session = this.config.driver.session();
    try {
      // Create node fulltext indexes
      for (const [, nodeDef] of this.schema.nodes)
        for (const ftIndex of nodeDef.fulltextIndexes)
          if (ftIndex.fields.length > 0) {
            assertSafeLabel(nodeDef.label);
            assertSafeIdentifier(ftIndex.name, 'fulltext index name');
            for (const f of ftIndex.fields)
              assertSafeIdentifier(f, 'fulltext index field');
            const fieldsStr = ftIndex.fields.map((f) => `n.${f}`).join(', ');
            const cypher = `CREATE FULLTEXT INDEX ${ftIndex.name} IF NOT EXISTS FOR (n:${nodeDef.label}) ON EACH [${fieldsStr}]`;
            await session.run(cypher);
          }

      // Create relationship fulltext indexes (from @fulltext on @relationshipProperties)
      for (const [, relPropsDef] of this.schema.relationshipProperties)
        for (const ftIndex of relPropsDef.fulltextIndexes ?? []) {
          assertSafeIdentifier(ftIndex.name, 'fulltext index name');
          for (const f of ftIndex.fields)
            assertSafeIdentifier(f, 'fulltext index field');
          const relType = this.findRelTypeForProps(relPropsDef.typeName);
          assertSafeIdentifier(relType, 'relationship type');
          const fieldsStr = ftIndex.fields.map((f) => `r.${f}`).join(', ');
          const cypher = `CREATE FULLTEXT INDEX ${ftIndex.name} IF NOT EXISTS FOR ()-[r:${relType}]-() ON EACH [${fieldsStr}]`;
          await session.run(cypher);
        }

      // Create uniqueness constraints
      for (const [, nodeDef] of this.schema.nodes)
        for (const [, prop] of nodeDef.properties)
          if (prop.isUnique) {
            assertSafeLabel(nodeDef.label);
            assertSafeIdentifier(prop.name, 'property name');
            const constraintName = `${nodeDef.label}_${prop.name}_unique`;
            assertSafeIdentifier(constraintName, 'constraint name');
            const cypher = `CREATE CONSTRAINT ${constraintName} IF NOT EXISTS FOR (n:${nodeDef.label}) REQUIRE n.${prop.name} IS UNIQUE`;
            await session.run(cypher);
          }
    } finally {
      await session.close();
    }
  }

  /** Resolve which relationship type uses a given @relationshipProperties type name. */
  private findRelTypeForProps(propsTypeName: string): string {
    const relType = this.relPropsToRelType.get(propsTypeName);
    if (relType) return relType;

    throw new OGMError(
      `No relationship found using properties type "${propsTypeName}"`,
    );
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
      : Record<string, 'ASC' | 'DESC'>
  >;
  /** @deprecated Legacy overload for backward compatibility with @neo4j/graphql-ogm. Use the single-generic overload instead. */
  model<_T, K extends string>(
    name: K,
  ): Model<any, any, any, any, any, any, any, any, any, any, any>;
  model<T = Record<string, unknown>>(
    name: string,
  ): Model<T, any, any, any, any, any, any, any, any, any, any>;
  model(
    name: string,
  ):
    | Model<any, any, any, any, any, any, any, any, any, any, any>
    | InterfaceModel<any, any, any> {
    const existing = this.models.get(name);
    if (existing) return existing;

    // Also check interface model cache
    const existingInterface = this.interfaceModels.get(name);
    if (existingInterface) return existingInterface as any;

    const nodeDef = this.schema.nodes.get(name);
    if (nodeDef) {
      const model = new Model(
        nodeDef,
        this.schema,
        this.config.driver,
        this.modelCompilers,
        this.config.logger,
      );
      this.models.set(name, model as Model<unknown>);
      return model;
    }

    // Fallback: check interfaces
    const interfaceDef = this.schema.interfaces.get(name);
    if (interfaceDef) {
      const model = new InterfaceModel(
        interfaceDef,
        this.schema,
        this.config.driver,
        this.interfaceModelCompilers,
      );
      this.interfaceModels.set(name, model as InterfaceModel<unknown>);
      return model as any;
    }

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
