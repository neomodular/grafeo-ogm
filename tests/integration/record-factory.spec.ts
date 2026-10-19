/**
 * Live Neo4jRecordFactory suite (v2.4.8).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Read-only: it
 * only evaluates `datetime()` literals.
 *
 * `Neo4jRecordFactory.dateTime` is meant to stand in for a value the
 * driver returns, so it must match `datetime(iso)` field for field. Before
 * v2.4.8 it dropped the offset and cut the fraction to milliseconds.
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
    // No offset: Neo4j reads these as UTC (its default zone).
    '2024-07-01T10:00:00',
    '2024-07-01T10:00',
    '2024-07-01T10:00:00.987654321',
    '2024-07-01',
    // v2.5.3 — `-00:00` is offset 0, not -0.
    '2024-01-01T10:00:00-00:00',
    // v2.5.3 — a wall time in a DST gap moves later by the gap.
    '2024-03-10T02:30:00[America/New_York]',
    '2024-03-31T02:30:00[Europe/Berlin]',
    '2024-03-10T02:30:00.25[America/New_York]',
    '2011-12-30T10:00:00[Pacific/Apia]',
    // v2.5.3 — a DST overlap takes the earlier (larger) offset.
    '2024-11-03T01:30:00[America/New_York]',
    '2024-10-27T02:30:00[Europe/Berlin]',
    '2024-04-07T02:30:00[Australia/Sydney]',
    // v2.5.3 — years 0–99 and BC years with a zone id (local mean time).
    '0050-01-01T00:00:00[Europe/London]',
    '0001-01-01T00:00:00[Europe/Berlin]',
    '-0001-06-01T00:00:00[Europe/Berlin]',
    '0999-05-05T05:05:05[Asia/Tokyo]',
    // v2.5.3 — the basic (separator-less) format.
    '20240101T100000Z',
    '20240101T1000Z',
    '20240101',
    '20240101T100000.5+0200',
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
