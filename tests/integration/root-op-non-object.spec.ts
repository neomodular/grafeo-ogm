/**
 * Live: a root write op that is not an object (vNEXT, strict item 46).
 *
 * `update({ where, update, connect: false })`, `delete({ where, delete: 0 })`,
 * `updateMany({ where, data: true })`: default mode still skips the op (the
 * rest of the call runs, as in v2.25.0) and warns; strict mode throws before
 * anything is written. Default and strict, with and without policies.
 * Opt-in on NEO4J_URI; every node carries this run's `runId` and is removed
 * in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';
import { permissive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItRoUser @node {
    id: ID! @unique
    runId: String
    name: String
    posts: [ItRoPost!]! @relationship(type: "IT_RO_WROTE", direction: OUT)
  }
  type ItRoPost @node {
    id: ID! @unique
    runId: String
  }
`;

type Row = Record<string, unknown>;
type Loose = Record<string, (params: Row) => Promise<unknown>>;

const allow = [
  permissive({
    operations: ['*'],
    when: (c) => ({ runId: c.runId as string }),
  }),
];
const policies = { ItRoUser: allow, ItRoPost: allow };

describeLive('a root write op that is not an object — live Neo4j', () => {
  let driver: Driver;
  const runId = `it-ro-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;

  async function run(cypher: string, params: Row = {}): Promise<Row[]> {
    const session = driver.session();
    try {
      const res = await session.run(cypher, { ...params, runId });
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  /** User u with post p1 linked and post p2 unlinked; returns the key. */
  async function seed(key: string): Promise<void> {
    await run(
      `CREATE (u:ItRoUser {id: $u, runId: $runId, name: 'old'})
       CREATE (u)-[:IT_RO_WROTE]->(:ItRoPost {id: $p1, runId: $runId})
       CREATE (:ItRoPost {id: $p2, runId: $runId})`,
      { u: id(`${key}-u`), p1: id(`${key}-p1`), p2: id(`${key}-p2`) },
    );
  }
  async function state(key: string) {
    const [row] = await run(
      `OPTIONAL MATCH (u:ItRoUser {id: $u})
       RETURN u.name AS name,
              COUNT { (u)-[:IT_RO_WROTE]->() } AS links,
              COUNT { (p:ItRoPost) WHERE p.id STARTS WITH $prefix } AS posts`,
      { u: id(`${key}-u`), prefix: id(`${key}-p`) },
    );
    return row;
  }

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    await driver.verifyConnectivity();
  });

  afterAll(async () => {
    if (!driver) return;
    await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
    await driver.close();
  });

  describe.each([
    ['default', undefined, false],
    ['strict', true, false],
    ['default + policies', undefined, true],
    ['strict + policies', true, true],
  ])('%s', (mode, strict, withPolicies) => {
    const users = (warn: jest.Mock) => {
      const ogm = new OGM({
        typeDefs,
        driver,
        strict,
        logger: { warn, debug: () => undefined },
        ...(withPolicies ? { policies } : {}),
      });
      return (withPolicies
        ? ogm.withContext({ runId }).model('ItRoUser')
        : ogm.model('ItRoUser')) as unknown as Loose;
    };
    const key = (s: string) => `${mode.replace(/\W/g, '')}-${s}`;
    const expectRejected = async (call: Promise<unknown>, root: string) => {
      const err = await call.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OGMError);
      expect((err as Error).message).toContain(root);
    };

    it('update() with connect: false / disconnect: 0 / update: true', async () => {
      for (const [k, rootKey, extra] of [
        ['c', 'connect', { update: { name: 'new' }, connect: false }],
        ['d', 'disconnect', { update: { name: 'new' }, disconnect: 0 }],
        ['u', 'update', { update: true }],
      ] as const) {
        await seed(key(k));
        const warn = jest.fn();
        const call = users(warn).update({
          where: { id: id(`${key(k)}-u`) },
          ...extra,
        });
        if (strict) {
          await expectRejected(
            call,
            `The root "${rootKey}" of ItRoUser.update()`,
          );
          expect(await state(key(k))).toEqual({
            name: 'old',
            links: 1,
            posts: 2,
          });
          continue;
        }
        await call;
        expect(await state(key(k))).toEqual({
          name: k === 'u' ? 'old' : 'new',
          links: 1,
          posts: 2,
        });
        expect(
          warn.mock.calls.some((c) =>
            String(c[0]).includes(
              `The root "${rootKey}" of ItRoUser.update() is`,
            ),
          ),
        ).toBe(true);
      }
    });

    it('delete() with a cascade delete: 0', async () => {
      await seed(key('x'));
      const call = users(jest.fn()).delete({
        where: { id: id(`${key('x')}-u`) },
        delete: 0,
      });
      if (strict) {
        await expectRejected(call, 'The root "delete" of ItRoUser.delete()');
        expect(await state(key('x'))).toEqual({
          name: 'old',
          links: 1,
          posts: 2,
        });
        return;
      }
      await call;
      // The root is deleted, the cascade is skipped: both posts remain.
      expect(await state(key('x'))).toEqual({ name: null, links: 0, posts: 2 });
    });

    it('updateMany() with data: true', async () => {
      await seed(key('m'));
      const call = users(jest.fn()).updateMany({
        where: { id: id(`${key('m')}-u`) },
        data: true,
      });
      if (strict) {
        await expectRejected(call, 'The root "data" of ItRoUser.updateMany()');
        return;
      }
      expect(await call).toEqual({ count: 1 });
      expect(await state(key('m'))).toEqual({
        name: 'old',
        links: 1,
        posts: 2,
      });
    });
  });
});
