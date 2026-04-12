import neo4j, { Integer, Record as Neo4jRecord } from 'neo4j-driver';

/**
 * Factory for creating mock Neo4j Record objects for testing.
 */
export class Neo4jRecordFactory {
  /**
   * Create a Neo4j Record from a plain object.
   * @param data - Object with keys as field names and values as properties
   * @returns A Neo4j Record instance with get(), toObject(), and keys
   */
  static create(data: Record<string, unknown>): Neo4jRecord {
    const keys = Object.keys(data);
    const values = keys.map((k) => data[k]);
    return new neo4j.types.Record(keys, values) as unknown as Neo4jRecord;
  }

  /**
   * Create a Neo4j Integer value.
   */
  static integer(value: number): Integer {
    return neo4j.int(value);
  }

  /**
   * Create a Neo4j DateTime value from an ISO string.
   */
  static dateTime(isoString: string): unknown {
    const d = new Date(isoString);
    return new neo4j.types.DateTime(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds() * 1_000_000,
      0, // timeZoneOffsetSeconds
    );
  }

  /**
   * Create a mock Neo4j Node.
   */
  static node(labels: string[], properties: Record<string, unknown>): unknown {
    return new neo4j.types.Node(neo4j.int(0), labels, properties);
  }
}
