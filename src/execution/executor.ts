import {
  Driver,
  Session,
  Transaction,
  ManagedTransaction,
  QueryResult,
} from 'neo4j-driver';

/**
 * Minimal logger interface. Compatible with NestJS Logger, console, pino, etc.
 */
export interface OGMLogger {
  debug(message: string, ...args: unknown[]): void;
}

/** No-op logger used when no logger is provided and debug is off. */
const NOOP_LOGGER: OGMLogger = { debug: () => {} };

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
    if (tx) return tx.run(cypher, params);

    // Explicit session
    if (context?.session) return context.session.run(cypher, params);

    // Auto-commit session
    const session = this.driver.session();
    try {
      const result = await session.run(cypher, params);
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
}
