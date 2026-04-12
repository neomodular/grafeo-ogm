import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseSchema } from '../src/schema/parser';
import { ResultMapper } from '../src/execution/result-mapper';
import {
  generateTypes,
  type GenerateTypesResult,
} from '../src/generator/generate-types';
import neo4j from 'neo4j-driver';

// --- Schema parser: scalar type recognition ---------------------------------

describe('parseSchema - new scalar types', () => {
  const temporalSchema = `
    type Event {
      id: ID! @id @unique
      startDate: Date!
      startTime: Time
      localStart: LocalTime
      localDateTime: LocalDateTime
      duration: Duration
      createdAt: DateTime!
    }
  `;

  const spatialSchema = `
    type Location {
      id: ID! @id @unique
      coordinates: Point!
      mapPosition: CartesianPoint
    }
  `;

  const bigIntSchema = `
    type Transaction {
      id: ID! @id @unique
      amount: BigInt!
    }
  `;

  describe('temporal types', () => {
    it('should recognize Date as a scalar property', () => {
      const metadata = parseSchema(temporalSchema);
      const event = metadata.nodes.get('Event')!;
      const prop = event.properties.get('startDate')!;

      expect(prop.type).toBe('Date');
      expect(prop.required).toBe(true);
      // Should NOT be treated as a relationship
      expect(event.relationships.has('startDate')).toBe(false);
    });

    it('should recognize Time as a scalar property', () => {
      const metadata = parseSchema(temporalSchema);
      const event = metadata.nodes.get('Event')!;
      const prop = event.properties.get('startTime')!;

      expect(prop.type).toBe('Time');
      expect(prop.required).toBe(false);
      expect(event.relationships.has('startTime')).toBe(false);
    });

    it('should recognize LocalTime as a scalar property', () => {
      const metadata = parseSchema(temporalSchema);
      const event = metadata.nodes.get('Event')!;
      const prop = event.properties.get('localStart')!;

      expect(prop.type).toBe('LocalTime');
      expect(event.relationships.has('localStart')).toBe(false);
    });

    it('should recognize LocalDateTime as a scalar property', () => {
      const metadata = parseSchema(temporalSchema);
      const event = metadata.nodes.get('Event')!;
      const prop = event.properties.get('localDateTime')!;

      expect(prop.type).toBe('LocalDateTime');
      expect(event.relationships.has('localDateTime')).toBe(false);
    });

    it('should recognize Duration as a scalar property', () => {
      const metadata = parseSchema(temporalSchema);
      const event = metadata.nodes.get('Event')!;
      const prop = event.properties.get('duration')!;

      expect(prop.type).toBe('Duration');
      expect(event.relationships.has('duration')).toBe(false);
    });
  });

  describe('spatial types', () => {
    it('should recognize Point as a scalar property', () => {
      const metadata = parseSchema(spatialSchema);
      const location = metadata.nodes.get('Location')!;
      const prop = location.properties.get('coordinates')!;

      expect(prop.type).toBe('Point');
      expect(prop.required).toBe(true);
      expect(location.relationships.has('coordinates')).toBe(false);
    });

    it('should recognize CartesianPoint as a scalar property', () => {
      const metadata = parseSchema(spatialSchema);
      const location = metadata.nodes.get('Location')!;
      const prop = location.properties.get('mapPosition')!;

      expect(prop.type).toBe('CartesianPoint');
      expect(prop.required).toBe(false);
      expect(location.relationships.has('mapPosition')).toBe(false);
    });
  });

  describe('BigInt type', () => {
    it('should recognize BigInt as a scalar property', () => {
      const metadata = parseSchema(bigIntSchema);
      const tx = metadata.nodes.get('Transaction')!;
      const prop = tx.properties.get('amount')!;

      expect(prop.type).toBe('BigInt');
      expect(prop.required).toBe(true);
      expect(tx.relationships.has('amount')).toBe(false);
    });
  });
});

// --- Where emitter: operator generation for new types -----------------------

// We test the where emitter indirectly through generateTypes since
// emitWhereTypes is not exported directly. Instead, we verify the
// classification logic by importing the where-emitter and checking
// the generated types include the right operators.

