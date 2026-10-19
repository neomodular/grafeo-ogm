/**
 * v2.8.0 — finding F1, a nested delete reached through a cycle (chart ->
 * tags -> charts). Strict mode compiles the alive guard; default mode keeps
 * v2.7.0's Cypher (`nested-write.byte-identical.spec.ts`) and re-runs a
 * statement that failed with `EntityNotFound` with the guard, only when the
 * OGM owns the transaction. Server behaviour is in
 * `integration/update-cycle-delete.spec.ts`.
 */
import type { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { compileShape, shapes } from './nested-write.byte-identical.shapes';
import { typeDefs } from './integration/properties/schema';

/** The F1 warnings (the OGM also warns about shared relationship types). */
const f1 = (warnings: string[]) =>
  warnings.filter((w) => /nested delete|EntityNotFound/.test(w));

const GUARD = (v: string) =>
  `WHERE exists { MATCH (_alive) WHERE elementId(_alive) = elementId(${v}) }`;

const cycle = { tags: [{ update: { node: { charts: [{ delete: [{}] }] } } }] };

function entityNotFound(): Error {
  return Object.assign(new Error('Node with id 1 has been deleted'), {
    code: 'Neo.ClientError.Statement.EntityNotFound',
  });
}

/** A driver whose first `run` fails with `first` (if given). */
function failingDriver(first?: Error) {
  const calls: string[] = [];
  const ok = {
    records: [{ get: () => 1, keys: ['count'] }],
    summary: { counters: { updates: () => ({}) } },
  };
  const run = jest.fn((cypher: string) => {
    calls.push(cypher);
    return calls.length === 1 && first
      ? Promise.reject(first)
      : Promise.resolve(ok);
  });
  const session = { run, close: jest.fn().mockResolvedValue(undefined) };
  const driver = {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
  return { driver, calls, session };
}

function ogmWith(driver: Driver, strict = false) {
  const warnings: string[] = [];
  const ogm = new OGM({
    typeDefs,
    driver,
    ...(strict ? { strict: true } : {}),
    logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { model: ogm.model('ItPChart') as any, warnings };
}

describe('nested delete through a cycle (v2.8.0, finding F1)', () => {
  describe('strict mode compiles the alive guard', () => {
    it.each([
      [
        'update: nested delete through a cycle (chart -> tags -> charts)',
        ['n'],
      ],
      ['updateMany: nested delete through a cycle, count only', ['n']],
      ['updateMany: cycle delete, then a create from the root', ['n']],
      ['update: two roots, one deletes the other through the cycle', ['n']],
      ['update: nested delete reaches an intermediate node', ['n_u0']],
      ['update: union member update with a cycle delete', ['n']],
      ['update: interface member body with a cycle delete', ['n']],
      ['update: self-relationship nested delete', ['n']],
      [
        'updateMany: self-relationship friends of friends delete',
        ['n_u0', 'n'],
      ],
      ['update: nested delete of a type that is no ancestor', []],
    ])('%s', async (name, guarded) => {
      const shape = shapes[name];
      const [rec] = await compileShape(shape.run, 'strict', shape.self);
      const found = [...rec.cypher.matchAll(/elementId\((\w+)\) }$/gm)].map(
        (m) => m[1],
      );
      expect(found).toEqual(guarded);
      for (const v of guarded) expect(rec.cypher).toContain(GUARD(v));
    });

    it('places the guard right after the op block, before later writes', async () => {
      const shape =
        shapes['updateMany: cycle delete, then a create from the root'];
      const [rec] = await compileShape(shape.run, 'strict');
      expect(rec.cypher).toContain(
        ['}', 'WITH n', GUARD('n'), 'WITH n', 'CREATE (n_cr1:'].join('\n'),
      );
    });

    it('does not warn', async () => {
      const warnings: string[] = [];
      const shape =
        shapes['updateMany: nested delete through a cycle, count only'];
      await compileShape(shape.run, 'strict', false, warnings);
      expect(f1(warnings)).toEqual([]);
    });
  });

  describe('default mode', () => {
    it('warns once when updateMany may count a root the delete removed', async () => {
      const warnings: string[] = [];
      const shape =
        shapes['updateMany: nested delete through a cycle, count only'];
      await compileShape(shape.run, 'plain', false, warnings);
      expect(f1(warnings)).toEqual([
        expect.stringContaining(
          'updateMany on ItPChart has a nested delete whose target type can be the root itself',
        ),
      ]);
      expect(f1(warnings)[0]).toContain('Enable `strict: true`');
    });

    it('does not warn for update, or for a delete of a type that is no ancestor', async () => {
      for (const name of [
        'update: nested delete through a cycle (chart -> tags -> charts)',
        'update: nested delete of a type that is no ancestor',
      ]) {
        const warnings: string[] = [];
        await compileShape(shapes[name].run, 'plain', false, warnings);
        expect(f1(warnings)).toEqual([]);
      }
    });

    it('re-runs a statement that failed with EntityNotFound, with the guard', async () => {
      const { driver, calls } = failingDriver(entityNotFound());
      const { model } = ogmWith(driver);
      await model.update({ where: { id: 'c1' }, update: cycle });
      expect(calls).toHaveLength(2);
      expect(calls[0]).not.toContain('_alive');
      expect(calls[1]).toContain(GUARD('n'));
    });

    it('re-runs updateMany too, and in a caller session', async () => {
      const { driver, calls } = failingDriver(entityNotFound());
      const { model } = ogmWith(driver);
      const session = driver.session();
      const res = await model.updateMany({
        where: { id: 'c1' },
        data: cycle,
        context: { session },
      });
      expect(res).toEqual({ count: 1 });
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain(GUARD('n'));
    });

    it('rethrows in a caller transaction (already rolled back) and warns once', async () => {
      const { driver, calls } = failingDriver(entityNotFound());
      const { model, warnings } = ogmWith(driver);
      const tx = { run: driver.session().run };
      await expect(
        model.update({
          where: { id: 'c1' },
          update: cycle,
          context: { transaction: tx },
        }),
      ).rejects.toMatchObject({
        code: 'Neo.ClientError.Statement.EntityNotFound',
      });
      expect(calls).toHaveLength(1);
      expect(f1(warnings)).toEqual([
        expect.stringContaining(
          'update on ItPChart failed with EntityNotFound',
        ),
      ]);
    });

    it('does not re-run other errors, or statements with no cycle delete', async () => {
      const other = Object.assign(new Error('boom'), {
        code: 'Neo.ClientError.Statement.SyntaxError',
      });
      const a = failingDriver(other);
      await expect(
        ogmWith(a.driver).model.update({ where: { id: 'c1' }, update: cycle }),
      ).rejects.toBe(other);
      expect(a.calls).toHaveLength(1);

      const b = failingDriver(entityNotFound());
      await expect(
        ogmWith(b.driver).model.update({
          where: { id: 'c1' },
          update: { name: 'x' },
        }),
      ).rejects.toMatchObject({
        code: 'Neo.ClientError.Statement.EntityNotFound',
      });
      expect(b.calls).toHaveLength(1);
    });
  });

  it('strict mode never re-runs', async () => {
    const { driver, calls } = failingDriver(entityNotFound());
    await expect(
      ogmWith(driver, true).model.update({
        where: { id: 'c1' },
        update: cycle,
      }),
    ).rejects.toMatchObject({
      code: 'Neo.ClientError.Statement.EntityNotFound',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(GUARD('n'));
  });
});
