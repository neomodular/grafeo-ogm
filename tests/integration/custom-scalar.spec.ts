/**
 * Live custom scalars (v2.12.6).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed in `afterAll`.
 *
 * The generated types now type a custom scalar as `any` and offer
 * equality, `_NOT`, `_IN` and `_NOT_IN` on it. This pins that the runtime
 * writes the values as given and filters with exactly those operators.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  scalar Email
  scalar Payload

  type ItCsItem @node {
    id: ID! @id
    runId: String
    email: Email!
    payload: Payload
    tags: [Payload!]
  }
`;

describeLive('custom scalars — live Neo4j', () => {
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
      await session.run('MATCH (n:ItCsItem {runId: $runId}) DETACH DELETE n', {
        runId,
      });
    } finally {
      await session.close();
      await driver.close();
    }
  });

  it('writes, updates and filters with the generated operators', async () => {
    const Item = ogm.model('ItCsItem');
    await Item.create({
      input: [
        { runId, email: 'a@x.io', payload: 'p1', tags: ['t', 'u'] },
        { runId, email: 'b@x.io', payload: 2, tags: ['v'] },
      ],
    });
    await Item.update({
      where: { runId, email: 'b@x.io' },
      update: { payload: 3 },
    });

    const emails = async (where: Record<string, unknown>) =>
      (
        await Item.find({
          where: { runId, ...where },
          selectionSet: '{ email }',
          options: { sort: [{ email: 'ASC' }] },
        })
      ).map((r) => r.email);

    expect(await emails({ email: 'a@x.io' })).toEqual(['a@x.io']);
    expect(await emails({ email_NOT: 'a@x.io' })).toEqual(['b@x.io']);
    expect(await emails({ payload_IN: ['p1', 3] })).toEqual([
      'a@x.io',
      'b@x.io',
    ]);
    expect(await emails({ payload_NOT_IN: [3] })).toEqual(['a@x.io']);
    expect(await emails({ tags: ['v'] })).toEqual(['b@x.io']);

    const [row] = await Item.find({
      where: { runId, email: 'b@x.io' },
      selectionSet: '{ payload tags }',
    });
    expect(row).toEqual({ payload: 3, tags: ['v'] });
  });
});
