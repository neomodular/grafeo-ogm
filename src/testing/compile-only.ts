/**
 * v2.27.0 — compile-only OGM (GitHub issue #3): turn a model call into the
 * `{ cypher, params }` it would send, in a unit test, with no driver and no
 * database.
 *
 * `createCompileOnlyOgm()` returns a real `OGM` — `withContext`,
 * `unsafe.bypassPolicies`, `interfaceModel`, `strict`, `features` and
 * `policies` behave exactly as in production — whose driver never reaches a
 * server: the statement a model call sends is captured instead. `compile()`
 * runs the real model method and returns that statement, so every check the
 * method makes before it runs (strict mode, unknown keys, the `_MATCHES`
 * guard, policy default-deny and WITH CHECK, nested-write policy checks)
 * runs too, and its errors reject the `compile` call as they would reject
 * the real one. There is no second compile pipeline to drift from the first.
 */
import { format } from 'node:util';
import type { Driver } from 'neo4j-driver';
import { isInt } from 'neo4j-driver';
import { OGMError } from '../errors';
import { driverOf } from '../execution/driver-registry';
import type { OGMLogger } from '../execution/executor';
import { OGM, type ConfigContext, type OGMConfig } from '../ogm';
import type { PolicyContext } from '../policy/types';
import { warnOnEveryCall } from '../utils/strict-mode';

/** The statement a model call sends, as captured by {@link compile}. */
export interface CompiledQuery {
  /** The Cypher text, exactly as the real call sends it. */
  cypher: string;
  /** The parameters, exactly as sent (neo4j `Integer`s, temporals, …). */
  params: Record<string, unknown>;
  /** Transaction metadata the call sends: the policy audit fields, when the OGM has `policies`. */
  metadata?: Record<string, unknown>;
  /** Access mode of the session the call opens, when it sets one (`explainPolicies`: `'READ'`). */
  accessMode?: 'READ' | 'WRITE';
  /**
   * Warnings logged while compiling this call (default mode: unknown keys,
   * shapes `strict: true` changes, empty `AND` / `OR`, policy bypasses, …),
   * as the logger would print them. Logged on every call, not once per OGM.
   */
  warnings: string[];
}

/** Config of {@link createCompileOnlyOgm}: an `OGMConfig` without `driver` / `database`. */
export type CompileOnlyOgmConfig<
  M extends Record<string, unknown> = Record<string, unknown>,
  C extends object = PolicyContext,
> = Omit<OGMConfig<M, C>, 'driver' | 'database'>;

/** Thrown by the compile-only driver when a statement is sent; caught by `compile()`. */
class CompiledStatement extends OGMError {
  constructor(readonly query: Omit<CompiledQuery, 'warnings'>) {
    super(
      'This OGM was created by createCompileOnlyOgm() and never runs a query. ' +
        'Use compile(model).<method>(params) to get the statement it would send.',
    );
    this.name = 'CompiledStatement';
  }
}

interface CompileOnlyState {
  /** Every warning line the OGM's logger received, in order. */
  warnings: string[];
}

const COMPILE_ONLY = new WeakMap<object, CompileOnlyState>();

const unsupported = (what: string): OGMError =>
  new OGMError(
    `${what} is not supported on a compile-only OGM (createCompileOnlyOgm): it has no database. ` +
      'Only model and interface-model calls compile, through compile(model).',
  );

function compileOnlyDriver(state: CompileOnlyState): Driver {
  const driver = {
    session(config?: { defaultAccessMode?: 'READ' | 'WRITE' }) {
      return {
        run(
          cypher: string,
          params?: Record<string, unknown>,
          tx?: { metadata?: Record<string, unknown> },
        ): never {
          throw new CompiledStatement({
            cypher,
            params: params ?? {},
            ...(tx?.metadata ? { metadata: tx.metadata } : {}),
            ...(config?.defaultAccessMode
              ? { accessMode: config.defaultAccessMode }
              : {}),
          });
        },
        beginTransaction: () => {
          throw unsupported('A transaction');
        },
        executeRead: () => Promise.reject(unsupported('A transaction')),
        executeWrite: () => Promise.reject(unsupported('A transaction')),
        close: async () => {},
      };
    },
    close: async () => {},
  };
  COMPILE_ONLY.set(driver, state);
  return driver as unknown as Driver;
}

