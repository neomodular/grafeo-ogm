/**
 * Live: a node-typed `@cypher` field (its type a node, interface or union
 * type) used in a where filter or as a sort key is evaluated on its value
 * filtered by the target type's `read` policy, the value the selection
 * returns since v2.20.1 (v2.22.1 — security).
 *
 * Pre-2.22.1 the filter and the sort read the statement's raw value, so a
 * caller learned whether a node the target's policy hides exists:
 * `topPost_NOT: null`, `posts: []`, `friends_SOME: { topPost_NOT: null }`,
 * `count`, `aggregate`, `options.sort: [{ topPost: … }]`, through Model and
 * InterfaceModel, in default and strict mode.
 *
 * Opt-in on NEO4J_URI (nested sort: NEO4J_APOC_URI, it needs
 * `apoc.coll.sortMulti`). Every node carries this run's `runId` and is
 * removed in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const APOC_URI = process.env.NEO4J_APOC_URI;
const describeLive = URI ? describe : describe.skip;
const describeApoc = APOC_URI ? describe : describe.skip;

jest.setTimeout(60_000);

type Row = Record<string, unknown>;

const AUTHORED = 'MATCH (this)-[:IT_NF_AUTHORED]->(p:ItNfPost)';
const typeDefs = /* GraphQL */ `
  interface ItNfPerson {
    id: ID!
    topPost: ItNfPost
      @cypher(
        statement: "${AUTHORED} RETURN p ORDER BY p.rank LIMIT 1"
        columnName: "p"
      )
  }
  type ItNfUser implements ItNfPerson @node {
    id: ID! @unique
    runId: String
    score: Int
    topPost: ItNfPost
      @cypher(
        statement: "${AUTHORED} RETURN p ORDER BY p.rank LIMIT 1"
        columnName: "p"
      )
    posts: [ItNfPost!]!
      @cypher(statement: "${AUTHORED} RETURN p ORDER BY p.rank", columnName: "p")
    postList: [ItNfPost!]!
      @cypher(statement: "${AUTHORED} RETURN collect(p) AS ps", columnName: "ps")
    content: ItNfContent
      @cypher(
        statement: "MATCH (this)-[:IT_NF_AUTHORED]->(c) RETURN c ORDER BY c.rank LIMIT 1"
        columnName: "c"
      )
    friends: [ItNfUser!]! @relationship(type: "IT_NF_FRIEND", direction: OUT)
  }
  union ItNfContent = ItNfPost | ItNfDoc
  type ItNfPost @node {
    id: ID! @unique
    runId: String
    rank: Int
    ownerId: String
  }
  type ItNfDoc @node {
    id: ID! @unique
    runId: String
    rank: Int
    ownerId: String
  }
`;

function connect(uri: string, password?: string): Driver {
  return neo4j.driver(
    uri,
    neo4j.auth.basic(
      process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
      password ?? process.env.NEO4J_PASSWORD ?? 'password',
    ),
    { disableLosslessIntegers: true },
  );
}

/**
 * a: a hidden post. b: nothing. c: a visible post. d: a hidden doc.
 * y -> a, b (only hidden or no nodes). z -> a, b, c.
 */
async function seed(driver: Driver, runId: string): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `CREATE (a:ItNfUser {id: $runId + '-a', runId: $runId, score: 1}),
              (b:ItNfUser {id: $runId + '-b', runId: $runId, score: 2}),
              (c:ItNfUser {id: $runId + '-c', runId: $runId, score: 3}),
              (d:ItNfUser {id: $runId + '-d', runId: $runId, score: 4}),
              (y:ItNfUser {id: $runId + '-y', runId: $runId}),
              (z:ItNfUser {id: $runId + '-z', runId: $runId}),
              (a)-[:IT_NF_AUTHORED]->(:ItNfPost {id: $runId + '-pa', runId: $runId, rank: 1, ownerId: 'u2'}),
              (c)-[:IT_NF_AUTHORED]->(:ItNfPost {id: $runId + '-pc', runId: $runId, rank: 1, ownerId: 'u1'}),
              (d)-[:IT_NF_AUTHORED]->(:ItNfDoc {id: $runId + '-dd', runId: $runId, rank: 1, ownerId: 'u2'}),
              (y)-[:IT_NF_FRIEND]->(a), (y)-[:IT_NF_FRIEND]->(b),
              (z)-[:IT_NF_FRIEND]->(a), (z)-[:IT_NF_FRIEND]->(b), (z)-[:IT_NF_FRIEND]->(c)`,
      { runId },
    );
  } finally {
    await session.close();
  }
}

