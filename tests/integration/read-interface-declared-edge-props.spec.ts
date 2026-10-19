/**
 * Live: edge properties of an interface's `@declareRelationship` (v2.6.3, #22).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * The generated `OwnerSelectFields.plansConnection` offers
 * `edges.properties: { select: OwnerPlansEdgeSelectFields }` (that type was
 * referenced but not emitted until v2.6.3). The runtime must honour what the
 * types offer: selecting the declared relationship's edge properties through
 * an interface target returns them.
 */
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';
import { OGM } from '../../src/ogm';

jest.setTimeout(60_000);

type Edges = { plansConnection: { edges: unknown[] } };

const typeDefs = /* GraphQL */ `
  interface ItDrOwner {
    id: ID!
    plans: [ItDrPlan!]! @declareRelationship
  }
  type ItDrPlan @node {
    id: ID! @unique
    runId: String
    name: String
  }
  type ItDrSub @relationshipProperties {
    note: String!
  }
  type ItDrUser implements ItDrOwner @node {
    id: ID! @unique
    runId: String
    plans: [ItDrPlan!]!
      @relationship(type: "IT_DR_SUB", properties: "ItDrSub", direction: OUT)
  }
  type ItDrOrg implements ItDrOwner @node {
    id: ID! @unique
    runId: String
    plans: [ItDrPlan!]!
      @relationship(type: "IT_DR_SUB", properties: "ItDrSub", direction: OUT)
  }
  type ItDrAccount @node {
    id: ID! @unique
    runId: String
    owner: ItDrOwner @relationship(type: "IT_DR_OWNED_BY", direction: OUT)
  }
`;

describeLive(
  'Interface @declareRelationship edge properties — live Neo4j',
  () => {
    const h = liveHarness();
    let ogm: OGM;

    beforeAll(async () => {
      await h.setup();
      ogm = new OGM({ typeDefs, driver: h.driver });
      await h.run(
        `CREATE (a:ItDrAccount {id: $a, runId: $runId})
       CREATE (u:ItDrUser {id: $u, runId: $runId})
       CREATE (p:ItDrPlan {id: $p, runId: $runId, name: 'Pro'})
       CREATE (a)-[:IT_DR_OWNED_BY]->(u)
       CREATE (u)-[:IT_DR_SUB {note: 'yearly'}]->(p)`,
        { a: h.id('a'), u: h.id('u'), p: h.id('p') },
      );
    });

    afterAll(() => h.teardown());

    it('typed select reaches the edge properties through an interface target', async () => {
      const rows = (await ogm.model('ItDrAccount').find({
        where: { id: h.id('a') },
        select: {
          owner: {
            select: {
              plansConnection: {
                select: {
                  edges: {
                    node: { select: { name: true } },
                    properties: { select: { note: true } },
                  },
                },
              },
            },
          },
        },
      })) as Array<{ owner: Edges }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].owner.plansConnection.edges).toEqual([
        { node: { name: 'Pro' }, properties: { note: 'yearly' } },
      ]);
    });

    it('the interface model projects the edge properties too', async () => {
      const rows = await ogm.interfaceModel('ItDrOwner').find({
        where: { id: h.id('u') },
        selectionSet:
          '{ id plansConnection { edges { properties { note } node { name } } } }',
      });
      expect(rows).toHaveLength(1);
      expect((rows[0] as unknown as Edges).plansConnection.edges).toEqual([
        { properties: { note: 'yearly' }, node: { name: 'Pro' } },
      ]);
    });
  },
);
