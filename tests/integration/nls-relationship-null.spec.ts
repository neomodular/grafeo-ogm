/**
 * Live: `rel: null` / `rel_NOT: null` count only the related nodes the
 * caller may see (v2.28.1 — security).
 *
 * Pre-2.28.1 the `EXISTS { MATCH … }` of a relationship null filter had no
 * target `read` policy, so `charts_NOT: null` returned a tag whose only
 * chart was hidden (and `charts: null` dropped it), revealing that the
 * hidden chart exists. `_SOME` / `_NONE` already applied the policy.
 * Covered: root, one hop deeper, a selectionSet `where` argument, and an
 * interface target (per-member policy).
 *
 * Opt-in on NEO4J_URI. Every node carries this run's `runId` and is
 * removed in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

type Row = Record<string, unknown>;

const typeDefs = /* GraphQL */ `
  type ItRnUser @node {
    id: ID! @unique
    runId: String
    tags: [ItRnTag!]! @relationship(type: "IT_RN_USES", direction: OUT)
  }
  type ItRnTag @node {
    id: ID! @unique
    runId: String
    charts: [ItRnChart!]! @relationship(type: "IT_RN_TAGS", direction: OUT)
    items: [ItRnContent!]! @relationship(type: "IT_RN_HAS", direction: OUT)
  }
  interface ItRnContent {
    id: ID!
  }
  type ItRnChart implements ItRnContent @node {
    id: ID! @unique
    runId: String
    secret: Boolean
  }
  type ItRnNote implements ItRnContent @node {
    id: ID! @unique
    runId: String
  }
`;

const policies = {
  ItRnChart: [
    permissive({ operations: ['read'], when: () => ({ secret: false }) }),
  ],
};

describeLive('live: relationship null filters apply the target policy', () => {
  let driver: Driver;
  const runId = randomUUID();

  const ids = (rows: Row[]) => rows.map((r) => r.id as string).sort();

  beforeAll(async () => {
    driver = neo4j.driver(
      URI as string,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
    );
    const session = driver.session();
    try {
      await session.run(
        `CREATE (secret:ItRnChart {id: 'c-secret', runId: $runId, secret: true})
         CREATE (pub:ItRnChart {id: 'c-public', runId: $runId, secret: false})
         CREATE (note:ItRnNote {id: 'n-1', runId: $runId})
         CREATE (t1:ItRnTag {id: 't-secret', runId: $runId})-[:IT_RN_TAGS]->(secret)
         CREATE (t1)-[:IT_RN_HAS]->(secret)
         CREATE (t2:ItRnTag {id: 't-public', runId: $runId})-[:IT_RN_TAGS]->(pub)
         CREATE (t2)-[:IT_RN_HAS]->(note)
         CREATE (:ItRnTag {id: 't-none', runId: $runId})
         CREATE (:ItRnUser {id: 'u-secret', runId: $runId})-[:IT_RN_USES]->(t1)
         CREATE (:ItRnUser {id: 'u-public', runId: $runId})-[:IT_RN_USES]->(t2)`,
        { runId },
      );
    } finally {
      await session.close();
    }
  });

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
    'root `charts_NOT: null` / `charts: null` (strict: %s)',
    async (strict) => {
      const ogm = new OGM({ typeDefs, driver, policies, strict });
      const Tag = ogm.withContext({}).model('ItRnTag');
      expect(
        ids(await Tag.find({ where: { runId, charts_NOT: null } })),
      ).toEqual(['t-public']);
      expect(ids(await Tag.find({ where: { runId, charts: null } }))).toEqual([
        't-none',
        't-secret',
      ]);
      // Same answers as the quantifiers, which already applied the policy.
      expect(
        ids(await Tag.find({ where: { runId, charts_SOME: {} } })),
      ).toEqual(['t-public']);
      expect(await Tag.count({ where: { runId, charts_NOT: null } })).toBe(1);
    },
  );

  it('one hop deeper: `tags_SOME: { charts_NOT: null }`', async () => {
    const ogm = new OGM({ typeDefs, driver, policies });
    const User = ogm.withContext({}).model('ItRnUser');
    expect(
      ids(
        await User.find({
          where: { runId, tags_SOME: { charts_NOT: null } },
        }),
      ),
    ).toEqual(['u-public']);
  });

  it('a selectionSet `where` argument', async () => {
    const ogm = new OGM({ typeDefs, driver, policies });
    const User = ogm.withContext({}).model('ItRnUser');
    const rows = (await User.find({
      where: { runId },
      selectionSet: '{ id tags(where: { charts_NOT: null }) { id } }',
    })) as Row[];
    const byId = Object.fromEntries(
      rows.map((r) => [r.id, ids(r.tags as Row[])]),
    );
    expect(byId).toEqual({ 'u-public': ['t-public'], 'u-secret': [] });
  });

  it.each([false, true])(
    'an interface target applies each member policy (strict: %s)',
    async (strict) => {
      const ogm = new OGM({ typeDefs, driver, policies, strict });
      const Tag = ogm.withContext({}).model('ItRnTag');
      expect(
        ids(await Tag.find({ where: { runId, items_NOT: null } })),
      ).toEqual(['t-public']);
      expect(ids(await Tag.find({ where: { runId, items: null } }))).toEqual([
        't-none',
        't-secret',
      ]);
    },
  );
});