/** `OGM` methods that need a database; a compile-only OGM rejects them. */
const OGM_OUT_OF_SCOPE = [
  '$queryRaw',
  '$executeRaw',
  '$transaction',
  '$cloneSubgraph',
  '$deleteSubgraph',
  'assertIndexesAndConstraints',
] as const;

/**
 * Build an OGM that compiles model calls but never executes one. No driver,
 * no connection: pass the same `typeDefs` / `strict` / `features` /
 * `policies` as your production OGM and wrap its models in {@link compile}.
 *
 * Calling a model method directly (without `compile`) rejects with an
 * `OGMError`; so do `$queryRaw`, `$executeRaw`, `$transaction`,
 * `$cloneSubgraph`, `$deleteSubgraph` and `assertIndexesAndConstraints`.
 * A `logger` you pass still receives every line.
 */
export function createCompileOnlyOgm<
  M extends Record<string, unknown> = Record<string, unknown>,
  I extends Record<string, unknown> = Record<string, unknown>,
  // v2.31.0 — typed policy context, as on `OGM`.
  C extends object = PolicyContext,
>(config: CompileOnlyOgmConfig<M, ConfigContext<C>>): OGM<M, I, C> {
  for (const key of ['driver', 'database'] as const)
    if ((config as Record<string, unknown>)[key] !== undefined)
      throw new OGMError(
        `createCompileOnlyOgm() takes no "${key}": a compile-only OGM never connects.`,
      );
  const state: CompileOnlyState = { warnings: [] };
  const user = config.logger;
  const logger: OGMLogger = {
    debug: (message, ...args) => user?.debug(message, ...args),
    warn: (message, ...args) => {
      state.warnings.push(format(message, ...args));
      user?.warn?.(message, ...args);
    },
  };
  warnOnEveryCall(logger);
  const ogm = new OGM<M, I, C>({
    ...config,
    logger,
    driver: compileOnlyDriver(state),
  } as OGMConfig<M, ConfigContext<C>>);
  // Own enumerable properties, so `unsafe.bypassPolicies()` clones (which
  // copy the instance) reject them too.
  for (const name of OGM_OUT_OF_SCOPE)
    (ogm as unknown as Record<string, unknown>)[name] = () =>
      Promise.reject(unsupported(`ogm.${name}()`));
  return ogm;
}

/** `Model` / `InterfaceModel` methods `compile()` wraps. */
export const COMPILABLE_METHODS = [
  'find',
  'findFirst',
  'findUnique',
  'findFirstOrThrow',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'create',
  'createMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
  'setLabels',
  'searchByVector',
  'searchByPhrase',
  'explainPolicies',
] as const;

/** Name of a method {@link compile} wraps. */
export type CompilableMethod = (typeof COMPILABLE_METHODS)[number];

/**
 * `context` of a compiled call: only its `metadata` (sent with the
 * statement). A `transaction` / `session` would run the statement on a
 * database.
 */
export interface CompileContext {
  metadata?: Record<string, unknown>;
}

type CompileParams<P> = Omit<P, 'context'> & { context?: CompileContext };

/** A method's parameter list with `context` narrowed to {@link CompileContext}. */
type WithoutContext<A extends unknown[]> = A extends [infer P]
  ? [params: CompileParams<P>]
  : A extends [(infer P)?]
    ? [params?: CompileParams<NonNullable<P>>]
    : A;

/**
 * The compilable methods of model type `M`: the same parameters as the real
 * methods (generated types included), with `context` limited to `metadata`,
 * each resolving to the statement the call would send.
 */
