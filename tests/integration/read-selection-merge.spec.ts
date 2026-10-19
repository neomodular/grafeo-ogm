/**
 * Live selectionSet merge / alias / fragment suite (v2.5.3).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * - The same alias on DIFFERENT fields in sibling inline fragments
 *   (`... on A { x: title } ... on B { x: body }`, valid GraphQL) returned
 *   the first fragment's field for every type.
 * - Aliases inside a connection (`t: totalCount`, `e: edges`, `nd: node`,
 *   `pr: properties`, aliased edge properties) were ignored.
 * - A response key selected twice (`posts { id } posts { title }`, or two
 *   `edges { node { … } }`) kept only one selection's sub-fields.
 */
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  interface ItSmThing {
    id: ID!
    runId: String
  }
  type ItSmA implements ItSmThing @node {
    id: ID! @unique
    runId: String
    title: String
  }
  type ItSmB implements ItSmThing @node {
    id: ID! @unique
    runId: String
    title: String
    body: String
    owners: [ItSmUser!]! @relationship(type: "IT_SM_OWNS", direction: IN)
  }
  type ItSmWrote @relationshipProperties {
    stars: Int
  }
  type ItSmPost @node {
    id: ID! @unique
    runId: String
    title: String
  }
  type ItSmUser @node {
    id: ID! @unique
    runId: String
    name: String
    things: [ItSmThing!]! @relationship(type: "IT_SM_HAS", direction: OUT)
    posts: [ItSmPost!]!
      @relationship(
        type: "IT_SM_WROTE"
        direction: OUT
        properties: "ItSmWrote"
      )
  }
`;

type Row = Record<string, unknown>;

describeLive('selectionSet merge, aliases and fragments — live Neo4j', () => {
  const h = liveHarness();
  let ogm: OGM;
  let secured: OGM;

  beforeAll(async () => {
    await h.setup();
    ogm = new OGM({ typeDefs, driver: h.driver });
    secured = new OGM({
      typeDefs,
      driver: h.driver,
      policies: {
        ItSmUser: [
          permissive({
            operations: ['read'],
            name: 'user.only-u1',
            when: () => ({ name: 'u1' }),
          }),
        ],
      },
    });
    await h.run(
      `CREATE (u1:ItSmUser {id: $runId + '-u1', runId: $runId, name: 'u1'})
       CREATE (u2:ItSmUser {id: $runId + '-u2', runId: $runId, name: 'u2'})
       CREATE (a:ItSmA {id: $runId + '-a', runId: $runId, title: 'tA'})
       CREATE (b:ItSmB {id: $runId + '-b', runId: $runId, title: 'tB', body: 'bodyB'})
       CREATE (p1:ItSmPost {id: $runId + '-p1', runId: $runId, title: 'P1'})
       CREATE (p2:ItSmPost {id: $runId + '-p2', runId: $runId, title: 'P2'})
       CREATE (u1)-[:IT_SM_HAS]->(a), (u1)-[:IT_SM_HAS]->(b)
       CREATE (u1)-[:IT_SM_OWNS]->(b), (u2)-[:IT_SM_OWNS]->(b)
       CREATE (u1)-[:IT_SM_WROTE {stars: 5}]->(p1), (u1)-[:IT_SM_WROTE {stars: 3}]->(p2)`,
    );
  });

  afterAll(() => h.teardown());

  const things = (selectionSet: string, o: OGM = ogm) =>
    o.interfaceModel('ItSmThing').find({
      where: { runId: h.runId },
      selectionSet,
      options: { sort: [{ id: 'ASC' }] },
    }) as Promise<Row[]>;
  const u1 = async (selectionSet: string): Promise<Row> =>
    (
      (await ogm.model('ItSmUser').find({
        where: { id: h.id('u1') },
        selectionSet,
      })) as Row[]
    )[0];
  const byId = (rows: unknown) =>
    [...(rows as Row[])].sort((x, y) =>
      String(x.id ?? '').localeCompare(String(y.id ?? '')),
    );

  describe('same alias on different fields in sibling fragments', () => {
    it('resolves each type its own field (InterfaceModel)', async () => {
      expect(
        await things(
          '{ id ... on ItSmA { x: title } ... on ItSmB { x: body } }',
        ),
      ).toEqual([
        { id: h.id('a'), x: 'tA', __typename: 'ItSmA' },
        { id: h.id('b'), x: 'bodyB', __typename: 'ItSmB' },
      ]);
    });

    it('resolves each type its own field (nested interface relationship)', async () => {
      const row = await u1(
        '{ things { id ... on ItSmA { x: title } ... on ItSmB { x: body } } }',
      );
      expect(byId(row.things)).toEqual([
        { id: h.id('a'), x: 'tA', __typename: 'ItSmA' },
        { id: h.id('b'), x: 'bodyB', __typename: 'ItSmB' },
      ]);
    });
  });

  describe('aliases inside a connection', () => {
    it('honours totalCount, edges, node, properties and edge field aliases', async () => {
      const row = await u1(
        '{ c: postsConnection { t: totalCount e: edges { nd: node { id } pr: properties { s: stars } } } }',
      );
      const c = row.c as Row;
      expect(c.t).toBe(2);
      expect(
        [...(c.e as Row[])].sort((x, y) =>
          String((x.nd as Row).id).localeCompare(String((y.nd as Row).id)),
        ),
      ).toEqual([
        { nd: { id: h.id('p1') }, pr: { s: 5 } },
        { nd: { id: h.id('p2') }, pr: { s: 3 } },
      ]);
    });

    it('leaves an unaliased connection unchanged', async () => {
      const row = await u1(
        '{ postsConnection { totalCount edges { node { id } properties { stars } } } }',
      );
      expect((row.postsConnection as Row).totalCount).toBe(2);
      expect(((row.postsConnection as Row).edges as Row[]).length).toBe(2);
    });
  });

  describe('a response key selected twice', () => {
    const P1 = { id: '', title: 'P1' };
    const expected = () => [
      { ...P1, id: h.id('p1') },
      { id: h.id('p2'), title: 'P2' },
    ];

    it('merges the sub-selections of a relationship', async () => {
      expect(
        byId((await u1('{ posts { id } posts { title } }')).posts),
      ).toEqual(expected());
    });

    it('merges the sub-selections of an aliased relationship', async () => {
      expect(
        byId((await u1('{ x: posts { id } x: posts { title } }')).x),
      ).toEqual(expected());
    });

    it('merges repeated edges { node } in a connection', async () => {
      const row = await u1(
        '{ postsConnection { edges { node { id } } edges { node { title } } } }',
      );
      const nodes = ((row.postsConnection as Row).edges as Row[]).map(
        (e) => e.node,
      );
      expect(byId(nodes)).toEqual(expected());
    });

    it('merges a field selected outside and inside a fragment', async () => {
      const rows = await ogm.model('ItSmUser').find({
        where: { id: h.id('u1') },
        selectionSet: '{ posts { id } ... on ItSmUser { posts { title } } }',
      });
      expect(byId((rows as Row[])[0].posts)).toEqual(expected());
    });
  });
});
