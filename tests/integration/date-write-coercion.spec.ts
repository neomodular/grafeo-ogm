/**
 * Live suite (v2.18.0): a JS `Date` written to a `DateTime` field.
 *
 * Pre-v2.18.0 every write path bound the Date raw; the driver packs it as an
 * empty map and Neo4j rejected the write ("Property values can only be of
 * primitive types or arrays thereof. Encountered: Map{}."), while a `where`
 * filter accepted the same Date. Each write path must now store a native
 * DATETIME that a Date filter matches. The other temporal types reject a
 * Date with an OGMError instead of a server error.
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItDwEvent @node {
    id: ID! @id
    runId: String
    name: String @unique
    at: DateTime
    ats: [DateTime!]
    day: Date
    local: LocalDateTime
    t: Time
    links: [ItDwEvent!]!
      @relationship(type: "IT_DW_LINK", direction: OUT, properties: "ItDwLink")
  }
  type ItDwLink @relationshipProperties {
    since: DateTime
  }
`;

type Row = Record<string, unknown>;

describeLive('JS Date for DateTime writes (v2.18.0) — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const d = new Date('2024-05-01T10:00:00.000Z');
  let driver: Driver;
  let ogm: OGM;

  async function run(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Row[]> {
    const session = driver.session();
    try {
      const res = await session.run(cypher, { runId, ...params });
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  const stored = async (name: string) =>
    (
      await run(
        `MATCH (n:ItDwEvent {runId: $runId, name: $name})
         RETURN valueType(n.at) AS t, toString(n.at) AS v,
                [x IN coalesce(n.ats, []) | toString(x)] AS vs`,
        { name },
      )
    )[0];

  const sinceOf = async (from: string) =>
    (
      await run(
        `MATCH (:ItDwEvent {runId: $runId, name: $from})-[r:IT_DW_LINK]->(k)
         RETURN k.name AS k, valueType(r.since) AS t, toString(r.since) AS v ORDER BY k`,
        { from },
      )
    ).map((r) => ({ k: r.k, t: r.t, v: r.v }));

  const model = () => ogm.model('ItDwEvent');
  const ISO = '2024-05-01T10:00:00Z';
  const NATIVE = 'ZONED DATETIME NOT NULL';

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
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n:ItDwEvent {runId: $runId}) DETACH DELETE n');
      await driver.close();
    }
  });

  it('create stores a native DATETIME that a Date filter finds', async () => {
    await model().create({ input: [{ runId, name: 'c', at: d, ats: [d] }] });
    expect(await stored('c')).toEqual({ t: NATIVE, v: ISO, vs: [ISO] });
    const found = await model().find({
      where: { runId, at: d },
      selectionSet: '{ name }',
    });
    expect(found.map((r: Row) => r.name)).toEqual(['c']);
  });

  it('createMany', async () => {
    await model().createMany({
      data: [
        { runId, name: 'cm1', at: d },
        { runId, name: 'cm2', at: '2024-05-01T10:00:00Z' },
      ],
    });
    expect((await stored('cm1')).v).toBe(ISO);
    expect((await stored('cm2')).v).toBe(ISO);
  });

  it('upsert (create branch and update branch)', async () => {
    await model().upsert({
      where: { name: 'u' },
      create: { runId, name: 'u', at: d },
      update: {},
    });
    expect((await stored('u')).t).toBe(NATIVE);
    await model().upsert({
      where: { name: 'u' },
      create: { runId, name: 'u' },
      update: { ats: [d] },
    });
    expect((await stored('u')).vs).toEqual([ISO]);
  });

  it('update and updateMany', async () => {
    await model().create({ input: [{ runId, name: 'up' }] });
    await model().update({ where: { name: 'up' }, update: { at: d } });
    expect((await stored('up')).v).toBe(ISO);
    await model().updateMany({
      where: { name: 'up' },
      data: { ats: [d, d] },
    });
    expect((await stored('up')).vs).toEqual([ISO, ISO]);
  });

  it('nested create and edge properties (create, connect, array connect, nested update)', async () => {
    await model().create({ input: [{ runId, name: 'k1' }] });
    await model().create({ input: [{ runId, name: 'k2' }] });
    await model().create({
      input: [
        {
          runId,
          name: 'hub',
          links: {
            create: [
              { node: { runId, name: 'n1', at: d }, edge: { since: d } },
            ],
            connect: [{ where: { node: { name: 'k1' } }, edge: { since: d } }],
          },
        },
      ],
    });
    expect((await stored('n1')).v).toBe(ISO);
    // Array connect (UNWIND fast path) with a Date edge value.
    await model().update({
      where: { name: 'hub' },
      connect: {
        links: [{ where: { node: { name: 'k2' } }, edge: { since: d } }],
      },
    });
    // Nested update of the edge and of the related node.
    await model().update({
      where: { name: 'hub' },
      update: {
        links: [
          {
            where: { node: { name: 'n1' } },
            update: { node: { ats: [d] }, edge: { since: d } },
          },
        ],
      },
    });
    expect(await sinceOf('hub')).toEqual([
      { k: 'k1', t: NATIVE, v: ISO },
      { k: 'k2', t: NATIVE, v: ISO },
      { k: 'n1', t: NATIVE, v: ISO },
    ]);
    expect((await stored('n1')).vs).toEqual([ISO]);
  });

  it.each([
    ['day', 'Date'],
    ['local', 'LocalDateTime'],
    ['t', 'Time'],
  ])(
    'a JS Date for %s (%s) throws an OGMError, not a server error',
    async (field) => {
      await expect(
        model().create({ input: [{ runId, name: `x-${field}`, [field]: d }] }),
      ).rejects.toThrow(OGMError);
    },
  );
});
