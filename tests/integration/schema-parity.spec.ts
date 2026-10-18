/**
 * Live schema-parser parity suite.
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed after each test.
 *
 * Through v2.4.7 list `@default` values were dropped by the parser, so
 * creates stored nothing for them.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver, Integer } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  enum LdColor {
    RED
    GREEN
  }
  type LdSwatch @node {
    id: ID! @id
    runId: String
    colors: [LdColor!] @default(value: [RED, GREEN])
    sizes: [Int!] @default(value: [1, 2])
    seenAt: [DateTime!] @default(value: ["2024-01-01T00:00:00Z"])
  }

  interface LdProduction {
    runId: String
    title: String!
    actors: [LdActor!]! @declareRelationship
  }
  type LdMovie implements LdProduction
    @node(labels: ["LdMovie", "LdProduction"]) {
    runId: String
    title: String!
    actors: [LdActor!]!
      @relationship(type: "LD_ACTED_IN", direction: IN, properties: "LdActedIn")
  }
  type LdShow implements LdProduction
    @node(labels: ["LdShow", "LdProduction"]) {
    runId: String
    title: String!
    actors: [LdActor!]!
      @relationship(type: "LD_ACTED_IN", direction: IN, properties: "LdActedIn")
  }
  type LdActor @node {
    runId: String
    name: String!
  }
  type LdActedIn @relationshipProperties {
    role: String
  }
`;

describeLive('schema parity — live Neo4j', () => {
  const runId = `ld-${randomUUID()}`;
  let driver: Driver;
  let ogm: OGM;

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
    );
    await driver.verifyConnectivity();
    ogm = new OGM({ typeDefs, driver });
  });

  afterEach(async () => {
    const session = driver.session();
    try {
      await session.run('MATCH (n {runId: $runId}) DETACH DELETE n', {
        runId,
      });
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (driver) await driver.close();
  });

  it('stores list @default values with their native element types', async () => {
    await ogm.model('LdSwatch').create({ input: [{ runId }] });
    const session = driver.session();
    try {
      const res = await session.run(
        `MATCH (s:LdSwatch {runId: $runId})
         RETURN s.colors AS colors, s.sizes AS sizes,
                [x IN s.sizes | valueType(x)] AS sizeTypes,
                [x IN s.seenAt | valueType(x)] AS seenTypes`,
        { runId },
      );
      const row = res.records[0].toObject();
      expect(row.colors).toEqual(['RED', 'GREEN']);
      expect(row.sizes.map((n: Integer) => n.toNumber())).toEqual([1, 2]);
      expect(row.sizeTypes).toEqual(['INTEGER NOT NULL', 'INTEGER NOT NULL']);
      expect(row.seenTypes).toEqual(['ZONED DATETIME NOT NULL']);
    } finally {
      await session.close();
    }
  });

  // Through v2.4.7 @declareRelationship parsed with type '' and every one
  // of these threw `Invalid identifier ""`.
  it('filters, selects and traverses @declareRelationship fields on an InterfaceModel', async () => {
    const session = driver.session();
    try {
      await session.run(
        `CREATE (a:LdActor {runId: $runId, name: 'Ana'}),
                (b:LdActor {runId: $runId, name: 'Bo'}),
                (m:LdMovie:LdProduction {runId: $runId, title: 'M'}),
                (s:LdShow:LdProduction {runId: $runId, title: 'S'}),
                (x:LdShow:LdProduction {runId: $runId, title: 'X'}),
                (a)-[:LD_ACTED_IN {role: 'lead'}]->(m),
                (b)-[:LD_ACTED_IN {role: 'host'}]->(s)`,
        { runId },
      );
    } finally {
      await session.close();
    }

    const Production = ogm.interfaceModel('LdProduction');
    const withAna = await Production.find({
      where: { runId, actors_SOME: { name: 'Ana' } },
      selectionSet: '{ title actors { name } }',
    });
    expect(withAna).toEqual([
      { __typename: 'LdMovie', title: 'M', actors: [{ name: 'Ana' }] },
    ]);

    const hosts = await Production.find({
      where: { runId, actorsConnection_SOME: { edge: { role: 'host' } } },
      selectionSet:
        '{ title actorsConnection { edges { properties { role } node { name } } } }',
    });
    expect(hosts).toEqual([
      {
        __typename: 'LdShow',
        title: 'S',
        actorsConnection: {
          edges: [{ properties: { role: 'host' }, node: { name: 'Bo' } }],
        },
      },
    ]);

    expect(await Production.count({ where: { runId, actors_NONE: {} } })).toBe(
      1,
    );
  });
});
