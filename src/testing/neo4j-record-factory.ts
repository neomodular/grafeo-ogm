import neo4j, { Integer, Record as Neo4jRecord } from 'neo4j-driver';

/**
 * ISO-8601 date-time as Neo4j's `datetime()` accepts it: a date, an
 * optional time with up to nine fractional digits, an optional offset
 * (`Z`, `±HH`, `±HHMM`, `±HH:MM`) and an optional `[Area/City]` zone id.
 */
const ISO_DATE_TIME =
  /^([+-]?\d{4,})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?(?:\[([^\]]+)\])?$/i;

function parseOffsetSeconds(offset: string): number {
  if (offset.toUpperCase() === 'Z') return 0;
  const sign = offset[0] === '-' ? -1 : 1;
  const digits = offset.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
  return sign * (hours * 3600 + minutes * 60);
}

/**
 * Offset of `timeZone` at the given wall-clock time, in seconds. Two passes
 * so a wall time near a DST transition lands on the offset in force then.
 */
function zoneOffsetSeconds(timeZone: string, wallClockAsUtcMs: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const offsetAt = (instantMs: number): number => {
    const p: Record<string, number> = {};
    for (const part of fmt.formatToParts(new Date(instantMs)))
      if (part.type !== 'literal') p[part.type] = Number(part.value);
    const asUtc = Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      p.hour,
      p.minute,
      p.second,
    );
    return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 1000);
  };
  const first = offsetAt(wallClockAsUtcMs);
  return offsetAt(wallClockAsUtcMs - first * 1000);
}

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
   * Create a Neo4j DateTime value from an ISO string, as the driver would
   * return `datetime(isoString)`: the wall-clock fields and the offset are
   * kept as written (`10:00+02:00` stays `10:00+02:00`), all nine fractional
   * digits are kept, and a `[Area/City]` zone id is carried over.
   *
   * Field values are plain numbers (what the driver returns with
   * `disableLosslessIntegers`), so `toString()` matches the driver's.
   *
   * A string with neither an offset nor a zone id is read as UTC, as Neo4j
   * reads it with its default zone.
   *
   * Before v2.4.8 the value was converted to UTC with the offset dropped
   * and the fraction cut to milliseconds; before v2.5.0 an offset-less
   * string was read in the machine's local zone.
   */
  static dateTime(isoString: string): unknown {
    const m = ISO_DATE_TIME.exec(isoString.trim());
    // A non-ISO string `Date` understands (e.g. RFC 2822) keeps the
    // pre-v2.5.0 parse.
    if (!m) return Neo4jRecordFactory.legacyDateTime(isoString);

    const [, y, mo, d, h, mi, s, frac, offset, zoneId] = m;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h ?? 0);
    const minute = Number(mi ?? 0);
    const second = Number(s ?? 0);
    const nanosecond = frac ? Number(frac.padEnd(9, '0')) : 0;

    const offsetSeconds =
      offset !== undefined
        ? parseOffsetSeconds(offset)
        : zoneId !== undefined
          ? zoneOffsetSeconds(
              zoneId,
              Date.UTC(year, month - 1, day, hour, minute, second),
            )
          : 0;

    return new neo4j.types.DateTime(
      year,
      month,
      day,
      hour,
      minute,
      second,
      nanosecond,
      offsetSeconds,
      zoneId,
    );
  }

  /** The pre-v2.5.0 parse: through `Date`, in UTC, millisecond precision. */
  private static legacyDateTime(isoString: string): unknown {
    const d = new Date(isoString);
    // An Invalid Date used to reach the driver as NaN fields and fail there
    // with an unrelated message.
    if (Number.isNaN(d.getTime()))
      throw new TypeError(
        `Neo4jRecordFactory.dateTime: '${isoString}' is not an ISO-8601 date-time`,
      );
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
   *
   * `properties` are stored as given. The driver returns an Int property as
   * an Integer, so pass `Neo4jRecordFactory.integer(n)` where a test needs
   * that; a JS number is never converted, because it may stand for a Float.
   *
   * `options.identity` and `options.elementId` (v2.5.0) give mock nodes
   * distinct ids; without them every node has identity 0 and elementId "0".
   * A given identity alone yields elementId `String(identity)`, as the
   * driver does for a 4.x server.
   */
  static node(
    labels: string[],
    properties: Record<string, unknown>,
    options: { identity?: number | Integer; elementId?: string } = {},
  ): unknown {
    const identity = neo4j.int(options.identity ?? 0);
    return new neo4j.types.Node(
      identity,
      labels,
      properties,
      options.elementId ?? identity.toString(),
    );
  }
}