describe('Where emitter - scalar classification', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scalar-test-'));

  let fileCounter = 0;

  async function genOutput(typeDefs: string): Promise<string> {
    const outFile = path.join(tmpDir, `out-${fileCounter++}.ts`);
    await generateTypes({
      typeDefs,
      outFile,
      config: { formatOutput: false },
    });
    return fs.readFileSync(outFile, 'utf-8');
  }

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should generate comparison operators for temporal types', async () => {
    const output = await genOutput(`
      type Event {
        id: ID! @id @unique
        startDate: Date!
        startTime: Time
        localStart: LocalTime
        localDateTime: LocalDateTime
        duration: Duration
      }
    `);

    // Temporal types should have _LT, _LTE, _GT, _GTE
    expect(output).toContain('startDate_LT?');
    expect(output).toContain('startDate_LTE?');
    expect(output).toContain('startDate_GT?');
    expect(output).toContain('startDate_GTE?');

    expect(output).toContain('duration_LT?');
    expect(output).toContain('duration_GTE?');

    // Temporal types should NOT have string operators
    expect(output).not.toContain('startDate_CONTAINS?');
    expect(output).not.toContain('startDate_STARTS_WITH?');
  });

  it('should generate only equality operators for spatial types', async () => {
    const output = await genOutput(`
      type Location {
        id: ID! @id @unique
        coordinates: Point!
        mapPosition: CartesianPoint
      }
    `);

    // Spatial types should have basic operators
    expect(output).toContain('coordinates?');
    expect(output).toContain('coordinates_NOT?');
    expect(output).toContain('coordinates_IN?');
    expect(output).toContain('coordinates_NOT_IN?');

    // Spatial types should NOT have comparison or string operators
    expect(output).not.toContain('coordinates_LT?');
    expect(output).not.toContain('coordinates_GT?');
    expect(output).not.toContain('coordinates_CONTAINS?');
    expect(output).not.toContain('coordinates_STARTS_WITH?');

    // Same for CartesianPoint
    expect(output).not.toContain('mapPosition_LT?');
    expect(output).not.toContain('mapPosition_CONTAINS?');
  });

  it('should map BigInt to string type in node type output', async () => {
    const output = await genOutput(`
      type Transaction {
        id: ID! @id @unique
        amount: BigInt!
      }
    `);

    // BigInt maps to Scalars["BigInt"]["output"] which is string
    expect(output).toContain('Scalars["BigInt"]["output"]');
  });

  it('should map Point to spatial object type in node type output', async () => {
    const output = await genOutput(`
      type Location {
        id: ID! @id @unique
        coordinates: Point!
      }
    `);

    // Point maps to Scalars["Point"]["output"]
    expect(output).toContain('Scalars["Point"]["output"]');
  });

  it('should generate comparison operators for BigInt (numeric-like)', async () => {
    const output = await genOutput(`
      type Transaction {
        id: ID! @id @unique
        amount: BigInt!
      }
    `);

    // BigInt is classified as numeric-like, so it should have comparison ops
    expect(output).toContain('amount_LT?');
    expect(output).toContain('amount_LTE?');
    expect(output).toContain('amount_GT?');
    expect(output).toContain('amount_GTE?');

    // But NOT string operators
    expect(output).not.toContain('amount_CONTAINS?');
    expect(output).not.toContain('amount_STARTS_WITH?');
  });
});

// --- ResultMapper: temporal type conversion ----------------------------------

describe('ResultMapper - new temporal types', () => {
  it('should convert LocalDateTime to string', () => {
    const localDt = new neo4j.types.LocalDateTime(2024, 6, 15, 10, 30, 0, 0);
    const result = ResultMapper.convertNeo4jTypes(localDt);
    expect(typeof result).toBe('string');
    expect(result).toContain('2024');
  });

  it('should convert LocalTime to string', () => {
    const localTime = new neo4j.types.LocalTime(14, 30, 0, 0);
    const result = ResultMapper.convertNeo4jTypes(localTime);
    expect(typeof result).toBe('string');
  });

  it('should convert Duration to string', () => {
    const duration = new neo4j.types.Duration(1, 2, 3, 0);
    const result = ResultMapper.convertNeo4jTypes(duration);
    expect(typeof result).toBe('string');
  });

  it('should convert Date to string', () => {
    const date = new neo4j.types.Date(2024, 1, 15);
    const result = ResultMapper.convertNeo4jTypes(date);
    expect(typeof result).toBe('string');
    expect(result).toContain('2024');
  });

  it('should convert Time to string', () => {
    const time = new neo4j.types.Time(10, 30, 0, 0, 0);
    const result = ResultMapper.convertNeo4jTypes(time);
    expect(typeof result).toBe('string');
  });

  it('should convert Point to plain object with srid', () => {
    const point = new neo4j.types.Point(4326, 1.5, 2.5);
    const result = ResultMapper.convertNeo4jTypes(point) as Record<
      string,
      unknown
    >;

    expect(result.x).toBe(1.5);
    expect(result.y).toBe(2.5);
    expect(result.srid).toBe(4326);
  });

  it('should convert 3D Point with z coordinate', () => {
    const point = new neo4j.types.Point(4979, 1.5, 2.5, 3.5);
    const result = ResultMapper.convertNeo4jTypes(point) as Record<
      string,
      unknown
    >;

    expect(result.x).toBe(1.5);
    expect(result.y).toBe(2.5);
    expect(result.z).toBe(3.5);
    expect(result.srid).toBe(4979);
  });

  it('should handle temporal types inside nested objects', () => {
    const obj = {
      name: 'Test',
      startDate: new neo4j.types.Date(2024, 6, 15),
      location: new neo4j.types.Point(4326, 10, 20),
    };

    const result = ResultMapper.convertNeo4jTypes(obj) as Record<
      string,
      unknown
    >;
    expect(typeof result.startDate).toBe('string');
    expect((result.location as Record<string, unknown>).srid).toBe(4326);
  });

  it('should handle temporal types inside arrays', () => {
    const arr = [
      new neo4j.types.LocalDateTime(2024, 1, 1, 0, 0, 0, 0),
      new neo4j.types.LocalDateTime(2024, 12, 31, 23, 59, 59, 0),
    ];

    const result = ResultMapper.convertNeo4jTypes(arr) as string[];
    expect(result).toHaveLength(2);
    expect(typeof result[0]).toBe('string');
    expect(typeof result[1]).toBe('string');
  });
});
