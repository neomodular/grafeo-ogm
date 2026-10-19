import neo4j, { Integer, Record as Neo4jRecord } from 'neo4j-driver';

/**
 * ISO-8601 date-time as Neo4j's `datetime()` accepts it: a date, an
 * optional time with up to nine fractional digits, an optional offset
 * (`Z`, `±HH`, `±HHMM`, `±HH:MM`) and an optional `[Area/City]` zone id.
 *
 * v2.5.3 — the basic format (`20240101T100000Z`, no separators) is
 * accepted too, as Neo4j accepts it.
 */
const ISO_DATE_TIME =
  /^(?:([+-]?\d{4,})-(\d{2})-(\d{2})|([+-]?\d{4})(\d{2})(\d{2}))(?:[T ](\d{2}):?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?(?:\[([^\]]+)\])?$/i;

function parseOffsetSeconds(offset: string): number {
  if (offset.toUpperCase() === 'Z') return 0;
  const sign = offset[0] === '-' ? -1 : 1;
  const digits = offset.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
  // v2.5.3 — `-00:00` is offset 0, not -0 (which `toEqual` tells apart
  // from the driver's 0).
  return sign * (hours * 3600 + minutes * 60) || 0;
}

/**
 * Epoch milliseconds of a wall-clock time read as UTC. v2.5.3 — `Date.UTC`
 * maps years 0–99 to 1900–1999, so the year is set with `setUTCFullYear`.
 */
function utcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

/** Offset of `timeZone` at an instant, in whole seconds. */
function zoneOffsetAt(timeZone: string, instantMs: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    era: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  let bc = false;
  for (const part of fmt.formatToParts(new Date(instantMs)))
    if (part.type === 'era') bc = part.value.toUpperCase().startsWith('B');
    else if (part.type !== 'literal') p[part.type] = Number(part.value);
  // v2.5.3 — `Intl` writes year -1 as "2 BC".
  const year = bc ? 1 - p.year : p.year;
  const asUtc = utcMs(year, p.month, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 1000);
}

/**
 * Resolve a wall-clock time in `timeZone` as Neo4j (java.time) does:
 * - a valid wall time keeps its offset;
 * - in a DST overlap the earlier offset (the larger one) wins;
 * - in a DST gap the wall time moves later by the length of the gap.
 *
 * Returns the offset and the (possibly shifted) wall time as UTC ms.
 * Pre-2.5.3 a gap time kept its non-existent wall clock and an overlap in
 * a zone east of UTC took the later offset.
 */
function resolveZoned(
  timeZone: string,
  wallMs: number,
): { offsetSeconds: number; wallMs: number } {
  const DAY = 86_400_000;
  const first = zoneOffsetAt(timeZone, wallMs);
  const candidates = new Set<number>([
    zoneOffsetAt(timeZone, wallMs - DAY),
    zoneOffsetAt(timeZone, wallMs + DAY),
    first,
    zoneOffsetAt(timeZone, wallMs - first * 1000),
  ]);
  const valid = [...candidates].filter(
    (o) => zoneOffsetAt(timeZone, wallMs - o * 1000) === o,
  );
  if (valid.length > 0) return { offsetSeconds: Math.max(...valid), wallMs };
  // Gap: the instant uses the offset before the transition (the smaller).
  const instant = wallMs - Math.min(...candidates) * 1000;
  const offsetSeconds = zoneOffsetAt(timeZone, instant);
  return { offsetSeconds, wallMs: instant + offsetSeconds * 1000 };
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
   * With a zone id and no offset, the zone rules apply as in Neo4j
   * (v2.5.3): a wall time inside a DST gap moves later by the gap, an
   * ambiguous one takes the earlier offset, and historical (local mean
   * time) offsets are honoured for any year.
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

    const [, ey, emo, ed, by, bmo, bd, h, mi, s, frac, offset, zoneId] = m;
    let year = Number(ey ?? by);
    let month = Number(emo ?? bmo);
    let day = Number(ed ?? bd);
    let hour = Number(h ?? 0);
    let minute = Number(mi ?? 0);
    let second = Number(s ?? 0);
    const nanosecond = frac ? Number(frac.padEnd(9, '0')) : 0;

    let offsetSeconds = 0;
    if (offset !== undefined) offsetSeconds = parseOffsetSeconds(offset);
    else if (zoneId !== undefined) {
      const resolved = resolveZoned(
        zoneId,
        utcMs(year, month, day, hour, minute, second),
      );
      offsetSeconds = resolved.offsetSeconds;
      const w = new Date(resolved.wallMs);
      year = w.getUTCFullYear();
      month = w.getUTCMonth() + 1;
      day = w.getUTCDate();
      hour = w.getUTCHours();
      minute = w.getUTCMinutes();
      second = w.getUTCSeconds();
    }

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
