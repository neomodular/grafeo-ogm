/**
 * Shared schema, policies and live-database harness for the read-path
 * suites (v2.4.8). Every live spec under `tests/integration/read-*.spec.ts`
 * builds its OGM from this schema, tags every node it creates with its own
 * `runId` and removes them in `afterAll`, so the suites are safe to point
 * at a shared development database. Labels and indexes are `Lb`-prefixed.
 *
 * - `LbUser`  — the root. `posts` carries edge properties (`LbWrote`, with
 *               a relationship fulltext index); `things` targets an
 *               interface, `items` a union. `postCount` is an AGGREGATING
 *               `@cypher` field.
 * - `LbPost`  — read policy hides `secret: true` posts.
 * - `LbDoc`   — interface implementer with its own `@cypher` field.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive, restrictive } from '../../src/policy/types';

export const typeDefs = /* GraphQL */ `
  interface LbThing {
    id: ID!
    runId: String
    rank: Int
  }
  type LbWrote
    @relationshipProperties
    @fulltext(indexes: [{ name: "LbWroteNoteSearch", fields: ["note"] }]) {
    note: String
    stars: Int
  }
  union LbItem = LbPost | LbDoc
  type LbUser @node {
    id: ID! @unique
    runId: String
    name: String
    internetConnection: String
    big: BigInt
    at: DateTime
    loc: Point
    posts: [LbPost!]!
      @relationship(type: "LB_WROTE", direction: OUT, properties: "LbWrote")
    items: [LbItem!]! @relationship(type: "LB_HAS_ITEM", direction: OUT)
    things: [LbThing!]! @relationship(type: "LB_HAS_THING", direction: OUT)
    friends: [LbUser!]! @relationship(type: "LB_FRIEND", direction: OUT)
    postCount: Int
      @cypher(
        statement: "MATCH (this)-[:LB_WROTE]->(p) RETURN count(p) AS postCount"
        columnName: "postCount"
      )
  }
  type LbPost implements LbThing @node {
    id: ID! @unique
    runId: String
    rank: Int
    title: String
    secret: Boolean
    author: LbUser @relationship(type: "LB_WROTE", direction: IN)
  }
  type LbDoc implements LbThing @node {
    id: ID! @unique
    runId: String
    rank: Int
    dcount: Int
      @cypher(
        statement: "RETURN this.rank * 10 AS dcount"
        columnName: "dcount"
      )
    owners: Int
      @cypher(
        statement: "MATCH (this)<-[:LB_HAS_THING]-(u) RETURN count(u) AS owners"
        columnName: "owners"
      )
  }
`;

export const policies = {
  LbPost: [
    permissive({ operations: ['read'], name: 'post.read', when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'post.no-secret',
      when: () => ({ secret: false }),
    }),
  ],
};

export const URI = process.env.NEO4J_URI;
export const describeLive = URI ? describe : describe.skip;

export type Row = Record<string, unknown>;

/**
 * Live harness: a lossy-integer driver (as the examples use), a raw
 * `run()` that always binds `$runId`, and `ogm` / `secured` OGMs over the
 * shared schema — `secured` carries the `LbPost` read policy.
 */
export function liveHarness(opts: { lossless?: boolean } = {}) {
  const runId = `lb-${randomUUID()}`;
  const h = {
    runId,
    id: (suffix: string) => `${runId}-${suffix}`,
    driver: undefined as unknown as Driver,
    ogm: undefined as unknown as OGM,
    secured: undefined as unknown as OGM,
    async run(cypher: string, params: Row = {}): Promise<Row[]> {
      const session = h.driver.session();
      try {
        const res = await session.run(cypher, { runId, ...params });
        return res.records.map((r) => r.toObject());
      } finally {
        await session.close();
      }
    },
    async setup(): Promise<void> {
      h.driver = neo4j.driver(
        URI!,
        neo4j.auth.basic(
          process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
          process.env.NEO4J_PASSWORD ?? 'password',
        ),
        { disableLosslessIntegers: !opts.lossless },
      );
      await h.driver.verifyConnectivity();
      h.ogm = new OGM({ typeDefs, driver: h.driver });
      h.secured = new OGM({ typeDefs, driver: h.driver, policies });
    },
    async teardown(): Promise<void> {
      if (!h.driver) return;
      await h.run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await h.driver.close();
    },
  };
  return h;
}
