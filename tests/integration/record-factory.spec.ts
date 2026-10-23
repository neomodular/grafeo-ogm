/**
 * Live Neo4jRecordFactory suite (v2.4.8; time zones v2.9.0).
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
import {
  Neo4jRecordFactory,
  resetDateTimeWarnings,
} from '../../src/testing/neo4j-record-factory';
import { neo4jZoneIds } from '../../src/testing/zone-ids';
import { ResultMapper } from '../../src/execution/result-mapper';

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

  // ---------------------------------------------------------------------
  // v2.9.0 — time-zone offset / zone id fidelity
  // ---------------------------------------------------------------------

  beforeEach(() => resetDateTimeWarnings());

  async function fromDriver(
    iso: string,
  ): Promise<{ value?: Record<string, unknown>; error?: string }> {
    const session = driver.session();
    try {
      const res = await session.run('RETURN datetime($iso) AS v', { iso });
      return { value: res.records[0].get('v') };
    } catch (e) {
      return { error: (e as Error).message };
    } finally {
      await session.close();
    }
  }

  function fromFactory(
    iso: string,
    strict: boolean,
  ): { value?: Record<string, unknown>; error?: string; codes: string[] } {
    const spy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const codes = () =>
      spy.mock.calls.map(
        (call) => (call[1] as { code?: string } | undefined)?.code ?? '',
      );
    try {
      const value = Neo4jRecordFactory.dateTime(iso, { strict }) as Record<
        string,
        unknown
      >;
      return { value, codes: codes() };
    } catch (e) {
      return { error: (e as Error).message, codes: codes() };
    } finally {
      spy.mockRestore();
    }
  }

  async function expectSame(iso: string, strict: boolean): Promise<void> {
    const real = await fromDriver(iso);
    const mock = fromFactory(iso, strict);
    expect([iso, mock.codes]).toEqual([iso, []]);
    if (real.error !== undefined) {
      expect([iso, mock.error !== undefined]).toEqual([iso, true]);
      return;
    }
    expect([iso, mock.error]).toEqual([iso, undefined]);
    expect([iso, String(mock.value)]).toEqual([iso, String(real.value)]);
    for (const f of FIELDS)
      expect([iso, f, mock.value![f]]).toEqual([iso, f, real.value![f]]);
    expect([iso, ResultMapper.convertNeo4jTypes(mock.value)]).toEqual([
      iso,
      ResultMapper.convertNeo4jTypes(real.value),
    ]);
  }

  it.each([
    // Offsets east, west, fractional hours, extremes.
    '2026-03-29T01:30:00+05:45',
    '2026-03-29T01:30:00-03:30',
    '2026-03-29T01:30:00-09:30',
    '2026-03-29T01:30:00+18:00',
    '2026-03-29T01:30:00-18:00',
    // An offset that matches the zone (either one in a DST overlap).
    '2026-07-01T10:00:00+02:00[Europe/Madrid]',
    '2026-10-25T02:30:00+01:00[Europe/Madrid]',
    '2026-10-25T02:30:00+02:00[Europe/Madrid]',
    '2026-11-01T01:30:00-04:00[America/New_York]',
    '2026-11-01T01:30:00-05:00[America/New_York]',
    '2026-07-01T10:00:00Z[UTC]',
    // `[Z]` is offset 0 with no zone id (threw before v2.9.0).
    '2026-07-01T10:00:00[Z]',
    '2026-07-01T10:00:00[z]',
    '2026-07-01T10:00:00Z[Z]',
    '2026-07-01T10:00:00+01:00[Z]',
    // Hours without minutes (threw before v2.9.0).
    '2026-07-01T10+01:00',
    '2026-07-01T10Z',
    '2026-07-01T10[Europe/Madrid]',
    '2026-07-01T10[europe/madrid]',
    '2026-07-01T10Z[Europe/Madrid]',
  ])('matches the driver for %s in both modes (v2.9.0)', async (iso) => {
    await expectSame(iso, false);
    await expectSame(iso, true);
  });

  it.each([
    // Zone ids are case-insensitive and come back in Neo4j's spelling.
    ['2026-07-01T10:00:00[europe/madrid]', 'ZONE_ID_CASE'],
    ['2026-07-01T10:00:00[EUROPE/MADRID]', 'ZONE_ID_CASE'],
    ['2026-07-01T10:00:00[us/eastern]', 'ZONE_ID_CASE'],
    ['2026-07-01T10:00:00[utc]', 'ZONE_ID_CASE'],
    ['2026-07-01T10:00:00[america/port-au-prince]', 'ZONE_ID_CASE'],
    ['2026-07-01T10:00:00[america/argentina/buenos_aires]', 'ZONE_ID_CASE'],
    // Rejected by Neo4j.
    ['2026-07-01T10:00:00+05:00[Europe/Madrid]', 'ZONE_OFFSET_MISMATCH'],
    ['2026-07-01T10:00:00Z[Europe/Madrid]', 'ZONE_OFFSET_MISMATCH'],
    ['2026-07-01T10:00:00+02:00[Asia/Kathmandu]', 'ZONE_OFFSET_MISMATCH'],
    ['2026-03-29T02:30:00+01:00[Europe/Madrid]', 'ZONE_OFFSET_MISMATCH'],
    ['2026-03-29T02:30:00+02:00[Europe/Madrid]', 'ZONE_OFFSET_MISMATCH'],
    ['2026-10-25T02:30:00+03:00[Europe/Madrid]', 'ZONE_OFFSET_MISMATCH'],
    ['1900-01-01T00:00:00-00:15[Europe/Madrid]', 'ZONE_OFFSET_MISMATCH'],
    ['2026-07-01T10:00:00+18:01', 'OFFSET_RANGE'],
    ['2026-07-01T10:00:00-18:01', 'OFFSET_RANGE'],
    ['2026-07-01T10:00:00+19', 'OFFSET_RANGE'],
    ['2026-07-01T10:00:00+05:75', 'OFFSET_RANGE'],
    ['2026-12-31T23:59:59-23:59', 'OFFSET_RANGE'],
    ['2026-07-01T10:00:00[EST]', 'ZONE_ID_UNSUPPORTED'],
    ['2026-07-01T10:00:00[mst]', 'ZONE_ID_UNSUPPORTED'],
    ['2026-07-01T10:00:00[hst]', 'ZONE_ID_UNSUPPORTED'],
    ['2026-07-01T10:00:00[ROC]', 'ZONE_ID_UNSUPPORTED'],
    ['2026-07-01T10:00:00[GMT+0]', 'ZONE_ID_UNSUPPORTED'],
    ['2026-07-01T10:00:00[GMT-0]', 'ZONE_ID_UNSUPPORTED'],
    ['2026-07-01T10:00:00[+05:00]', 'ZONE_ID_UNSUPPORTED'],
    ['2026-07-01Z', 'DATE_ONLY_ZONE'],
    ['2026-07-01+01:00', 'DATE_ONLY_ZONE'],
    ['2026-07-01-05:00', 'DATE_ONLY_ZONE'],
    ['2026-07-01[Europe/Madrid]', 'DATE_ONLY_ZONE'],
    ['20260701Z', 'DATE_ONLY_ZONE'],
  ])(
    'matches the driver for %s under strict; the default keeps its v2.8.0 value and warns %s (v2.9.0)',
    async (iso, code) => {
      await expectSame(iso, true);
      const loose = fromFactory(iso, false);
      expect([iso, loose.error]).toEqual([iso, undefined]);
      expect(loose.codes).toEqual([`GRAFEO_RECORD_FACTORY_${code}`]);
    },
  );

  // ---------------------------------------------------------------------
  // v2.16.0 — Neo4j's full date grammar; strict rejects what Neo4j rejects
  // ---------------------------------------------------------------------

  it.each([
    // Week dates (the date may fall in the previous or next year).
    '2024-W01-1T10:00:00Z',
    '2024-W01-1',
    '2024-W01',
    '2024-W1',
    '2024-W1-1T1:2',
    '2024-W01-7',
    '2024-W52',
    '2024W01',
    '2024W011',
    '2024W011T1000',
    '2020-W53-7',
    '2026-W53-1',
    '2026-W53-7T23:59',
    '2025-W01-1',
    '-0001-W01-1',
    '+2024-W01-1',
    '2024-w01-1',
    '2024-W01-1T10:00:00.5[Europe/Berlin]',
    '2024-W1-1T1:2:3.123456789-05:00',
    // Quarter dates.
    '2024-Q1',
    '2024-Q1-01',
    '2024-Q1-1',
    '2024-Q1-91',
    '2023-Q1-90',
    '2024-Q4-92',
    '2024Q1',
    '2024Q101',
    '2024-Q2-1T10:00',
    '2024Q201T10:00',
    '2024-q1-01',
    // Ordinal dates.
    '2024-001T10:00:00Z',
    '2024-001T10',
    '2024001',
    '2024-366',
    '2024-001T10:00:00+01:00[Europe/Berlin]',
    // One-digit fields in the extended format.
    '2024-1-1T10:00:00Z',
    '2024-01-1T10:00:00Z',
    '2024-1-1T10',
    '2024-01-01T1',
    '2024-01-01T1Z',
    '2024-01-01T1:05',
    '2024-01-01T1:00:00Z',
    '2024-01-01T10:5',
    '2024-01-01T10:5:3',
    '2024-01-01T10:05:3.5',
    '2024-1-1T1:2:3Z',
    '2024-1-1T1:2:3+01:00[Europe/Berlin]',
  ])(
    'reads %s as the driver does, in both modes, without a warning (v2.16.0)',
    async (iso) => {
      await expectSame(iso, false);
      await expectSame(iso, true);
    },
  );

  it.each([
    '2024-W53-1T10:00',
    '2024-W00-1',
    '2024-W01-0',
    '2024-W01-8',
    '2024-Q4-93',
    '2023-Q1-91',
    '2024-Q5-01',
    '2024-000',
    '2023-366',
    '2024-1-32',
    '2024-W01-1[Europe/Berlin]',
    '2024-W1-01',
    '2024-Q01-01',
    '2024-01-01T10.5',
    '2024-01-01T10:30.5',
    '+2024W011',
  ])('rejects %s in both modes, as Neo4j does (v2.16.0)', async (iso) => {
    expect([iso, (await fromDriver(iso)).error !== undefined]).toEqual([
      iso,
      true,
    ]);
    expect([iso, fromFactory(iso, false).error !== undefined]).toEqual([
      iso,
      true,
    ]);
    expect([iso, fromFactory(iso, true).error !== undefined]).toEqual([
      iso,
      true,
    ]);
  });

  it.each([
    // A day its month does not have.
    ['2024-02-30T10:00:00Z', 'INVALID_DATE'],
    ['2023-02-29T10:00:00Z', 'INVALID_DATE'],
    ['2024-04-31T10:00:00', 'INVALID_DATE'],
    ['2024-02-30', 'INVALID_DATE'],
    ['2023-02-29T10Z', 'INVALID_DATE'],
    ['2024-02-30T10:00:00+01:00[Europe/Berlin]', 'INVALID_DATE'],
    // Text Neo4j cannot parse.
    ['2024-01-01 10:00:00Z', 'UNPARSEABLE'],
    ['2024-01-01 10:00Z', 'UNPARSEABLE'],
    ['2024-01-01T10:00:00.1234567891Z', 'UNPARSEABLE'],
    ['2024-01-01T10:00:00.123456789012', 'UNPARSEABLE'],
    ['2024-01-01T10:0005', 'UNPARSEABLE'],
    ['2024-01-01T1000:05', 'UNPARSEABLE'],
    ['12345-01-01', 'UNPARSEABLE'],
    [' 2024-01-01', 'UNPARSEABLE'],
    ['2024-01-01T10:00:00Z ', 'UNPARSEABLE'],
    ['Mon, 01 Jan 2024 10:00:00 GMT', 'UNPARSEABLE'],
    ['2024-01-001', 'UNPARSEABLE'],
    ['2024-1', 'UNPARSEABLE'],
  ])(
    'strict rejects %s as Neo4j does; the default keeps its v2.15.0 value and warns %s (v2.16.0)',
    async (iso, code) => {
      await expectSame(iso, true);
      const loose = fromFactory(iso, false);
      expect([iso, loose.error]).toEqual([iso, undefined]);
      expect(loose.codes).toEqual([`GRAFEO_RECORD_FACTORY_${code}`]);
    },
  );

  it.each([
    // Read by the default with `Date` (pre-v2.5.0), in the machine zone.
    ['2024-001', 'LEGACY_PARSE'],
    ['2024-1-1', 'LEGACY_PARSE'],
    ['2024-01-1', 'LEGACY_PARSE'],
    ['2024-1-01', 'LEGACY_PARSE'],
    ['202402', 'LEGACY_PARSE'],
    ['+1-01-01', 'LEGACY_PARSE'],
    ['+12345-001', 'LEGACY_PARSE'],
    // A signed basic year is all year to Neo4j.
    ['+20240101', 'READ_DIFFERS'],
  ])(
    'strict reads %s as the driver does; the default keeps its v2.15.0 value and warns %s (v2.16.0)',
    async (iso, code) => {
      await expectSame(iso, true);
      const loose = fromFactory(iso, false);
      expect([iso, loose.error]).toEqual([iso, undefined]);
      expect(loose.codes).toEqual([`GRAFEO_RECORD_FACTORY_${code}`]);
    },
  );

  it('spells every zone id as Neo4j returns it, whatever the case, under strict (v2.9.0)', async () => {
    const isos = neo4jZoneIds().flatMap((id) => [
      `2026-07-01T10:00:00[${id.toLowerCase()}]`,
      `2026-01-15T23:45:30.5[${id.toUpperCase()}]`,
    ]);
    const session = driver.session();
    let values: Record<string, unknown>[];
    try {
      const res = await session.run(
        'UNWIND $isos AS iso RETURN datetime(iso) AS v',
        { isos },
      );
      values = res.records.map((r) => r.get('v'));
    } finally {
      await session.close();
    }
    const mismatches = isos.filter((iso, i) => {
      const dt = Neo4jRecordFactory.dateTime(iso, { strict: true }) as Record<
        string,
        unknown
      >;
      return (
        String(dt) !== String(values[i]) ||
        dt.timeZoneId !== values[i].timeZoneId
      );
    });
    expect(mismatches).toEqual([]);
  });

  it('matches the driver across DST transitions, with and without an offset, under strict (v2.9.0)', async () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const cases: Array<[string, string, string[]]> = [
      ['Europe/Madrid', '2026-03-29', ['+01:00', '+02:00', '+03:00']],
      ['Europe/Madrid', '2026-10-25', ['+01:00', '+02:00', '+03:00']],
      ['America/New_York', '2026-03-08', ['-03:00', '-04:00', '-05:00']],
      ['America/New_York', '2026-11-01', ['-03:00', '-04:00', '-05:00']],
      ['Australia/Lord_Howe', '2026-04-05', ['+10:30', '+11:00']],
      ['Europe/Dublin', '2026-10-25', ['Z', '+01:00']],
    ];
    for (const [zone, day, offsets] of cases)
      for (let m = 0; m < 5 * 60; m += 15) {
        const wall = `${day}T${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`;
        for (const offset of ['', ...offsets])
          await expectSame(`${wall}${offset}[${zone}]`, true);
      }
  });
});