export type Compiled<M> = {
  [K in Extract<keyof M, CompilableMethod>]: M[K] extends (
    ...args: infer A
  ) => Promise<unknown>
    ? (...args: WithoutContext<A>) => Promise<CompiledQuery>
    : never;
};

/**
 * Wrap a model from a {@link createCompileOnlyOgm} OGM (`ogm.model(name)`,
 * `ogm.interfaceModel(name)`, `ogm.withContext(ctx).model(name)`, …):
 * `await compile(model).find({ where })` resolves to the {@link CompiledQuery}
 * the real `find` would send, and rejects with the error the real call would
 * throw before reaching the database.
 *
 * - `update` / `updateMany`: the statement as first sent. In default mode a
 *   statement with a nested delete reached through a cycle is re-run once
 *   with an alive guard if the SERVER reports `EntityNotFound`; that re-run
 *   cannot be compiled (strict mode compiles the guard up front).
 * - What a method does with the result (`findFirstOrThrow`'s
 *   `RecordNotFoundError`, mutation counters, `explainPolicies` verdicts) is
 *   not run: there is no result.
 *
 * Throws `OGMError` for a model that can reach a database.
 */
export function compile<M extends object>(model: M): Compiled<M> {
  const driver = driverOf(model);
  const state = driver ? COMPILE_ONLY.get(driver) : undefined;
  if (!state)
    throw new OGMError(
      'compile() takes a model from an OGM built by createCompileOnlyOgm(); ' +
        'it refuses a model that can reach a database.',
    );
  const out: Record<string, unknown> = {};
  for (const name of COMPILABLE_METHODS) {
    const method = (model as Record<string, unknown>)[name];
    if (typeof method !== 'function') continue;
    out[name] = async (params?: unknown): Promise<CompiledQuery> => {
      const context =
        params !== null && typeof params === 'object'
          ? (params as { context?: Record<string, unknown> | null }).context
          : undefined;
      // A caller transaction / session runs the statement itself, on
      // whatever database it belongs to: never let one through.
      if (context)
        for (const key of ['transaction', 'executionContext', 'session'])
          if (context[key] !== undefined)
            throw new OGMError(
              `compile(): "context.${key}" would run the statement on a database; ` +
                'a compiled call takes only "context.metadata".',
            );
      const before = state.warnings.length;
      // A model method does all its work up to sending the statement
      // synchronously, so the warnings logged during this call are its own.
      const pending = (method as (p?: unknown) => Promise<unknown>).call(
        model,
        params,
      );
      const warnings = state.warnings.slice(before);
      try {
        await pending;
      } catch (err) {
        if (err instanceof CompiledStatement) return { ...err.query, warnings };
        throw err;
      }
      throw new OGMError(`compile(): ${name}() sent no statement.`);
    };
  }
  return out as Compiled<M>;
}

/**
 * A snapshot-friendly copy of a {@link CompiledQuery}. Rules (stable across
 * releases): neo4j `Integer` → number (decimal string outside the safe
 * integer range); `bigint` → decimal string; JS `Date` → ISO string; neo4j
 * temporal and point values → their `toString()`; object keys sorted;
 * trailing whitespace trimmed from every Cypher line. Param names are left
 * as they are — they are already numbered deterministically per call.
 */
export function normalizeCompiled(query: CompiledQuery): CompiledQuery {
  const out: CompiledQuery = {
    ...query,
    cypher: query.cypher
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n'),
    params: normalizeValue(query.params) as Record<string, unknown>,
  };
  if (query.metadata)
    out.metadata = normalizeValue(query.metadata) as Record<string, unknown>;
  return out;
}

function normalizeValue(value: unknown): unknown {
  if (isInt(value))
    return value.inSafeRange() ? value.toNumber() : value.toString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort())
        out[key] = normalizeValue((value as Record<string, unknown>)[key]);
      return out;
    }
    return String(value);
  }
  return value;
}
