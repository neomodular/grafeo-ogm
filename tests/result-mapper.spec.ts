import neo4j, { Record as Neo4jRecord } from 'neo4j-driver';
import { ResultMapper, durationToString } from '../src/execution/result-mapper';

/** Helper to create a mock Neo4j Record */
function createMockRecord(data: Record<string, unknown>): Neo4jRecord {
  const keys = Object.keys(data);
  return {
    get: (key: string) => data[key],
    toObject: () => ({ ...data }),
    keys,
  } as Neo4jRecord;
}

describe('ResultMapper', () => {
  describe('convertNeo4jTypes', () => {
    it('should return plain objects as-is', () => {
      const obj = { name: 'test', value: 42 };
      expect(ResultMapper.convertNeo4jTypes(obj)).toEqual(obj);
    });

    it('should convert Neo4j Integer to number', () => {
      const intVal = neo4j.int(42);
      expect(ResultMapper.convertNeo4jTypes(intVal)).toBe(42);
    });

    // v1.7.3 — safe-range guard
    it('returns BigInt for Neo4j Integers above 2^53 (no silent truncation)', () => {
      // Number.MAX_SAFE_INTEGER + 2 — would round-trip incorrectly via toNumber().
      const huge = neo4j.int('9007199254740993');
      const out = ResultMapper.convertNeo4jTypes(huge);
      expect(typeof out).toBe('bigint');
      expect(out).toBe(9007199254740993n);
    });

    it('still returns Number for Integers within the safe range', () => {
      // The exact safe-integer boundary stays a Number to keep callers
      // from having to handle BigInt for ordinary IDs / counters.
      expect(ResultMapper.convertNeo4jTypes(neo4j.int(9007199254740991))).toBe(
        9007199254740991,
      );
      expect(ResultMapper.convertNeo4jTypes(neo4j.int(-9007199254740991))).toBe(
        -9007199254740991,
      );
    });

    it('should convert Neo4j DateTime to ISO string', () => {
      const dt = new neo4j.types.DateTime(2024, 1, 15, 10, 30, 0, 0, 0);
      const result = ResultMapper.convertNeo4jTypes(dt);
      expect(typeof result).toBe('string');
      expect(result).toContain('2024');
    });

    it('should convert Neo4j Date to string', () => {
      const date = new neo4j.types.Date(2024, 6, 15);
      const result = ResultMapper.convertNeo4jTypes(date);
      expect(typeof result).toBe('string');
      expect(result).toContain('2024');
    });

    it('should handle nested objects recursively', () => {
      const nested = {
        name: 'test',
        count: neo4j.int(5),
        inner: {
          value: neo4j.int(10),
          label: 'hello',
        },
      };

      const result = ResultMapper.convertNeo4jTypes(nested) as Record<
        string,
        unknown
      >;
      expect(result.name).toBe('test');
      expect(result.count).toBe(5);
      expect((result.inner as Record<string, unknown>).value).toBe(10);
      expect((result.inner as Record<string, unknown>).label).toBe('hello');
    });

    it('should handle arrays', () => {
      const arr = [neo4j.int(1), neo4j.int(2), 'three'];
      const result = ResultMapper.convertNeo4jTypes(arr);
      expect(result).toEqual([1, 2, 'three']);
    });

    it('should return null as null', () => {
      expect(ResultMapper.convertNeo4jTypes(null)).toBeNull();
    });

    it('should return undefined as undefined', () => {
      expect(ResultMapper.convertNeo4jTypes(undefined)).toBeUndefined();
    });

    it('should return primitives as-is', () => {
      expect(ResultMapper.convertNeo4jTypes('hello')).toBe('hello');
      expect(ResultMapper.convertNeo4jTypes(42)).toBe(42);
      expect(ResultMapper.convertNeo4jTypes(true)).toBe(true);
    });

    it('should convert Neo4j Point without z coordinate', () => {
      const point = new neo4j.types.Point(4326, 12.5, 55.7);
      const result = ResultMapper.convertNeo4jTypes(point) as Record<
        string,
        unknown
      >;
      expect(result.x).toBe(12.5);
      expect(result.y).toBe(55.7);
      expect(result.srid).toBe(4326);
      expect(result.z).toBeUndefined();
    });

    it('should convert Neo4j Point with z coordinate', () => {
      const point = new neo4j.types.Point(4979, 12.5, 55.7, 100);
      const result = ResultMapper.convertNeo4jTypes(point) as Record<
        string,
        unknown
      >;
      expect(result.x).toBe(12.5);
      expect(result.y).toBe(55.7);
      expect(result.z).toBe(100);
      expect(result.srid).toBe(4979);
    });

    // v2.4.8 — the lossless driver hands back `srid` as a Neo4j Integer.
    it('should convert an Integer Point srid to a number', () => {
      const point = new neo4j.types.Point(neo4j.int(7203), 1.5, 2.5);
      const result = ResultMapper.convertNeo4jTypes(point);
      expect(result).toEqual({ x: 1.5, y: 2.5, srid: 7203 });
    });

    it('should convert Neo4j Node to its properties', () => {
      const node = new neo4j.types.Node(neo4j.int(1), ['Book'], {
        title: 'Aspirin',
        id: neo4j.int(42),
      });
      const result = ResultMapper.convertNeo4jTypes(node) as Record<
        string,
        unknown
      >;
      expect(result.title).toBe('Aspirin');
      expect(result.id).toBe(42);
    });

    it('should convert Neo4j Relationship to its properties', () => {
      const rel = new neo4j.types.Relationship(
        neo4j.int(1),
        neo4j.int(2),
        neo4j.int(3),
        'HAS_STATUS',
        { priority: neo4j.int(5) },
      );
      const result = ResultMapper.convertNeo4jTypes(rel) as Record<
        string,
        unknown
      >;
      expect(result.priority).toBe(5);
    });

    it('should throw on Neo4j Path type', () => {
      const startNode = new neo4j.types.Node(neo4j.int(1), ['A'], {});
      const endNode = new neo4j.types.Node(neo4j.int(2), ['B'], {});
      const path = new neo4j.types.Path(startNode, endNode, []);
      expect(() => ResultMapper.convertNeo4jTypes(path)).toThrow(
        /Path type conversion is not supported/,
      );
    });

    it('should convert Neo4j Time to string', () => {
      const time = new neo4j.types.Time(10, 30, 0, 0, 0);
      const result = ResultMapper.convertNeo4jTypes(time);
      expect(typeof result).toBe('string');
    });
  });

  // v2.30.0 — neo4j-driver 6 changed `Duration.toString()` (`P10YT`, `PT1H`,
  // `P2DT`); Neo4j 5.x cannot parse a string ending in `T`, so a Duration
  // read through grafeo could not be written back. Output is driver 5's
  // form on every driver. These are real driver objects, so the driver-6
  // CI leg runs them against driver 6's Duration.
  describe('Duration output (driver-independent, v2.30.0)', () => {
    const D = (m: number, d: number, s: number, ns: number) =>
      new neo4j.types.Duration(m, d, s, ns);

    it.each([
      ['zero', D(0, 0, 0, 0), 'P0M0DT0S'],
      ['whole years', D(120, 0, 0, 0), 'P120M0DT0S'],
      ['whole days', D(0, 2, 0, 0), 'P0M2DT0S'],
      ['one hour', D(0, 0, 3600, 0), 'P0M0DT3600S'],
      [
        'mixed months / days / seconds / nanos',
        D(14, 3, 14706, 500000000),
        'P14M3DT14706.500000000S',
      ],
      ['one nanosecond', D(0, 0, 0, 1), 'P0M0DT0.000000001S'],
      [
        'nanoseconds above a second carry into seconds',
        D(0, 0, 0, 2500000000),
        'P0M0DT2.500000000S',
      ],
      ['negative whole seconds', D(0, 0, -90, 0), 'P0M0DT-90S'],
      [
        'negative seconds with nanos (-1.5s)',
        D(0, 0, -2, 500000000),
        'P0M0DT-1.500000000S',
      ],
      [
        'negative seconds with nanos (-0.5s)',
        D(0, 0, -1, 500000000),
        'P0M0DT-0.500000000S',
      ],
      ['negative seconds, 1ns', D(0, 0, -5000, 1), 'P0M0DT-4999.999999999S'],
      [
        'negative nanoseconds borrow a second',
        D(0, 0, 0, -1),
        'P0M0DT-0.000000001S',
      ],
      ['negative months and days', D(-14, -3, 0, 0), 'P-14M-3DT0S'],
    ])('%s', (_name, duration, expected) => {
      expect(ResultMapper.convertNeo4jTypes(duration)).toBe(expected);
    });

    it('reads Integer, bigint and number fields alike (driver 5 vs 6 field types)', () => {
      const viaInteger = new neo4j.types.Duration(
        neo4j.int(13),
        neo4j.int(1),
        neo4j.int(61),
        neo4j.int(7),
      );
      const viaBigInt = new neo4j.types.Duration(13n, 1n, 61n, 7n);
      expect(ResultMapper.convertNeo4jTypes(viaInteger)).toBe(
        'P13M1DT61.000000007S',
      );
      expect(ResultMapper.convertNeo4jTypes(viaBigInt)).toBe(
        'P13M1DT61.000000007S',
      );
      // Driver 6 decodes a server Duration with `number` (or `bigint`)
      // seconds / nanoseconds; driver 5 always holds `Integer` there.
      expect(
        durationToString({ months: 13, days: 1, seconds: 61, nanoseconds: 7 }),
      ).toBe('P13M1DT61.000000007S');
      expect(
        durationToString({
          months: 0n,
          days: 0n,
          seconds: -2n,
          nanoseconds: 500000000n,
        }),
      ).toBe('P0M0DT-1.500000000S');
    });

    it('keeps seconds beyond 2^53 exact', () => {
      expect(
        durationToString({
          months: 0,
          days: 0,
          seconds: neo4j.int('9007199254740993'),
          nanoseconds: 0,
        }),
      ).toBe('P0M0DT9007199254740993S');
    });

    it('converts a Duration nested in a node and a list', () => {
      expect(
        ResultMapper.convertNeo4jTypes({
          ttl: D(0, 1, 0, 0),
          ttls: [D(12, 0, 0, 0)],
        }),
      ).toEqual({ ttl: 'P0M1DT0S', ttls: ['P12M0DT0S'] });
    });
  });

  // v2.30.0 — pins the other temporal strings: they are the same on
  // neo4j-driver 5 and 6 (checked against both), and the driver-6 CI leg
  // fails here if a driver release changes them.
  describe('other temporal output (same on driver 5 and 6)', () => {
    it.each([
      ['Date', new neo4j.types.Date(2024, 2, 29), '2024-02-29'],
      [
        'Date, negative year',
        new neo4j.types.Date(-44, 3, 15),
        '-000044-03-15',
      ],
      ['Date, year > 9999', new neo4j.types.Date(12345, 1, 1), '+012345-01-01'],
      [
        'Time',
        new neo4j.types.Time(10, 5, 3, 120000000, 3600),
        '10:05:03.120000000+01:00',
      ],
      ['Time, UTC', new neo4j.types.Time(10, 5, 3, 0, 0), '10:05:03Z'],
      [
        'LocalTime',
        new neo4j.types.LocalTime(23, 59, 59, 1),
        '23:59:59.000000001',
      ],
      [
        'LocalDateTime',
        new neo4j.types.LocalDateTime(2024, 1, 2, 3, 4, 5, 6),
        '2024-01-02T03:04:05.000000006',
      ],
      [
        'DateTime, offset',
        new neo4j.types.DateTime(2024, 1, 2, 3, 4, 5, 6, 3600),
        '2024-01-02T03:04:05.000000006+01:00',
      ],
      [
        'DateTime, zone id',
        new neo4j.types.DateTime(2024, 7, 2, 3, 4, 5, 6, 7200, 'Europe/Madrid'),
        '2024-07-02T03:04:05.000000006+02:00[Europe/Madrid]',
      ],
    ])('%s', (_name, value, expected) => {
      expect(ResultMapper.convertNeo4jTypes(value)).toBe(expected);
    });
  });

  describe('mapRecord', () => {
    it('should extract value by returnKey and convert types', () => {
      const record = createMockRecord({
        n: { id: neo4j.int(1), name: 'Book A' },
      });

      const result = ResultMapper.mapRecord(record, 'n');
      expect(result).toEqual({ id: 1, name: 'Book A' });
    });

    it('should convert entire record to object when no returnKey', () => {
      const record = createMockRecord({
        name: 'test',
        count: neo4j.int(7),
      });

      const result = ResultMapper.mapRecord(record);
      expect(result).toEqual({ name: 'test', count: 7 });
    });
  });

  describe('mapRecords', () => {
    it('should map multiple records', () => {
      const records = [
        createMockRecord({ n: { id: neo4j.int(1), name: 'A' } }),
        createMockRecord({ n: { id: neo4j.int(2), name: 'B' } }),
      ];

      const results = ResultMapper.mapRecords(records, 'n');
      expect(results).toEqual([
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
      ]);
    });

    it('should return empty array for empty input', () => {
      expect(ResultMapper.mapRecords([])).toEqual([]);
    });
  });
});
