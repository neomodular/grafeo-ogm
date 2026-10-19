/**
 * Live InterfaceModel suite for an interface with no implementers (v2.5.3).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * `find` built the `__typename` CASE from the implementers, so with none
 * it emitted `CASE  END`, a syntax error, while `count` worked.
 */
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';
import { OGM } from '../../src/ogm';

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  interface ItNoImpl {
    id: ID!
    runId: String
  }
  type ItNoImplOther @node {
    id: ID! @unique
  }
`;

describeLive('InterfaceModel with no implementers — live Neo4j', () => {
  const h = liveHarness();
  let ogm: OGM;

  beforeAll(async () => {
    await h.setup();
    ogm = new OGM({ typeDefs, driver: h.driver });
  });

  afterAll(() => h.teardown());

  it('find returns [] instead of a syntax error', async () => {
    const T = ogm.interfaceModel('ItNoImpl');
    await expect(
      T.find({ where: { runId: h.runId }, selectionSet: '{ id }' }),
    ).resolves.toEqual([]);
    await expect(T.count({ where: { runId: h.runId } })).resolves.toBe(0);
  });
});
