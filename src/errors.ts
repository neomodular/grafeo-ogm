/**
 * Base error class for all OGM errors.
 * Provides consistent error identification across the package.
 */
export class OGMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OGMError';
  }
}

/**
 * Thrown by `cloneSubgraph` / `deleteSubgraph` when an APOC subgraph operation fails.
 * Wraps the underlying Neo4j/APOC error with operation context.
 */
export class SubgraphOperationError extends OGMError {
  readonly operation: 'clone' | 'delete';
  readonly rootId: string;
  readonly cause?: Error;

  constructor(
    operation: 'clone' | 'delete',
    rootId: string,
    message: string,
    cause?: Error,
  ) {
    super(`Subgraph ${operation} failed for root=${rootId}: ${message}`);
    this.name = 'SubgraphOperationError';
    this.operation = operation;
    this.rootId = rootId;
    this.cause = cause;
  }
}

/**
 * Thrown by `findFirstOrThrow` / `findUniqueOrThrow` when no matching record exists.
 */
export class RecordNotFoundError extends OGMError {
  /** The model (node type) that was queried */
  readonly model: string;
  /** The where clause that produced zero results */
  readonly where: Record<string, unknown> | undefined;

  constructor(model: string, where?: Record<string, unknown>) {
    const whereStr = where ? ` with where ${JSON.stringify(where)}` : '';
    super(`No ${model} record found${whereStr}`);
    this.name = 'RecordNotFoundError';
    this.model = model;
    this.where = where;
  }
}
