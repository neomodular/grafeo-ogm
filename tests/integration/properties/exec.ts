/**
 * Runs generated reads and writes through the OGM inside a caller
 * transaction, and turns the outcome into a uniform `Outcome`.
 */
import type { Transaction } from 'neo4j-driver';
import type { OGM } from '../../../src/ogm';
import type { ReadOp, WriteOp } from './arbitraries';
import { classifyError, errorSummary, resolvePlaceholders } from './harness';

type Rec = Record<string, unknown>;

/** The model surface the suites call (plain records in, plain records out). */
interface AnyModel {
  find(p: Rec): Promise<Rec[]>;
  count(p: Rec): Promise<number>;
  aggregate(p: Rec): Promise<Rec>;
  create(p: Rec): Promise<Rec>;
  createMany(p: Rec): Promise<{ count: number }>;
  update(p: Rec): Promise<Rec>;
  updateMany(p: Rec): Promise<{ count: number }>;
  delete(p: Rec): Promise<Rec>;
  deleteMany(p: Rec): Promise<{ count: number }>;
  upsert(p: Rec): Promise<Rec>;
}

/** An OGM, or one bound to a policy context (`ogm.withContext(ctx)`). */
export type OgmLike = Pick<OGM, 'model' | 'interfaceModel'>;

export type Outcome =
  | { ok: true; result: unknown }
  | {
      ok: false;
      kind: 'ogm' | 'server' | 'other';
      error: unknown;
      summary: string;
    };

const model = (ogm: OgmLike, name: string) =>
  ogm.model(name) as unknown as AnyModel;

async function capture(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, result: await fn() };
  } catch (error) {
    return {
      ok: false,
      kind: classifyError(error),
      error,
      summary: errorSummary(error),
    };
  }
}

export function runWrite(
  ogm: OgmLike,
  op: WriteOp,
  runId: string,
  tx: Transaction,
): Promise<Outcome> {
  const o = resolvePlaceholders(op, runId);
  const context = { transaction: tx };
  const m = model(ogm, o.model);
  return capture(() => {
    switch (o.kind) {
      case 'create':
        return m.create({ input: o.input, context });
      case 'createMany':
        return m.createMany({
          data: o.data,
          skipDuplicates: o.skipDuplicates,
          context,
        });
      case 'update':
        return m.update({
          where: o.where,
          update: o.update,
          connect: o.connect,
          disconnect: o.disconnect,
          context,
        });
      case 'updateMany':
        return m.updateMany({ where: o.where, data: o.data, context });
      case 'delete':
        return m.delete({ where: o.where, delete: o.delete, context });
      case 'deleteMany':
        return m.deleteMany({ where: o.where, context });
      case 'upsert':
        return m.upsert({
          where: o.where,
          create: o.create,
          update: o.update,
          context,
        });
    }
  });
}

export function runRead(
  ogm: OgmLike,
  op: ReadOp,
  runId: string,
  tx: Transaction,
): Promise<Outcome> {
  const o = resolvePlaceholders(op, runId);
  const context = { transaction: tx };
  return capture(() => {
    switch (o.kind) {
      case 'find':
        return model(ogm, o.model).find({
          where: o.where,
          selectionSet: o.selectionSet,
          select: o.select,
          options: o.options,
          context,
        });
      case 'count':
        return model(ogm, o.model).count({ where: o.where, context });
      case 'aggregate':
        return model(ogm, o.model).aggregate({
          where: o.where,
          aggregate: o.aggregate,
          context,
        });
      case 'interfaceFind':
        return (ogm.interfaceModel(o.model) as unknown as AnyModel).find({
          where: o.where,
          selectionSet: o.selectionSet,
          options: o.options,
          context,
        });
    }
  });
}

/** JSON with bigint support, keys sorted — for comparing results. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (typeof x === 'bigint') return `${x}n`;
    if (x && typeof x === 'object' && !Array.isArray(x))
      return Object.fromEntries(
        Object.keys(x)
          .sort()
          .map((k) => [k, (x as Rec)[k]]),
      );
    return x;
  });
}