async function cleanup(driver: Driver, runId: string): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      'MATCH (n) WHERE n.runId = $runId AND (n:ItNfUser OR n:ItNfPost OR n:ItNfDoc) DETACH DELETE n',
      { runId },
    );
  } finally {
    await session.close();
  }
  await driver.close();
}

const policies = {
  ItNfPost: [
    permissive({
      operations: ['read'],
      when: (c) => ({ ownerId: c.userId as string }),
    }),
  ],
  ItNfDoc: [
    permissive({
      operations: ['read'],
      when: (c) => ({ ownerId: c.userId as string }),
    }),
  ],
};

const makeOgm = (driver: Driver, strict?: boolean) =>
  new OGM({
    typeDefs,
    driver,
    strict,
    logger: { warn: () => undefined, debug: () => undefined },
    policies,
  });

describeLive('NLS — node-typed @cypher field in where / sort (live)', () => {
  const runId = `it-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;
  const short = (rows: unknown) =>
    (rows as Row[]).map((r) => (r.id as string).replace(`${runId}-`, ''));
  const abcd = () => ['a', 'b', 'c', 'd'].map(id);
  let driver: Driver;

  beforeAll(async () => {
    driver = connect(URI!);
    await seed(driver, runId);
  });
  afterAll(() => cleanup(driver, runId));

  describe.each([
    ['default', undefined],
    ['strict', true],
  ])('%s mode', (_label, strict) => {
    const bound = () => makeOgm(driver, strict).withContext({ userId: 'u1' });
    const users = () => bound().model('ItNfUser');
    const find = async (where: Record<string, unknown>, options?: object) =>
      short(
        await users().find({
          where: { id_IN: abcd(), ...where },
          selectionSet: '{ id }',
          ...(options ? { options } : {}),
        }),
      );

    it('topPost: null / topPost_NOT: null treat a hidden node as null', async () => {
      expect((await find({ topPost: null })).sort()).toEqual(['a', 'b', 'd']);
      expect(await find({ topPost_NOT: null })).toEqual(['c']);
    });

    it('a union-typed field: a hidden member node is null', async () => {
      expect(await find({ content_NOT: null })).toEqual(['c']);
    });

    it('a list field compared with [] does not see hidden elements', async () => {
      expect((await find({ postList: [] })).sort()).toEqual(['a', 'b', 'd']);
      if (strict)
        expect((await find({ posts: [] })).sort()).toEqual(['a', 'b', 'd']);
    });

    it('relationship and connection filters reaching the field', async () => {
      const ids = [id('y'), id('z')];
      const rel = await users().find({
        where: { id_IN: ids, friends_SOME: { topPost_NOT: null } },
        selectionSet: '{ id }',
      });
      expect(short(rel)).toEqual(['z']);
      const conn = await users().find({
        where: {
          id_IN: ids,
          friendsConnection_SOME: { node: { topPost_NOT: null } },
        },
        selectionSet: '{ id }',
      });
      expect(short(conn)).toEqual(['z']);
    });

    it('count and aggregate', async () => {
      const where = { id_IN: abcd(), topPost_NOT: null };
      expect(await users().count({ where })).toBe(1);
      expect(
        await users().aggregate({ where, aggregate: { count: true } }),
      ).toEqual({ count: 1 });
    });

    it('options.sort orders a hidden node as null', async () => {
      const sort = { sort: [{ topPost: 'DESC' }, { id: 'ASC' }] };
      // vNEXT — strict item 47 (root sort): a node has no sort order.
      if (strict)
        return expect(find({}, sort)).rejects.toThrow(
          'Cannot sort by the @cypher field "ItNfUser.topPost": it returns a node',
        );
      // DESC puts nulls first; the hidden `a` sorts with the empty b / d.
      expect(await find({}, sort)).toEqual(['a', 'b', 'd', 'c']);
    });

    it('InterfaceModel find / count / sort', async () => {
      const people = bound().interfaceModel('ItNfPerson');
      const where = { id_IN: abcd(), topPost_NOT: null };
      expect(
        short(await people.find({ where, selectionSet: '{ id }' })),
      ).toEqual(['c']);
      expect(await people.count({ where })).toBe(1);
      const sorted = people.find({
        where: { id_IN: abcd() },
        selectionSet: '{ id }',
        options: { sort: [{ topPost: 'DESC' }, { id: 'ASC' }] },
      });
      // vNEXT — strict item 47 (root sort).
      if (strict)
        return expect(sorted).rejects.toThrow(
          'Cannot sort by the @cypher field "ItNfPerson.topPost": it returns a node',
        );
      expect(short(await sorted)).toEqual(['a', 'b', 'd', 'c']);
    });

    it('bypassPolicies still reads the raw value', async () => {
      const rows = await users().find({
        where: { id_IN: abcd(), topPost_NOT: null },
        selectionSet: '{ id }',
        unsafe: { bypassPolicies: true },
      });
      expect(short(rows).sort()).toEqual(['a', 'c']);
    });
  });

  // vNEXT — strict item 47 (root sort): without policies, default mode
  // sorts by the node itself (Neo4j's internal node order) and warns once;
  // strict mode throws before anything runs.
  it.each([
    ['default', undefined],
    ['strict', true],
  ])(
    'an OGM without policies: a root sort by a node-typed @cypher field (%s)',
    async (_label, strict) => {
      const warn = jest.fn();
      const plain = new OGM({
        typeDefs,
        driver,
        strict,
        logger: { warn, debug: () => undefined },
      });
      const call = () =>
        plain.model('ItNfUser').find({
          where: { id_IN: abcd() },
          selectionSet: '{ id }',
          options: { sort: [{ topPost: 'ASC' }, { id: 'ASC' }] },
        });
      if (strict) {
        await expect(call()).rejects.toThrow(
          'Cannot sort by the @cypher field "ItNfUser.topPost"',
        );
        return;
      }
      const first = short(await call());
      await call();
      // ASC puts nulls last: b and d have no post; a and c in node order.
      expect(first.slice(2)).toEqual(['b', 'd']);
      expect(first.slice(0, 2).sort()).toEqual(['a', 'c']);
      const warned = warn.mock.calls.filter((c) =>
        String(c[0]).includes(
          'A sort by the @cypher field "ItNfUser.topPost" has no meaning',
        ),
      );
      expect(warned).toHaveLength(1);
    },
  );

  it('an OGM without policies filters on the raw value', async () => {
    const plain = new OGM({
      typeDefs,
      driver,
      logger: { warn: () => undefined, debug: () => undefined },
    });
    const rows = await plain.model('ItNfUser').find({
      where: { id_IN: abcd(), topPost_NOT: null },
      selectionSet: '{ id }',
    });
    expect(short(rows).sort()).toEqual(['a', 'c']);
  });
});

describeApoc('NLS — node-typed @cypher nested sort key (live, APOC)', () => {
  const runId = `it-${randomUUID()}`;
  let driver: Driver;

  beforeAll(async () => {
    driver = connect(APOC_URI!, process.env.NEO4J_APOC_PASSWORD);
    await seed(driver, runId);
  });
  afterAll(() => cleanup(driver, runId));

  const query = {
    where: { id: `${runId}-y` },
    selectionSet:
      '{ id friends(options: { sort: [{ topPost: DESC }] }) { id } }',
  };

  it('default mode: a nested sort reads no node (a hidden one included)', async () => {
    // Pre-2.22.1 the sort key was y's friend a's hidden post: sortMulti
    // cannot compare nodes, so the query failed only when a hidden (or
    // visible) node existed; 2.22.1 read a hidden node as null. v2.25.0
    // (strict item 47): the node-typed key always sorts as null.
    const rows = (await makeOgm(driver, undefined)
      .withContext({ userId: 'u1' })
      .model('ItNfUser')
      .find(query)) as Row[];
    expect(
      (rows[0].friends as Row[]).map((f) => f.id as string).sort(),
    ).toEqual([`${runId}-a`, `${runId}-b`]);
  });

  it('strict mode: a nested sort by a node-typed @cypher field throws', async () => {
    await expect(
      makeOgm(driver, true)
        .withContext({ userId: 'u1' })
        .model('ItNfUser')
        .find(query),
    ).rejects.toThrow('Cannot sort a relationship by the @cypher field');
  });
});
