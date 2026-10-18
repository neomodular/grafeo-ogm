/**
 * Live list-field where suite (v2.4.8).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Every node it
 * creates carries this run's `runId` and is removed in `afterAll`.
 *
 * - Equality / `_NOT` / `_IN` on a TEMPORAL list field bound plain strings
 *   against stored native datetimes, so they never matched.
 * - `mode: 'insensitive'` on a STRING list field emitted `toLower(list)`,
 *   a Cypher type error.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItListItem @node {
    id: ID! @unique
    runId: String
    seenAt: [DateTime!]
    tags: [String!]
  }
`;

const T1 = '2024-01-01T10:00:00Z';
const T2 = '2024-02-01T10:00:00Z';

describeLive('List-field where filters — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;
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
    await driver.verifyConnectivity();
    ogm = new OGM({ typeDefs, driver });
    // Written through the OGM so seenAt is stored as native datetimes.
    await ogm.model('ItListItem').create({
      input: [
        { id: id('a'), runId, seenAt: [T1, T2], tags: ['Red', 'Blue'] },
        { id: id('b'), runId, seenAt: [T2], tags: ['green'] },
      ],
    });
  });

  afterAll(async () => {
    if (driver) {
      const session = driver.session();
      try {
        await session.run('MATCH (n {runId: $runId}) DETACH DELETE n', {
          runId,
        });
      } finally {
        await session.close();
      }
      await driver.close();
    }
  });

  const find = (where: Record<string, unknown>) =>
    ogm
      .model('ItListItem')
      .find({ where: { runId, ...where } as never, selectionSet: '{ id }' })
      .then((rows) => (rows as { id: string }[]).map((r) => r.id).sort());

  it('equality on a DateTime list matches the stored datetimes', async () => {
    expect(await find({ seenAt: [T1, T2] })).toEqual([id('a')]);
  });

  it('_NOT on a DateTime list', async () => {
    expect(await find({ seenAt_NOT: [T1, T2] })).toEqual([id('b')]);
  });

  it('_IN on a DateTime list (a list of lists)', async () => {
    expect(await find({ seenAt_IN: [[T2], [T1]] })).toEqual([id('b')]);
  });

  it('case-insensitive equality on a String list lowers element-wise', async () => {
    expect(await find({ tags: ['red', 'BLUE'], mode: 'insensitive' })).toEqual([
      id('a'),
    ]);
  });

  it('case-insensitive _IN on a String list runs (case-sensitively)', async () => {
    expect(
      await find({ tags_IN: [['green'], ['nope']], mode: 'insensitive' }),
    ).toEqual([id('b')]);
  });
});
