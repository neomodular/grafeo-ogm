/**
 * Live: a `<rel>Connection` selected under a UNION parent (v2.9.0, strict).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed in `afterAll`.
 *
 * The union's merged definition carries the relationship of its first
 * member, so `items { tagsConnection }` reads every member's connection
 * through `ItUcPost.tags` (`-[:IT_UC_TAGGED]->`). `ItUcVideo` declares
 * `tags` as `<-[:IT_UC_LABELED]-`: its edges come back empty, or — through
 * an undeclared `IT_UC_TAGGED` edge — wrong. Correcting that changes rows,
 * so 2.x keeps it and warns; `strict: true` reads each member through its
 * own relationship.
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
  type ItUcTag @node {
    id: ID! @unique
    runId: String
    name: String
    secret: Boolean
  }
  type ItUcTagged @relationshipProperties {
    weight: Int
  }
  type ItUcPost @node {
    id: ID! @unique
    runId: String
    title: String
    tags: [ItUcTag!]!
      @relationship(
        type: "IT_UC_TAGGED"
        direction: OUT
        properties: "ItUcTagged"
      )
  }
  type ItUcVideo @node {
    id: ID! @unique
    runId: String
    title: String
    tags: [ItUcTag!]! @relationship(type: "IT_UC_LABELED", direction: IN)
  }
  type ItUcAudio @node {
    id: ID! @unique
    runId: String
    title: String
    tags: [ItUcTag!]!
      @relationship(
        type: "IT_UC_TAGGED"
        direction: OUT
        properties: "ItUcTagged"
      )
  }
  union ItUcMedia = ItUcPost | ItUcVideo | ItUcAudio
  type ItUcFeed @node {
    id: ID! @unique
    runId: String
    items: [ItUcMedia!]! @relationship(type: "IT_UC_HAS", direction: OUT)
  }
`;

const policies = {
  ItUcTag: [
    permissive({ operations: ['read'], name: 'tag.read', when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'tag.no-secret',
      when: () => ({ secret: false }),
    }),
  ],
};

type Row = Record<string, unknown>;

describeLive('connection under a union parent — live Neo4j', () => {
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
    return { logger, feed: bound.model('ItUcFeed') };
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
        `CREATE (f:ItUcFeed {id: $feedId, runId: $runId})
         CREATE (p:ItUcPost {id: $runId + '-p', runId: $runId, title: 'post'})
         CREATE (v:ItUcVideo {id: $runId + '-v', runId: $runId, title: 'video'})
         CREATE (a:ItUcAudio {id: $runId + '-a', runId: $runId, title: 'audio'})
         CREATE (f)-[:IT_UC_HAS]->(p)
         CREATE (f)-[:IT_UC_HAS]->(v)
         CREATE (f)-[:IT_UC_HAS]->(a)
         CREATE (p)-[:IT_UC_TAGGED {weight: 1}]->(:ItUcTag {id: $runId + '-t1', runId: $runId, name: 'alpha', secret: false})
         CREATE (p)-[:IT_UC_TAGGED {weight: 2}]->(:ItUcTag {id: $runId + '-t2', runId: $runId, name: 'beta', secret: false})
         CREATE (v)<-[:IT_UC_LABELED]-(:ItUcTag {id: $runId + '-t3', runId: $runId, name: 'arc', secret: false})
         CREATE (v)<-[:IT_UC_LABELED]-(:ItUcTag {id: $runId + '-t4', runId: $runId, name: 'zed', secret: false})
         CREATE (v)<-[:IT_UC_LABELED]-(:ItUcTag {id: $runId + '-t5', runId: $runId, name: 'apex', secret: true})
         CREATE (v)-[:IT_UC_TAGGED {weight: 9}]->(:ItUcTag {id: $runId + '-t6', runId: $runId, name: 'decoy', secret: false})
         CREATE (a)-[:IT_UC_TAGGED {weight: 3}]->(:ItUcTag {id: $runId + '-t7', runId: $runId, name: 'aria', secret: false})`,
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

  /** `title → sorted tag names` of the feed's items, from `tagsConnection`. */
  async function namesByItem(
    feed: Model,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const rows = (await feed.find({
      where: { id: feedId },
      ...params,
    } as never)) as Row[];
    expect(rows).toHaveLength(1);
    const out: Record<string, unknown> = {};
    for (const item of rows[0].items as Row[]) {
      const conn = item.tagsConnection as Row;
      out[item.title as string] = conn.edges
        ? (conn.edges as Row[]).map((e) => (e.node as Row).name).sort()
        : conn.totalCount;
    }
    return out;
  }

  const select = {
    items: {
      select: {
        title: true,
        tagsConnection: {
          select: { edges: { node: { select: { name: true } } } },
        },
      },
    },
  };

  const fragments = `{
    items {
      ... on ItUcPost { title tagsConnection { edges { node { name } } } }
      ... on ItUcVideo { title tagsConnection { edges { node { name } } } }
      ... on ItUcAudio { title tagsConnection { edges { node { name } } } }
    }
  }`;

  /** What 2.x returns: ItUcVideo read through `-[:IT_UC_TAGGED]->`. */
  const v280 = { post: ['alpha', 'beta'], video: ['decoy'], audio: ['aria'] };
  const correct = {
    post: ['alpha', 'beta'],
    video: ['apex', 'arc', 'zed'],
    audio: ['aria'],
  };

  function unionWarnings(logger: { warn: jest.Mock }): string[] {
    return logger.warn.mock.calls
      .map(([m]) => String(m))
      .filter((m) => m.includes('is read in 2.x through the relationship'));
  }

  describe('default (2.x)', () => {
    it('typed select keeps the v2.8.0 result and warns once', async () => {
      const { feed, logger } = make();
      expect(await namesByItem(feed, { select })).toEqual(v280);
      expect(await namesByItem(feed, { selectionSet: fragments })).toEqual(
        v280,
      );
      expect(unionWarnings(logger)).toEqual([
        '[OGM] "tagsConnection", selected under the union "ItUcMedia", is read in 2.x through the relationship ' +
          'of its first member "ItUcPost" for every member, so the edges of "ItUcVideo" are wrong or missing. ' +
          'Enable `strict: true` (default in 3.0) to read each member through its own relationship.',
      ]);
    });
  });

  describe('strict', () => {
    it('typed select reads each member through its own relationship', async () => {
      const { feed, logger } = make({ strict: true });
      expect(await namesByItem(feed, { select })).toEqual(correct);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('selectionSet fragments read each member through its own relationship', async () => {
      const { feed } = make({ strict: true });
      expect(await namesByItem(feed, { selectionSet: fragments })).toEqual(
        correct,
      );
    });

    it('totalCount and edge properties follow the member relationship', async () => {
      const { feed } = make({ strict: true });
      const rows = (await feed.find({
        where: { id: feedId },
        selectionSet: `{
          items {
            ... on ItUcPost { title tagsConnection { totalCount } }
            ... on ItUcVideo { title tagsConnection { totalCount } }
            ... on ItUcAudio { title tagsConnection { totalCount } }
          }
        }`,
      })) as Row[];
      const byTitle = Object.fromEntries(
        (rows[0].items as Row[]).map((i) => [i.title, i.tagsConnection as Row]),
      );
      expect(byTitle.post.totalCount).toBe(2);
      expect(byTitle.video.totalCount).toBe(3);
      expect(byTitle.audio.totalCount).toBe(1);
      // Edge properties on the member that has them (selected on its own:
      // merged with fragments on members without edge properties, strict
      // rejects `weight` as unknown for those members).
      const [withProps] = (await feed.find({
        where: { id: feedId },
        selectionSet: `{ items { ... on ItUcAudio { title tagsConnection { edges { properties { weight } } } } } }`,
      })) as Row[];
      const audio = (withProps.items as Row[]).find(
        (i) => i.title === 'audio',
      )!;
      expect(
        ((audio.tagsConnection as Row).edges as Row[]).map(
          (e) => (e.properties as Row).weight,
        ),
      ).toEqual([3]);
    });

    it('applies the connection where per member', async () => {
      const { feed } = make({ strict: true });
      const filtered = {
        items: {
          select: {
            title: true,
            tagsConnection: {
              where: { node: { name_STARTS_WITH: 'a' } },
              select: { edges: { node: { select: { name: true } } } },
            },
          },
        },
      };
      expect(await namesByItem(feed, { select: filtered })).toEqual({
        post: ['alpha'],
        video: ['apex', 'arc'],
        audio: ['aria'],
      });
    });

    it("applies the target's read policy in every member branch", async () => {
      const { feed } = make({ strict: true, secured: true });
      expect(await namesByItem(feed, { select })).toEqual({
        post: ['alpha', 'beta'],
        video: ['arc', 'zed'],
        audio: ['aria'],
      });
    });
  });
});
