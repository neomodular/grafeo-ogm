/**
 * vNEXT — strict item 46 (root ops): a root write op that is not an object —
 * `update()`'s `update` / `connect` / `disconnect`, `updateMany()`'s `data`,
 * `upsert()`'s `create` / `update`, `delete()`'s cascade `delete` — was
 * skipped without a word. Default mode: the Cypher is byte-identical to
 * v2.25.0 (captured on b324181) and it warns once; strict mode throws before
 * anything runs, as it already did for the root `create` / `connectOrCreate`
 * / `delete` of `update()` (item 43). A string or a non-empty array keeps
 * its v2.25.0 handling by default and throws in strict mode.
 */
import { OGM } from '../src/ogm';
import { OGMError } from '../src/errors';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';
import { rootOpsTypeDefs } from './strict-mode.update-root-ops.cases';

type Op = {
  method: string;
  key: string;
  run: (ogm: OGM, value: unknown) => Promise<unknown>;
};

// The values are deliberately ill-typed: these are the runtime shapes
// a caller without the generated types (or with `any`) can pass.
type Loose = Record<
  string,
  (params: Record<string, unknown>) => Promise<unknown>
>;
const user = (ogm: OGM) => ogm.model('User') as unknown as Loose;
const where = { id: 'u1' };

const ops: Op[] = [
  ...(['update', 'connect', 'disconnect'] as const).map((key) => ({
    method: 'update',
    key,
    run: (ogm: OGM, value: unknown) =>
      user(ogm).update({
        where,
        ...(key === 'update' ? {} : { update: { name: 'n' } }),
        [key]: value,
      }),
  })),
  {
    method: 'updateMany',
    key: 'data',
    run: (ogm, value) => user(ogm).updateMany({ where, data: value }),
  },
  {
    method: 'upsert',
    key: 'create',
    run: (ogm, value) =>
      user(ogm).upsert({
        where: { email: 'e' },
        create: value,
        update: { name: 'x' },
      }),
  },
  {
    method: 'upsert',
    key: 'update',
    run: (ogm, value) =>
      user(ogm).upsert({
        where: { email: 'e' },
        create: { email: 'e' },
        update: value,
      }),
  },
  {
    method: 'delete',
    key: 'delete',
    run: (ogm, value) => user(ogm).delete({ where, delete: value }),
  },
];

/** Values with no keys: skipped silently before vNEXT. */
const empty: Array<[string, unknown]> = [
  ['false', false],
  ['0', 0],
  ["''", ''],
  ['true', true],
  ['5', 5],
  ['[]', []],
];
/** Values with keys: kept as in v2.25.0 by default. */
const keyed: Array<[string, unknown]> = [
  ["'x'", 'x'],
  ['[{}]', [{}]],
];

/** v2.25.0 (b324181): Cypher per op with a keyless value (the same for each). */
const V2250: Record<string, string> = {
  'update() update':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'update() connect':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'update() disconnect':
    "MATCH (n:`User`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'updateMany() data':
    'MATCH (n:`User`)\nWHERE n.`id` = $param0\nRETURN count(n) AS count',
  'upsert() create':
    "MERGE (n:`User` { `email`: $merge_email })\nON CREATE SET n.`id` = randomUUID()\nON MATCH SET n.`name` = $onMatch_name\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'upsert() update':
    "MERGE (n:`User` { `email`: $merge_email })\nON CREATE SET n.`email` = $onCreate_email, n.`id` = randomUUID()\nRETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
  'delete() delete':
    'MATCH (n:`User`)\nWHERE n.`id` = $param0\nDETACH DELETE n',
};

function make(strict: boolean | undefined) {
  const records: Recorded[] = [];
  const warn = jest.fn();
  const ogm = new OGM({
    typeDefs: rootOpsTypeDefs,
    driver: recordingDriver(records),
    ...(strict === undefined ? {} : { strict }),
    logger: { debug: () => undefined, warn },
  });
  return { ogm, records, warn };
}

const label = (op: Op) => `${op.method}() ${op.key}`;
const ownWarnings = (warn: jest.Mock) =>
  warn.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes('not an object: it is ignored'));

describe('strict item 46 — a root write op that is not an object', () => {
  describe.each(ops.map((op) => [label(op), op] as const))('%s', (_l, op) => {
    it.each(empty)(
      'default mode: %s — v2.25.0 Cypher, warns once',
      async (_v, value) => {
        for (const strict of [undefined, false]) {
          const { ogm, records, warn } = make(strict);
          await op.run(ogm, value);
          await op.run(ogm, value);
          expect(records.map((r) => r.cypher)).toEqual([
            V2250[label(op)],
            V2250[label(op)],
          ]);
          const own = ownWarnings(warn);
          expect(own).toHaveLength(1);
          expect(own[0]).toContain(
            `The root "${op.key}" of User.${op.method}() is `,
          );
        }
      },
    );

    it.each(keyed)(
      'default mode: %s — keeps its v2.25.0 handling, no new warning',
      async (_v, value) => {
        const { ogm, warn } = make(undefined);
        await op.run(ogm, value).catch(() => undefined);
        expect(ownWarnings(warn)).toHaveLength(0);
      },
    );

    it.each([...empty, ...keyed])(
      'strict mode: %s throws before anything runs',
      async (_v, value) => {
        const { ogm, records } = make(true);
        const err = await op.run(ogm, value).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(OGMError);
        expect((err as Error).message).toMatch(
          new RegExp(
            `^The root "${op.key}" of User\\.${op.method}\\(\\) is .*\\. It must be an object `,
          ),
        );
        expect(records).toHaveLength(0);
      },
    );

    it('null / undefined are no op in both modes, without a warning', async () => {
      for (const strict of [undefined, true])
        for (const value of [null, undefined]) {
          const { ogm, warn } = make(strict);
          await op.run(ogm, value).catch((e: unknown) => {
            // upsert requires its create / update.
            if (op.method !== 'upsert') throw e;
          });
          expect(ownWarnings(warn)).toHaveLength(0);
        }
    });
  });
});
