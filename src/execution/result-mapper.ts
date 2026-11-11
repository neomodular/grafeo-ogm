import neo4j from 'neo4j-driver';
import { Record as Neo4jRecord } from 'neo4j-driver';
import { OGMError } from '../errors';

/** A Duration field as either driver hands it out. */
type DurationField = number | bigint | { toBigInt(): bigint };

const NANOS_PER_SECOND = BigInt(1_000_000_000);

function toBigIntField(value: DurationField): bigint {
  if (typeof value === 'bigint') return value;
  // `int()` reads a number as driver 5 does (truncated, NaN → 0).
  if (typeof value === 'number') return neo4j.int(value).toBigInt();
  return value.toBigInt();
}

/**
 * v2.30.0 — a Duration as the ISO-8601 string neo4j-driver 5's
 * `Duration.toString()` returns (`P<months>M<days>DT<seconds>S`, e.g.
 * `P120M0DT0S`, `P0M0DT-0.500000000S`), whatever the driver version.
 *
 * neo4j-driver 6 prints a shorter form (`P10YT`, `PT1H`, `P2DT`) that
 * Neo4j 5.x rejects in `duration()` ("Text cannot be parsed to a
 * Duration") whenever it ends in `T`, so a Duration read through grafeo
 * could not be written back or used in a filter. Driver 6 also hands the
 * fields out as `number` / `bigint` where driver 5 used `Integer`, so the
 * fields are read through BigInt.
 *
 * Mirrors driver 5's `durationToIsoString` /
 * `formatSecondsAndNanosecondsForDuration`: the seconds part carries the
 * sign and the nanoseconds are the 9-digit fraction of that signed value
 * (`seconds = -2, nanoseconds = 5e8` → `-1.500000000`, `-1` → `-0.5…`).
 */
export function durationToString(duration: {
  months: DurationField;
  days: DurationField;
  seconds: DurationField;
  nanoseconds: DurationField;
}): string {
  const months = toBigIntField(duration.months);
  const days = toBigIntField(duration.days);
  // Both drivers already keep 0 <= nanoseconds < 1e9; normalize anyway.
  const rawNanos = toBigIntField(duration.nanoseconds);
  let nanos = rawNanos % NANOS_PER_SECOND;
  if (nanos < BigInt(0)) nanos += NANOS_PER_SECOND;
  const seconds =
    toBigIntField(duration.seconds) + (rawNanos - nanos) / NANOS_PER_SECOND;

  let secondsString: string;
  let fraction = '';
  if (nanos > BigInt(0)) {
    if (seconds < BigInt(0)) {
      secondsString =
        seconds === BigInt(-1) ? '-0' : (seconds + BigInt(1)).toString();
      nanos = NANOS_PER_SECOND - nanos;
    } else secondsString = seconds.toString();
    fraction = '.' + nanos.toString().padStart(9, '0');
  } else secondsString = seconds.toString();

  return `P${months}M${days}DT${secondsString}${fraction}S`;
}

/**
 * Maps Neo4j query results to plain JavaScript objects,
 * converting Neo4j-specific types (Integer, DateTime, Node, etc.)
 * to standard JS values.
 */
export class ResultMapper {
  /**
   * Convert a Neo4j Record to a plain object, handling Neo4j-specific types.
   * If returnKey is provided, extracts that key from the record.
   * Otherwise converts the entire record to an object.
   */
  static mapRecord(
    record: Neo4jRecord,
    returnKey?: string,
  ): Record<string, unknown> {
    if (returnKey) {
      const value = record.get(returnKey);
      return ResultMapper.convertNeo4jTypes(value) as Record<string, unknown>;
    }

    const obj = record.toObject();
    return ResultMapper.convertNeo4jTypes(obj) as Record<string, unknown>;
  }

  /**
   * Map all records from a query result.
   */
  static mapRecords(
    records: Neo4jRecord[],
    returnKey?: string,
  ): Record<string, unknown>[] {
    return records.map((record) => ResultMapper.mapRecord(record, returnKey));
  }

