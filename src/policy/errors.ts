import { OGMError } from '../errors';
import type { Operation } from './types';

/**
 * Thrown when a policy denies an operation. Used by:
 * - `policyDefaults.onDeny: 'throw'` — no permissive matched on a read/aggregate.
 * - `Model.create` / `Model.createMany` — restrictive returned false on input.
 * - `Model.upsert` — write-side policy denied at the application layer.
 */
export class PolicyDeniedError extends OGMError {
  readonly typeName: string;
  readonly operation: Operation;
  readonly reason:
    | 'no-permissive-matched'
    | 'restrictive-rejected-input'
    | 'override-failed-validation';
  readonly policyName: string | undefined;

  constructor(args: {
    typeName: string;
    operation: Operation;
    reason: PolicyDeniedError['reason'];
    policyName?: string;
    detail?: string;
  }) {
    const detail = args.detail ? ` (${args.detail})` : '';
    super(
      `Policy denied ${args.operation} on ${args.typeName}: ${args.reason}${detail}`,
    );
    this.name = 'PolicyDeniedError';
    this.typeName = args.typeName;
    this.operation = args.operation;
    this.reason = args.reason;
    this.policyName = args.policyName;
  }
}
