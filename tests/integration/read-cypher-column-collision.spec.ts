/**
 * Live `@cypher` columnName collision suite (v2.5.3).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * The SELECT / WHERE / sort preludes returned the statement's column
 * under its own name (`RETURN head(collect(col)) AS col`) and renamed it
 * in a following `WITH`. A `columnName` equal to a variable already in
 * scope — the node variable `n`, `score`, `__typename` — failed the whole
 * query with "Variable `n` already declared".
 */
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';
import { OGM } from '../../src/ogm';

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  interface ItCcThing {
    id: ID!
    runId: String
  }
  type ItCcItem implements ItCcThing @node {
    id: ID! @unique
    runId: String
    rank: Int
    nn: Int @cypher(statement: "RETURN this.rank * 10 AS n", columnName: "n")
    tn: String
      @cypher(
        statement: "RETURN 'x' + this.id AS __typename"
        columnName: "__typename"
      )
  }
`;

describeLive(
  '@cypher columnName colliding with an outer variable — live Neo4j',
  () => {
    const h = liveHarness();
    let ogm: OGM;

    beforeAll(async () => {
      await h.setup();
      ogm = new OGM({ typeDefs, driver: h.driver });
      await ogm.model('ItCcItem').create({
        input: [
          { id: h.id('a'), runId: h.runId, rank: 2 },
          { id: h.id('b'), runId: h.runId, rank: 1 },
        ],
      });
    });

    afterAll(() => h.teardown());

    const M = () => ogm.model('ItCcItem');

    it('selects a column named like the node variable', async () => {
      const rows = await M().find({
        where: { runId: h.runId },
        selectionSet: '{ id nn }',
        options: { sort: [{ id: 'ASC' }] },
      });
      expect(rows).toEqual([
        { id: h.id('a'), nn: 20 },
        { id: h.id('b'), nn: 10 },
      ]);
    });

    it('filters on it', async () => {
      const rows = await M().find({
        where: { runId: h.runId, nn: 10 },
        selectionSet: '{ id }',
      });
      expect(rows).toEqual([{ id: h.id('b') }]);
    });

    it('sorts on it', async () => {
      const rows = await M().find({
        where: { runId: h.runId },
        selectionSet: '{ id }',
        options: { sort: [{ nn: 'ASC' }] },
      });
      expect(rows).toEqual([{ id: h.id('b') }, { id: h.id('a') }]);
    });

    it('selects a column named __typename through InterfaceModel', async () => {
      const rows = await ogm.interfaceModel('ItCcThing').find({
        where: { runId: h.runId },
        selectionSet: '{ id ... on ItCcItem { tn } }',
        options: { sort: [{ id: 'ASC' }] },
      });
      expect(rows).toEqual([
        { id: h.id('a'), tn: `x${h.id('a')}`, __typename: 'ItCcItem' },
        { id: h.id('b'), tn: `x${h.id('b')}`, __typename: 'ItCcItem' },
      ]);
    });
  },
);
