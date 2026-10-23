/**
 * Live `extend type` (v2.13.0).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed in `afterAll`.
 *
 * Through v2.12.3 the parser dropped `extend type` blocks: `create` with an
 * extended field threw "Unknown field", and extended relationships,
 * `@cypher` fields and interface fields were missing from reads.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  interface ItTeTitled {
    title: String!
  }

  type ItTeMovie @node {
    id: ID! @id
    title: String!
    runId: String
  }

  type ItTePerson @node {
    id: ID! @id
    name: String!
    runId: String
  }

  type ItTeActedIn @relationshipProperties {
    role: String
  }

  extend interface ItTeTitled {
    year: Int
  }

  extend type ItTeMovie implements ItTeTitled {
    year: Int
    tagline: String @default(value: "tbd")
    actors: [ItTePerson!]!
      @relationship(
        type: "IT_TE_ACTED_IN"
        direction: IN
        properties: "ItTeActedIn"
      )
    actorCount: Int
      @cypher(
        statement: "MATCH (this)<-[:IT_TE_ACTED_IN]-(p) RETURN count(p) AS c"
        columnName: "c"
      )
  }

  extend type ItTeActedIn {
    minutes: Int
  }
`;

describeLive('extend type — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let driver: Driver;
  let ogm: OGM;

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    ogm = new OGM({ typeDefs, driver });
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      await session.run(
        'MATCH (n) WHERE (n:ItTeMovie OR n:ItTePerson) AND n.runId = $runId DETACH DELETE n',
        { runId },
      );
    } finally {
      await session.close();
      await driver.close();
    }
  });

  it('create and find with extended fields, relationships and @cypher', async () => {
    const Movie = ogm.model('ItTeMovie');
    await Movie.create({
      input: [
        {
          title: `M-${runId}`,
          runId,
          year: 1999,
          actors: {
            create: [
              {
                node: { name: 'Keanu', runId },
                edge: { role: 'Neo', minutes: 120 },
              },
            ],
          },
        },
      ],
    });

    const found = await Movie.find({
      where: { runId, year: 1999, actors_SOME: { name: 'Keanu' } },
      selectionSet: `{
        title year tagline actorCount
        actorsConnection { edges { properties { role minutes } node { name } } }
      }`,
    });
    expect(found).toEqual([
      {
        title: `M-${runId}`,
        year: 1999,
        tagline: 'tbd',
        actorCount: 1,
        actorsConnection: {
          edges: [
            {
              properties: { role: 'Neo', minutes: 120 },
              node: { name: 'Keanu' },
            },
          ],
        },
      },
    ]);

    const titled = await ogm.interfaceModel('ItTeTitled').find({
      where: { year: 1999, title: `M-${runId}` },
      selectionSet: '{ title year }',
    });
    expect(titled).toEqual([
      { __typename: 'ItTeMovie', title: `M-${runId}`, year: 1999 },
    ]);
  });
});
