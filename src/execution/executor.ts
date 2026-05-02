import {
  Driver,
  Session,
  Transaction,
  ManagedTransaction,
  QueryResult,
} from 'neo4j-driver';

/**
 * Minimal logger interface. Compatible with NestJS Logger, console, pino, etc.
 *
 * `warn` is optional so existing logger implementations remain compatible.
 * The OGM uses it for security-sensitive events (policy bypass, raw cypher
 * execution); when not provided it silently no-ops.
 */
export interface OGMLogger {
  debug(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
}

/** No-op logger used when no logger is provided and debug is off. */
const NOOP_LOGGER: OGMLogger = { debug: () => {}, warn: () => {} };

/**
 * Execution context for running queries within an existing transaction or session.
 *
 * Supports both legacy pattern (`executionContext`) and new explicit pattern (`transaction`/`session`).
 * When both are provided, `executionContext` takes precedence for backward compatibility.
 */
export interface ExecutionContext {
  /** @deprecated Use `transaction` instead. Kept for backward compatibility with @neo4j/graphql-ogm. */
  executionContext?: Transaction | ManagedTransaction;
  /** Explicit transaction to run the query within. */
  transaction?: Transaction | ManagedTransaction;
  /** Explicit session to use (auto-committed). */
  session?: Session;
  /**
   * Optional metadata to attach to the underlying transaction. Forwarded
   * via `tx.setMetaData(...)` (or session config for auto-commit). Used
   * by the OGM's policy layer to surface audit fields
   * (`ogmPolicySetVersion`, `ctxFingerprint`, `modelType`, `operation`,
   * `policiesEvaluated`, `bypassed`). Failures to set metadata are
   * logged at `debug` and do not block query execution.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Executes Cypher queries against Neo4j, using either a provided
 * transaction or an auto-commit session.
 */
export class Executor {
  /** Set to true to enable debug logging. */
  static debug = false;

  private logger: OGMLogger;

  constructor(
    private driver: Driver,
    logger?: OGMLogger,
  ) {
    this.logger = logger ?? NOOP_LOGGER;
  }

  /**
   * Execute a Cypher query, using either the provided transaction
   * or a new auto-commit session.
   */
  async execute(
    cypher: string,
    params: Record<string, unknown>,
    context?: ExecutionContext,
  ): Promise<QueryResult> {
    if (Executor.debug) {
      this.logger.debug('[OGM] Cypher: %s', cypher);
      this.logger.debug('[OGM] Params: %s', JSON.stringify(params, null, 2));
    }

    // Legacy backward compatibility
    const tx = context?.executionContext ?? context?.transaction;
    if (tx) {
      this.attachMetadata(tx, context?.metadata);
      return tx.run(cypher, params);
    }

    // Explicit session
    if (context?.session)
      return context.metadata
        ? context.session.run(cypher, params, { metadata: context.metadata })
        : context.session.run(cypher, params);

    // Auto-commit session
    const session = this.driver.session();
    try {
      const result = context?.metadata
        ? await session.run(cypher, params, { metadata: context.metadata })
        : await session.run(cypher, params);
      if (Executor.debug) {
        this.logger.debug('[OGM] Records returned: %d', result.records.length);
        if (result.records.length > 0 && result.records.length <= 5)
          this.logger.debug(
            '[OGM] First record keys: %o',
            result.records[0].keys,
          );
      }
      return result;
    } finally {
      await session.close();
    }
  }

  /**
   * Attach OGM-managed metadata to an existing transaction. Failures
   * (older drivers without `setMetaData`, or already-finished tx) are
   * swallowed at debug — auditing must never block a query.
   */
  private attachMetadata(
    tx: Transaction | ManagedTransaction,
    metadata: Record<string, unknown> | undefined,
  ): void {
    if (!metadata) return;
    const setter = (
      tx as unknown as { setMetaData?: (m: Record<string, unknown>) => void }
    ).setMetaData;
    if (typeof setter !== 'function') return;
    try {
      setter.call(tx, metadata);
    } catch (err) {
      this.logger.debug(
        '[OGM] Failed to set tx metadata: %s',
        (err as Error).message,
      );
    }
  }
}
