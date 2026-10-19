/**
 * Live: typed `select` `where` / `orderBy` on a relationship selected under
 * a UNION parent (v2.8.0).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed in `afterAll`.
 *
 * `items: { select: { tags: { select, where } } }` with `items` a union:
 * each member's `tags` compiles to its own `CASE` branch, which never read
 * the `where` (nor `orderBy`), so every related node came back. Honouring
 * it filters rows, so 2.x keeps that result and warns once; `strict: true`
 * applies it per member, with the target's read policy.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { Model } from '../../src/model';
import { OGM } from '../../src/ogm';
import { permissive, restrictive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(120_000);

const typeDefs = /* GraphQL */ `
  type ItUwTag @node {
    id: ID! @unique
    runId: String
    name: String
    secret: Boolean
  }
  type ItUwPost @node {
    id: ID! @unique
    runId: String
    title: String
    tags: [ItUwTag!]! @relationship(type: "IT_UW_TAGGED", direction: OUT)
  }
  type ItUwVideo @node {
    id: ID! @unique
    runId: String
    title: String
    tags: [ItUwTag!]! @relationship(type: "IT_UW_LABELED", direction: OUT)
  }
  union ItUwMedia = ItUwPost | ItUwVideo
  type ItUwFeed @node {
    id: ID! @unique
    runId: String
    items: [ItUwMedia!]! @relationship(type: "IT_UW_HAS", direction: OUT)
  }
`;

const policies = {
  ItUwTag: [
    permissive({ operations: ['read'], name: 'tag.read', when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'tag.no-secret',
      when: () => ({ secret: false }),
    }),
  ],
};

type Row = Record<string, unknown>;

describeLive('typed select where under a union parent — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const feedId = `${runId}-feed`;
  let driver: Driver;

  function make(opts: { strict?: boolean; secured?: boolean } = {}) {
    const logger = { debug: jest.fn(), warn: jest.fn() };
    const ogm = new OGM({
      typeDefs,
      driver,
      logger,
      ...(opts.strict === undefined ? {} : { strict: opts.strict }),
      ...(opts.secured ? { policies } : {}),
    });
    const bound = opts.secured ? ogm.withContext({}) : ogm;
    return { logger, feed: bound.model('ItUwFeed') };
  }

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    await driver.verifyConnectivity();
    const session = driver.session();
    try {
      await session.run(
        `CREATE (f:ItUwFeed {id: $feedId, runId: $runId})
         CREATE (p:ItUwPost {id: $runId + '-p', runId: $runId, title: 'post'})
         CREATE (v:ItUwVideo {id: $runId + '-v', runId: $runId, title: 'video'})
         CREATE (f)-[:IT_UW_HAS]->(p)
         CREATE (f)-[:IT_UW_HAS]->(v)
         CREATE (p)-[:IT_UW_TAGGED]->(:ItUwTag {id: $runId + '-t1', runId: $runId, name: 'alpha', secret: false})
         CREATE (p)-[:IT_UW_TAGGED]->(:ItUwTag {id: $runId + '-t2', runId: $runId, name: 'beta', secret: false})
         CREATE (p)-[:IT_UW_TAGGED]->(:ItUwTag {id: $runId + '-t3', runId: $runId, name: 'apex', secret: true})
         CREATE (v)-[:IT_UW_LABELED]->(:ItUwTag {id: $runId + '-t4', runId: $runId, name: 'arc', secret: false})
         CREATE (v)-[:IT_UW_LABELED]->(:ItUwTag {id: $runId + '-t5', runId: $runId, name: 'zed', secret: false})`,
        { runId, feedId },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (driver) {
      const session = driver.session();
      try {
        await session.run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n', {
          runId,
        });
      } finally {
        await session.close();
      }
      await driver.close();
    }
  });

  beforeEach(() => Model.clearSelectionCache());

  const select = {
    items: {
      select: {
        title: true,
        tags: {
          select: { name: true },
          where: { name_STARTS_WITH: 'a' },
        },
      },
    },
  };

  /** `title → sorted tag names` of the feed's items. */
  async function tagsByItem(feed: Model): Promise<Record<string, string[]>> {
    const rows = (await feed.find({
      where: { id: feedId },
      select,
    } as never)) as Row[];
    expect(rows).toHaveLength(1);
    const out: Record<string, string[]> = {};
    for (const item of rows[0].items as Row[])
      out[item.title as string] = (item.tags as Row[])
        .map((t) => t.name as string)
        .sort();
    return out;
  }

  it('default mode: v2.7.0 result (where ignored) + one warning', async () => {
    const { feed, logger } = make();
    for (let i = 0; i < 2; i++)
      expect(await tagsByItem(feed)).toEqual({
        post: ['alpha', 'apex', 'beta'],
        video: ['arc', 'zed'],
      });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = String(logger.warn.mock.calls[0][0]);
    expect(message).toContain(
      'The select `where` on "tags", selected under the union "ItUwMedia", is ignored in 2.x: every related node is returned.',
    );
    expect(message).toContain('Enable `strict: true` (default in 3.0)');
  });

  it('strict: the where applies to every member', async () => {
    const { feed, logger } = make({ strict: true });
    expect(await tagsByItem(feed)).toEqual({
      post: ['alpha', 'apex'],
      video: ['arc'],
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('strict: with the target read policy', async () => {
    const { feed } = make({ strict: true, secured: true });
    expect(await tagsByItem(feed)).toEqual({
      post: ['alpha'],
      video: ['arc'],
    });
  });

  it('default mode keeps applying the read policy', async () => {
    const { feed } = make({ secured: true });
    expect(await tagsByItem(feed)).toEqual({
      post: ['alpha', 'beta'],
      video: ['arc', 'zed'],
    });
  });
});