  /**
   * Convert Neo4j-specific types to plain JS values recursively.
   * Handles: Integer, DateTime, Date, Time, Point, Node, Relationship, arrays, objects.
   * Note: The driver is typically configured with disableLosslessIntegers: true,
   * so Integer conversion is mainly for safety.
   */
  static convertNeo4jTypes(value: unknown, depth: number = 0): unknown {
    // Guard against pathological nesting causing stack overflow
    if (depth > 50)
      throw new OGMError(
        'convertNeo4jTypes: maximum recursion depth (50) exceeded. Possible circular or deeply nested result.',
      );

    // Fast path: null/undefined
    if (value === null || value === undefined) return value;

    // Fast path: primitives (most common in query results)
    if (typeof value !== 'object') return value;

    // Neo4j Integer → number (or BigInt when the value exceeds the
    // safe-integer range). Pre-1.7.3 this always called `toNumber()`,
    // which silently truncated values above 2^53 — e.g. a stored id
    // of `9007199254740993n` came back as `9007199254740992`. Now we
    // gate on `inSafeRange()` and fall back to BigInt for out-of-range
    // values so consumers see the exact stored value (or can detect
    // the BigInt and route accordingly).
    if (neo4j.isInt(value))
      return value.inSafeRange() ? value.toNumber() : value.toBigInt();

    // Array → map each element (check before other object types)
    if (Array.isArray(value))
      return value.map((item) =>
        ResultMapper.convertNeo4jTypes(item, depth + 1),
      );

    // v2.30.0 — a Duration is formatted here, not by the driver: its
    // `toString()` changed in neo4j-driver 6 (`P10YT`, `P2DT`), which
    // Neo4j 5.x cannot parse back with `duration()`.
    if (neo4j.isDuration(value)) return durationToString(value);

    // Neo4j temporal types → ISO string. Their `toString()` is the same on
    // neo4j-driver 5 and 6.
    if (
      neo4j.isDateTime(value) ||
      neo4j.isDate(value) ||
      neo4j.isTime(value) ||
      neo4j.isLocalDateTime(value) ||
      neo4j.isLocalTime(value)
    )
      return value.toString();

    // Neo4j Point → plain object. v2.4.8 — `srid` is a Neo4j Integer on
    // the driver's default (lossless) configuration; convert it like any
    // other integer instead of leaking `{ low, high }`.
    if (neo4j.isPoint(value)) {
      const point: Record<string, unknown> = {
        x: value.x,
        y: value.y,
        srid: ResultMapper.convertNeo4jTypes(value.srid, depth + 1),
      };
      if (value.z !== undefined) point.z = value.z;
      return point;
    }

    // Neo4j Node → convert its properties
    if (value instanceof neo4j.types.Node)
      return ResultMapper.convertNeo4jTypes(value.properties, depth + 1);

    // Neo4j Relationship → convert its properties
    if (value instanceof neo4j.types.Relationship)
      return ResultMapper.convertNeo4jTypes(value.properties, depth + 1);

    // Neo4j Path → not supported
    if (value instanceof neo4j.types.Path)
      throw new OGMError('Path type conversion is not supported');

    // Plain object → recurse on values. The `Object.create(null)` is a
    // defensive measure against prototype pollution: even if a malicious
    // input tried to set `__proto__`, the resulting object has no
    // prototype chain to pollute. The defensive guard stays.
    //
    // The iteration shape changed in v1.8.0: pre-1.8.0 we used
    // `Object.entries(value)` which allocates a fresh `[key, value][]`
    // pair array PLUS the result object — two allocations per visit.
    // For a result with 16 nested objects (a typical 10-row relationship
    // result), that's 32 allocations per Cypher row. The `for...in` +
    // `hasOwnProperty` form avoids the pair array allocation. We still
    // use `hasOwnProperty.call(value, key)` rather than `value.hasOwnProperty(key)`
    // because the latter would fail on `Object.create(null)` inputs.
    const result: Record<string, unknown> = Object.create(null);
    const obj = value as Record<string, unknown>;
    for (const key in obj)
      if (Object.prototype.hasOwnProperty.call(obj, key))
        result[key] = ResultMapper.convertNeo4jTypes(obj[key], depth + 1);

    return result;
  }
}
