/**
 * Live: a `@cypher` field whose type is a node, interface or union type,
 * projected as a whole value (selected bare, or `select: { f: true }`),
 * is filtered by the target type's `read` policy (vNEXT — security).
 *
 * Pre-vNEXT the statement's nodes were returned with every property and
 * no read policy of the target type, in default and strict mode, at the
 * root and nested, through Model and InterfaceModel.
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
  type ItNcUser @node {
    id: ID! @unique
    runId: String
    topPost: ItNcPost
      @cypher(
        statement: "MATCH (this)-[:IT_NC_AUTHORED]->(p:ItNcPost) RETURN p ORDER BY p.rank LIMIT 1"
        columnName: "p"
      )
    lastPost: ItNcPost
      @cypher(
        statement: "MATCH (this)-[:IT_NC_AUTHORED]->(p:ItNcPost) RETURN p ORDER BY p.rank DESC LIMIT 1"
        columnName: "p"
      )
    posts: [ItNcPost!]!
      @cypher(
        statement: "MATCH (this)-[:IT_NC_AUTHORED]->(p:ItNcPost) RETURN p ORDER BY p.rank"
        columnName: "p"
      )
    postList: [ItNcPost!]!
      @cypher(
        statement: "MATCH (this)-[:IT_NC_AUTHORED]->(p:ItNcPost) WITH p ORDER BY p.rank RETURN collect(p) AS ps"
        columnName: "ps"
      )
    firstContent: ItNcContent
      @cypher(
        statement: "MATCH (this)-[:IT_NC_AUTHORED]->(c) RETURN c ORDER BY c.rank LIMIT 1"
        columnName: "c"
      )
    contents: [ItNcContent!]!
      @cypher(
        statement: "MATCH (this)-[:IT_NC_AUTHORED]->(c) RETURN c ORDER BY c.rank"
        columnName: "c"
      )
    items: [ItNcItem!]!
      @cypher(
        statement: "MATCH (this)-[:IT_NC_AUTHORED]->(c) RETURN c ORDER BY c.rank"
        columnName: "c"
      )
    friends: [ItNcUser!]! @relationship(type: "IT_NC_FRIEND", direction: OUT)
  }
  interface ItNcContent {
    id: ID!
    rank: Int
  }
  union ItNcItem = ItNcPost | ItNcDoc
  type ItNcPost implements ItNcContent @node {
    id: ID! @unique
    runId: String
    rank: Int
    ownerId: String
  }
  type ItNcDoc implements ItNcContent @node {
    id: ID! @unique
    runId: String
    rank: Int
    visible: Boolean
    lead: ItNcPost
      @cypher(
        statement: "MATCH (p:ItNcPost {runId: this.runId}) RETURN p ORDER BY p.rank, p.ownerId DESC LIMIT 1"
        columnName: "p"
      )
  }
`;

describeLive('NLS — node-typed @cypher field projected bare (live)', () => {
  const runId = `it-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;
  let driver: Driver;

  const ogm = (strict?: boolean) =>
    new OGM({
      typeDefs,
      driver,
      strict,
      logger: { warn: () => undefined, debug: () => undefined },
      policies: {
        ItNcPost: [
          permissive({
            operations: ['read'],
            when: (c) => ({ ownerId: c.userId as string }),
          }),
        ],
        ItNcDoc: [
          permissive({ operations: ['read'], when: () => ({ visible: true }) }),
        ],
      },
    });
  const users = (strict?: boolean) =>
    ogm(strict).withContext({ userId: 'u1' }).model('ItNcUser');
  const ids = (v: unknown) =>
    (v as Row[] | null)?.map((r) => (r.id as string).replace(`${runId}-`, ''));
  const one = async (
    selectionSet: string,
    strict?: boolean,
    who = 'a',
  ): Promise<Row> => {
    const rows = (await users(strict).find({
      where: { id: id(who) },
      selectionSet,
    })) as Row[];
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    const session = driver.session();
    try {
      // a: p1 (hidden, rank 1), p2 (visible), d1 (hidden), d2 (visible).
      // b: p4 (visible, rank 1), p3 (hidden). a -> b.
      await session.run(
        `CREATE (a:ItNcUser {id: $runId + '-a', runId: $runId}),
                (b:ItNcUser {id: $runId + '-b', runId: $runId}),
                (a)-[:IT_NC_FRIEND]->(b),
                (a)-[:IT_NC_AUTHORED]->(:ItNcPost:ItNcContent {id: $runId + '-p1', runId: $runId, rank: 1, ownerId: 'u2'}),
                (a)-[:IT_NC_AUTHORED]->(:ItNcPost:ItNcContent {id: $runId + '-p2', runId: $runId, rank: 2, ownerId: 'u1'}),
                (a)-[:IT_NC_AUTHORED]->(:ItNcDoc:ItNcContent {id: $runId + '-d1', runId: $runId, rank: 3, visible: false}),
                (a)-[:IT_NC_AUTHORED]->(:ItNcDoc:ItNcContent {id: $runId + '-d2', runId: $runId, rank: 4, visible: true}),
                (b)-[:IT_NC_AUTHORED]->(:ItNcPost:ItNcContent {id: $runId + '-p4', runId: $runId, rank: 1, ownerId: 'u1'}),
                (b)-[:IT_NC_AUTHORED]->(:ItNcPost:ItNcContent {id: $runId + '-p3', runId: $runId, rank: 2, ownerId: 'u2'})`,
        { runId },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      await session.run(
        'MATCH (n) WHERE n.runId = $runId AND (n:ItNcUser OR n:ItNcPost OR n:ItNcDoc) DETACH DELETE n',
        { runId },
      );
    } finally {
      await session.close();
    }
    await driver.close();
  });

  it('control: ItNcPost.find returns only the visible posts', async () => {
    const rows = (await ogm()
      .withContext({ userId: 'u1' })
      .model('ItNcPost')
      .find({ where: { runId }, selectionSet: '{ id }' })) as Row[];
    expect(ids(rows)?.sort()).toEqual(['p2', 'p4']);
  });

  describe.each([
    ['default', undefined],
    ['strict', true],
  ])('%s mode', (_label, strict) => {
    it('single field: a hidden node is null, a visible one is returned', async () => {
      expect((await one('{ topPost }', strict)).topPost).toBeNull();
      const b = await one('{ topPost }', strict, 'b');
      expect((b.topPost as Row).id).toBe(id('p4'));
    });

    it('select: { topPost: true, posts: true }', async () => {
      const rows = (await users(strict).find({
        where: { id: id('a') },
        select: { topPost: true, posts: true },
      })) as Row[];
      expect(rows[0].topPost).toBeNull();
      if (strict) expect(ids(rows[0].posts)).toEqual(['p2']);
      else expect(rows[0].posts).toBeNull(); // first row: p1, hidden
    });

    it('list field: hidden elements are removed', async () => {
      const row = await one('{ posts postList }', strict);
      if (strict) expect(ids(row.posts)).toEqual(['p2']);
      else expect(row.posts).toBeNull(); // first row only: p1, hidden
      // A statement returning one list row: filtered in both modes.
      expect(ids(row.postList)).toEqual(['p2']);
    });

    it('interface / union targets: each member applies its own policy', async () => {
      const row = await one('{ firstContent contents items }', strict);
      expect(row.firstContent).toBeNull(); // p1, hidden
      if (strict) {
        expect(ids(row.contents)).toEqual(['p2', 'd2']);
        expect(ids(row.items)).toEqual(['p2', 'd2']);
      } else {
        expect(row.contents).toBeNull();
        expect(row.items).toBeNull();
      }
    });

    it('nested inside a relationship and a connection', async () => {
      const row = await one(
        '{ friends { topPost lastPost posts } friendsConnection { edges { node { topPost lastPost posts } } } }',
        strict,
      );
      const friend = (row.friends as Row[])[0];
      expect((friend.topPost as Row).id).toBe(id('p4'));
      expect(friend.lastPost).toBeNull(); // p3, hidden
      if (strict) expect(ids(friend.posts)).toEqual(['p4']);
      else expect((friend.posts as Row).id).toBe(id('p4'));
      const node = (row.friendsConnection as { edges: { node: Row }[] })
        .edges[0].node;
      expect((node.topPost as Row).id).toBe(id('p4'));
      expect(node.lastPost).toBeNull();
      if (strict) expect(ids(node.posts)).toEqual(['p4']);
      else expect((node.posts as Row).id).toBe(id('p4'));
    });

    it('a mutation projection is filtered too', async () => {
      const res = (await users(strict).update({
        where: { id: id('a') },
        update: { runId },
        selectionSet: '{ itNcUsers { topPost postList } }',
      })) as Record<string, Row[]>;
      const updated = res.itNcUsers;
      expect(updated).toHaveLength(1);
      expect(updated[0].topPost).toBeNull();
      expect(ids(updated[0].postList)).toEqual(['p2']);
    });

    it('InterfaceModel: a member fragment selecting the field bare', async () => {
      const rows = (await ogm(strict)
        .withContext({ userId: 'u1' })
        .interfaceModel('ItNcContent')
        .find({
          where: { id: id('d2') },
          selectionSet: '{ id ... on ItNcDoc { lead } }',
        })) as Row[];
      expect(rows).toHaveLength(1);
      // lead = p1 (rank 1, owner u2): hidden.
      expect(rows[0].lead).toBeNull();
    });

    it('unsafe.bypassPolicies still returns every node', async () => {
      const rows = (await users(strict).find({
        where: { id: id('a') },
        selectionSet: '{ topPost postList }',
        unsafe: { bypassPolicies: true },
      })) as Row[];
      expect((rows[0].topPost as Row).id).toBe(id('p1'));
      expect(ids(rows[0].postList)).toEqual(['p1', 'p2']);
    });
  });

  it('an OGM without policies returns every node', async () => {
    const plain = new OGM({
      typeDefs,
      driver,
      logger: { warn: () => undefined, debug: () => undefined },
    });
    const rows = (await plain.model('ItNcUser').find({
      where: { id: id('a') },
      selectionSet: '{ topPost postList }',
    })) as Row[];
    expect((rows[0].topPost as Row).id).toBe(id('p1'));
    expect(ids(rows[0].postList)).toEqual(['p1', 'p2']);
  });
});
