/**
 * Live Neo4jRecordFactory suite (v2.5.0).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Read-only: it
 * only evaluates `datetime()` literals.
 *
 * `Neo4jRecordFactory.dateTime` is meant to stand in for a value the
 * driver returns, so it must match `datetime(iso)` field for field. Before
 * v2.5.0 it dropped the offset and cut the fraction to milliseconds.
 */
import neo4j, { Driver } from 'neo4j-driver';
import { Neo4jRecordFactory } from '../../src/testing/neo4j-record-factory';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const FIELDS = [
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'nanosecond',
  'timeZoneOffsetSeconds',
  'timeZoneId',
] as const;

describeLive('Neo4jRecordFactory.dateTime — live Neo4j', () => {
  let driver: Driver;

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
  });

  afterAll(async () => {
    await driver.close();
  });

  it.each([
    '2024-01-01T10:00:00+02:00',
    '2024-01-01T10:00:00.123456789Z',
    '2024-01-01T10:00:00Z',
    '2024-06-15T10:30:00.000Z',
    '2024-01-01T10:00:00.5-05:30',
    '2024-07-01T10:00:00+0530',
    '2024-07-01T10:00:00+05',
    '2024-07-01T10:00:00+02:00[Europe/Berlin]',
    '2024-07-01T10:00:00[Europe/Berlin]',
    '2024-01-15T10:00:00[Europe/Berlin]',
  ])('matches the driver for %s', async (iso) => {
    const session = driver.session();
    let fromDriver: Record<string, unknown>;
    try {
      const res = await session.run('RETURN datetime($iso) AS v', { iso });
      fromDriver = res.records[0].get('v');
    } finally {
      await session.close();
    }
    const fromFactory = Neo4jRecordFactory.dateTime(iso) as Record<
      string,
      unknown
    >;

    expect(String(fromFactory)).toBe(String(fromDriver));
    for (const f of FIELDS)
      expect([f, fromFactory[f]]).toEqual([f, fromDriver[f]]);
  });
});
