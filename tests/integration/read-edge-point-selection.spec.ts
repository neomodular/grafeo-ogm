/**
 * Live suite (2.21.0): point sub-selection on relationship properties
 * (`edges { properties { at { longitude latitude } } }`) and in the typed
 * `select` (`at: { select: { longitude: true } }`, node and edge).
 *
 * On a962f44 (v2.20.1) the edge forms were left out of the result (strict:
 * `OGMError`), and so was the typed-select form on node properties. Both
 * modes now return the point map, as v2.20.0 does for a node property's
 * selectionSet.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItEpPlace @node {
    id: ID! @unique
    runId: String
    loc: Point
    visits: [ItEpPlace!]!
      @relationship(
        type: "IT_EP_VISIT"
        direction: OUT
        properties: "ItEpVisit"
      )
  }
  type ItEpVisit @relationshipProperties {
    at: Point
    cat: CartesianPoint
    pts: [Point!]
    note: String
  }
`;

type Edge = { node: { id: string }; properties: Record<string, unknown> };

describeLive('point sub-selection on edge properties (2.21.0) — live', () => {
  const runId = `it-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;
  let driver: Driver;
  const ogms: [string, OGM][] = [];

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
    );
    ogms.push(['default', new OGM({ typeDefs, driver })]);
    ogms.push(['strict', new OGM({ typeDefs, driver, strict: true })]);
    const session = driver.session();
    try {
      await session.run(
        `CREATE (a:ItEpPlace {id: $a, runId: $runId, loc: point({longitude: 1.5, latitude: 2.5})})
         CREATE (a)-[:IT_EP_VISIT {note: 'x', at: point({longitude: 10, latitude: 20, height: 5}),
                  cat: point({x: 1, y: 2}), pts: [point({longitude: 3, latitude: 4})]}]->
                (:ItEpPlace {id: $b, runId: $runId})
         CREATE (a)-[:IT_EP_VISIT {note: 'y'}]->(:ItEpPlace {id: $c, runId: $runId})`,
        { runId, a: id('a'), b: id('b'), c: id('c') },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      await session.run('MATCH (n:ItEpPlace {runId: $runId}) DETACH DELETE n', {
        runId,
      });
    } finally {
      await session.close();
    }
    await driver.close();
  });

  const byNode = (edges: Edge[]) =>
    Object.fromEntries(
      edges.map((e) => [e.node.id.slice(runId.length + 1), e.properties]),
    );

  it('selectionSet: Point, CartesianPoint, list, alias, missing values', async () => {
    for (const [, ogm] of ogms) {
      const [row] = (await ogm.model('ItEpPlace').find({
        where: { id: id('a') },
        selectionSet: `{ visitsConnection { edges { node { id } properties {
          note at { longitude latitude height crs srid __typename }
          cat { x y z } pts { lat: latitude } h: at { height } } } } }`,
      })) as { visitsConnection: { edges: Edge[] } }[];
      expect(byNode(row.visitsConnection.edges)).toEqual({
        b: {
          note: 'x',
          at: {
            longitude: 10,
            latitude: 20,
            height: 5,
            crs: 'wgs-84-3d',
            srid: 4979,
            __typename: 'Point',
          },
          cat: { x: 1, y: 2, z: null },
          pts: [{ lat: 4 }],
          h: { height: 5 },
        },
        c: { note: 'y', at: null, cat: null, pts: null, h: null },
      });
    }
  });

  it('typed select: edge and node point fields', async () => {
    for (const [, ogm] of ogms) {
      const [row] = (await ogm.model('ItEpPlace').find({
        where: { id: id('a') },
        select: {
          loc: { select: { longitude: true, latitude: true } },
          visitsConnection: {
            select: {
              edges: {
                node: { select: { id: true } },
                properties: {
                  select: {
                    note: true,
                    at: { select: { latitude: true, srid: true } },
                  },
                },
              },
            },
          },
        },
      } as never)) as {
        loc: unknown;
        visitsConnection: { edges: Edge[] };
      }[];
      expect(row.loc).toEqual({ longitude: 1.5, latitude: 2.5 });
      expect(byNode(row.visitsConnection.edges)).toEqual({
        b: { note: 'x', at: { latitude: 20, srid: 4979 } },
        c: { note: 'y', at: null },
      });
    }
  });
});
