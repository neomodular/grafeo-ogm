import {
  Driver,
  isInt,
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

/**
 * Render query params for a debug log line. Never throws.
 *
 * v2.4.8 — a bare `JSON.stringify(params)` threw "Do not know how to
 * serialize a BigInt" for any bigint param, so turning `Executor.debug` on
 * made those queries fail. Debug logging must never change behaviour:
 * bigints and neo4j `Integer`s render as their decimal string, and any
 * other serialization failure (a cycle) yields a placeholder.
 */
export function formatParamsForLog(params: unknown): string {
  try {
    return JSON.stringify(
      params,
      (_key, value: unknown) => {
        if (typeof value === 'bigint') return value.toString();
        if (isInt(value)) return value.toString();
        return value;
      },
      2,
    );
  } catch (err) {
    return `[unserializable params: ${(err as Error).message}]`;
  }
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
   * Optional metadata to attach to the query's transaction. Used by the
   * OGM's policy layer to surface audit fields (`ogmPolicySetVersion`,
   * `ctxFingerprint`, `modelType`, `operation`, `policiesEvaluated`,
   * `bypassed`).
   *
   * neo4j-driver only accepts transaction metadata when a transaction
   * BEGINS, so it reaches the server only on the paths that start one:
   * the executor's own auto-commit session and a caller `session` (both
   * via `session.run(q, p, { metadata })`). A caller-supplied
   * `transaction` has already begun — the metadata cannot be attached
   * there, and the executor logs a `warn` for each such call instead.
   * Pass metadata when opening the transaction
   * (`ogm.$transaction(fn, { metadata })`,
   * `session.beginTransaction({ metadata })`,
   * `session.executeWrite(fn, { metadata })`). Never blocks the query.
   */
  metadata?: Record<string, unknown>;
}

/** Per-call execution options that are not part of `ExecutionContext`. */
export interface ExecuteOptions {
  /**
   * Access mode for the auto-commit session the executor opens itself.
   * `'READ'` makes the server reject any write in the statement. Ignored
   * when the caller supplies a `transaction` / `session` — the caller
   * owns the access mode of those. Omitted → the driver default.
   */
  accessMode?: 'READ' | 'WRITE';
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
    options?: ExecuteOptions,
  ): Promise<QueryResult> {
    if (Executor.debug) {
      this.logger.debug('[OGM] Cypher: %s', cypher);
      this.logger.debug('[OGM] Params: %s', formatParamsForLog(params));
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

    // Auto-commit session. The no-arg call is kept verbatim when no
    // access mode is requested so the default path is unchanged.
    const session = options?.accessMode
      ? this.driver.session({ defaultAccessMode: options.accessMode })
      : this.driver.session();
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
   * Attach OGM-managed metadata to a transaction that is already open.
   *
   * v2.4.8 — neo4j-driver 5.x `Transaction` / `ManagedTransaction` have no
   * `setMetaData`: metadata is only accepted at begin time. Pre-2.4.8 this
   * method found no setter and returned silently, so every audit field
   * (including `unsafe.bypassPolicies` audits) for a call inside a caller
   * transaction was dropped with no signal. It now logs a `warn` per call
   * so the gap is visible. A `setMetaData` that does exist (a custom
   * transaction wrapper) is still used. Auditing never blocks the query.
   */
  private attachMetadata(
    tx: Transaction | ManagedTransaction,
    metadata: Record<string, unknown> | undefined,
  ): void {
    if (!metadata) return;
    const setter = (
      tx as unknown as { setMetaData?: (m: Record<string, unknown>) => void }
    ).setMetaData;
    if (typeof setter !== 'function') {
      this.logger.warn?.(
        '[OGM] Transaction metadata not attached (modelType=%s, operation=%s): ' +
          'neo4j-driver only accepts metadata when a transaction begins. ' +
          'Pass it there instead — ogm.$transaction(fn, { metadata }), ' +
          'session.beginTransaction({ metadata }) or ' +
          'session.executeWrite(fn, { metadata }).',
        String(metadata.modelType ?? '-'),
        String(metadata.operation ?? '-'),
      );
      return;
    }
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
