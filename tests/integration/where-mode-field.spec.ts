/**
 * Live: a where key named `mode` on a type that declares a `mode` field
 * filters on that field (v2.28.1 — data loss).
 *
 * Pre-2.28.1 the where compiler always read `mode` as the
 * case-insensitivity switch and skipped it, so the filter disappeared:
 * `deleteMany({ where: { mode: 'dark' } })` compiled to an unfiltered
 * `DETACH DELETE` and deleted every node, `updateMany` updated every node,
 * a `_SOME` relationship filter matched any related node, and a policy
 * `when: () => ({ mode: 'light' })` compiled to `true`.
 *
 * Opt-in on NEO4J_URI. Every node carries this run's `runId` and is
 * removed in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive, restrictive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

type Row = Record<string, unknown>;

const typeDefs = /* GraphQL */ `
  type ItWmTheme @node {
    id: ID! @unique
    runId: String
    mode: String
    name: String
    owner: ItWmUser @relationship(type: "IT_WM_OWNS", direction: IN)
  }
  type ItWmUser @node {
    id: ID! @unique
    runId: String
    name: String
    themes: [ItWmTheme!]! @relationship(type: "IT_WM_OWNS", direction: OUT)
  }
`;

describeLive('live: where `mode` on a type with a `mode` field', () => {
  let driver: Driver;
  const runId = randomUUID();

  const ids = (rows: Row[]) => rows.map((r) => r.id as string).sort();

  const seed = async () => {
    const session = driver.session();
    try {
      await session.run('MATCH (n {runId: $runId}) DETACH DELETE n', {
        runId,
      });
      await session.run(
        `CREATE (u1:ItWmUser {id: 'u-dark', runId: $runId})
         CREATE (u2:ItWmUser {id: 'u-light', runId: $runId})
         CREATE (u1)-[:IT_WM_OWNS]->(:ItWmTheme {id: 't-dark', runId: $runId, mode: 'dark', name: 'Night'})
         CREATE (u2)-[:IT_WM_OWNS]->(:ItWmTheme {id: 't-light', runId: $runId, mode: 'light', name: 'Day'})
         CREATE (:ItWmTheme {id: 't-insensitive', runId: $runId, mode: 'insensitive', name: 'x'})`,
        { runId },
      );
    } finally {
      await session.close();
    }
  };

  const remaining = async (): Promise<string[]> => {
    const session = driver.session();
    try {
      const res = await session.run(
        'MATCH (n:ItWmTheme {runId: $runId}) RETURN n.id AS id ORDER BY id',
        { runId },
      );
      return res.records.map((r) => r.get('id') as string);
    } finally {
      await session.close();
    }
  };

  beforeAll(() => {
    driver = neo4j.driver(
      URI as string,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
    );
  });

  beforeEach(seed);

  afterAll(async () => {
    const session = driver.session();
    try {
      await session.run('MATCH (n {runId: $runId}) DETACH DELETE n', {
        runId,
      });
    } finally {
      await session.close();
    }
    await driver.close();
  });

  it.each([false, true])(
    'find / deleteMany / updateMany filter on `mode` (strict: %s)',
    async (strict) => {
      const ogm = new OGM({ typeDefs, driver, strict });
      const Theme = ogm.model('ItWmTheme');

      expect(ids(await Theme.find({ where: { runId, mode: 'dark' } }))).toEqual(
        ['t-dark'],
      );
      // `insensitive` is a value of the field here, not the switch.
      expect(
        ids(await Theme.find({ where: { runId, mode: 'insensitive' } })),
      ).toEqual(['t-insensitive']);

      await Theme.updateMany({
        where: { runId, mode: 'dark' },
        data: { name: 'Renamed' },
      });
      const renamed = await Theme.find({
        where: { runId, name: 'Renamed' },
      });
      expect(ids(renamed)).toEqual(['t-dark']);

      await Theme.deleteMany({ where: { runId, mode: 'dark' } });
      expect(await remaining()).toEqual(['t-insensitive', 't-light']);
    },
  );

  it('a `_SOME` relationship filter on `mode` filters the related node', async () => {
    const ogm = new OGM({ typeDefs, driver });
    const User = ogm.model('ItWmUser');
    expect(
      ids(await User.find({ where: { runId, themes_SOME: { mode: 'dark' } } })),
    ).toEqual(['u-dark']);
  });

  it('a nested delete where on `mode` deletes only the matching node', async () => {
    const ogm = new OGM({ typeDefs, driver });
    const User = ogm.model('ItWmUser');
    await User.update({
      where: { id: 'u-dark' },
      update: {
        themes: [{ delete: [{ where: { node: { mode: 'light' } } }] }],
      },
    });
    expect(await remaining()).toEqual(['t-dark', 't-insensitive', 't-light']);
  });

  it('a restrictive policy on `mode` restricts the read', async () => {
    const ogm = new OGM({
      typeDefs,
      driver,
      policies: {
        ItWmTheme: [
          permissive({ operations: ['read'], when: () => ({}) }),
          restrictive({
            operations: ['read'],
            when: () => ({ mode: 'light' }),
          }),
        ],
      },
    });
    const Theme = ogm.withContext({}).model('ItWmTheme');
    expect(ids(await Theme.find({ where: { runId } }))).toEqual(['t-light']);
  });
});
