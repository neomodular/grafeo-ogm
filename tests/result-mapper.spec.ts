import neo4j, { Record as Neo4jRecord } from 'neo4j-driver';
import { ResultMapper } from '../src/execution/result-mapper';

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
