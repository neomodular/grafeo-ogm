import neo4j, { Integer, Record as Neo4jRecord } from 'neo4j-driver';
import { canonicalZoneId, NEO4J_REJECTED_ZONE_IDS } from './zone-ids';

/**
 * ISO-8601 date-time as Neo4j's `datetime()` accepts it: a date, an
 * optional time with up to nine fractional digits, an optional offset
 * (`Z`, `±HH`, `±HHMM`, `±HH:MM`) and an optional `[Area/City]` zone id.
 *
 * v2.5.3 — the basic format (`20240101T100000Z`, no separators) is
 * accepted too, as Neo4j accepts it.
 *
 * v2.9.0 — the minutes are optional (`2024-01-01T10+01:00`), as in Neo4j;
 * such a string used to throw.
 */
const ISO_DATE_TIME =
  /^(?:([+-]?\d{4,})-(\d{2})-(\d{2})|([+-]?\d{4})(\d{2})(\d{2}))(?:([T ])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?(?:\[([^\]]+)\])?$/i;

/** Largest offset java.time (and so Neo4j) allows: ±18:00. */
const MAX_OFFSET_SECONDS = 18 * 3600;

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

/** Whether Neo4j accepts `offset`: within ±18:00, minutes at most 59. */
function offsetInRange(offset: string): boolean {
  if (offset.toUpperCase() === 'Z') return true;
  const digits = offset.slice(1).replace(':', '');
  const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
  return (
    minutes <= 59 && Math.abs(parseOffsetSeconds(offset)) <= MAX_OFFSET_SECONDS
  );
}

/** Options for {@link Neo4jRecordFactory.dateTime}. */
export interface DateTimeFactoryOptions {
  /**
   * v2.9.0 — build exactly what the driver returns for `datetime(iso)`,
   * and throw where Neo4j rejects the string. Off by default in 2.x (the
   * v2.8.0 value is kept, with a one-time `DeprecationWarning`); the
   * default in 3.0.
   */
  strict?: boolean;
}

/**
 * v2.9.0 — inputs whose 2.x default value differs from what Neo4j does.
 * Each warns once per process (`process.emitWarning`, type
 * `DeprecationWarning`) unless `strict: true` is passed.
 */
const DATE_TIME_DEPRECATIONS = {
  GRAFEO_RECORD_FACTORY_ZONE_OFFSET_MISMATCH:
    'has an offset its zone id does not have at that wall time; Neo4j rejects it ("Timezone and offset do not match"), the factory keeps both as written',
  GRAFEO_RECORD_FACTORY_ZONE_ID_CASE:
    'has a zone id not spelled as Neo4j spells it; Neo4j matches it case-insensitively and returns its own spelling, the factory keeps it as written',
  GRAFEO_RECORD_FACTORY_ZONE_ID_UNSUPPORTED:
    'has a zone id Neo4j rejects (java.time lacks it), the factory accepts it',
  GRAFEO_RECORD_FACTORY_OFFSET_RANGE:
    'has an offset outside -18:00..+18:00 or with minutes over 59; Neo4j rejects it, the factory accepts it',
  GRAFEO_RECORD_FACTORY_DATE_ONLY_ZONE:
    'is a date with an offset or zone but no time; Neo4j rejects it, the factory reads it as midnight',
} as const;
type DateTimeDeprecation = keyof typeof DATE_TIME_DEPRECATIONS;

const warnedDateTimeCodes = new Set<DateTimeDeprecation>();

function warnDateTime(code: DateTimeDeprecation, isoString: string): void {
  if (warnedDateTimeCodes.has(code)) return;
  warnedDateTimeCodes.add(code);
  process.emitWarning(
    `Neo4jRecordFactory.dateTime: '${isoString}' ${DATE_TIME_DEPRECATIONS[code]}. ` +
      'Pass { strict: true } (default in 3.0) to match the driver.',
    { type: 'DeprecationWarning', code },
  );
}

/**
 * Forget which `dateTime` deprecation warnings were emitted. Internal, for
 * tests; not exported from `grafeo-ogm/testing`.
 */
export function resetDateTimeWarnings(): void {
  warnedDateTimeCodes.clear();
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
 * The offsets `timeZone` may have around a wall-clock time (`candidates`)
 * and those the wall time really has (`valid`): one normally, two in a DST
 * overlap, none in a gap.
 */
function zoneOffsetsAtWall(
  timeZone: string,
  wallMs: number,
): { candidates: number[]; valid: number[] } {
  const DAY = 86_400_000;
  const first = zoneOffsetAt(timeZone, wallMs);
  const candidates = [
    ...new Set<number>([
      zoneOffsetAt(timeZone, wallMs - DAY),
      zoneOffsetAt(timeZone, wallMs + DAY),
      first,
      zoneOffsetAt(timeZone, wallMs - first * 1000),
    ]),
  ];
  const valid = candidates.filter(
    (o) => zoneOffsetAt(timeZone, wallMs - o * 1000) === o,
  );
  return { candidates, valid };
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
  const { candidates, valid } = zoneOffsetsAtWall(timeZone, wallMs);
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
   * v2.9.0 — `[Z]` means offset 0 with no zone id, and an hour without
   * minutes (`10+01:00`) is read; both used to throw.
   *
   * v2.9.0 — `{ strict: true }` (the default in 3.0) also matches Neo4j
   * where the 2.x default does not: it throws for strings Neo4j rejects
   * (an offset the zone does not have at that wall time, such as
   * `10:00+05:00[Europe/Madrid]` or any offset in a DST gap; an offset
   * outside ±18:00; a zone id java.time lacks, such as `EST`; a bare date
   * with an offset or zone), and spells a zone id as Neo4j does
   * (`[us/eastern]` → `US/Eastern`). Without it those strings keep their
   * v2.8.0 value and emit a one-time `DeprecationWarning`.
   *
   * Before v2.4.8 the value was converted to UTC with the offset dropped
   * and the fraction cut to milliseconds; before v2.5.0 an offset-less
   * string was read in the machine's local zone.
   */
  static dateTime(
    isoString: string,
    options: DateTimeFactoryOptions = {},
  ): unknown {
    const m = ISO_DATE_TIME.exec(isoString.trim());
    // A non-ISO string `Date` understands (e.g. RFC 2822) keeps the
    // pre-v2.5.0 parse.
    if (!m) return Neo4jRecordFactory.legacyDateTime(isoString);

    const [
      ,
      ey,
      emo,
      ed,
      by,
      bmo,
      bd,
      sep,
      h,
      mi,
      s,
      frac,
      offsetText,
      zoneText,
    ] = m;
    let year = Number(ey ?? by);
    let month = Number(emo ?? bmo);
    let day = Number(ed ?? bd);
    let hour = Number(h ?? 0);
    let minute = Number(mi ?? 0);
    let second = Number(s ?? 0);
    const nanosecond = frac ? Number(frac.padEnd(9, '0')) : 0;

    const isZ = zoneText?.toUpperCase() === 'Z';
    // v2.9.0 — `[Z]` and an hour without minutes threw before v2.9.0, so
    // there is no earlier value to keep: they always get the strict
    // reading. Neo4j rejects a space before the time (which the default
    // still accepts in a full time, as before), so those keep throwing.
    const newlyAccepted = isZ || (h !== undefined && mi === undefined);
    if (newlyAccepted && sep === ' ')
      throw new TypeError(
        `Neo4jRecordFactory.dateTime: '${isoString}' is not an ISO-8601 date-time`,
      );
    const strict = options.strict === true || newlyAccepted;
    // In the 2.x default, each check below keeps the v2.8.0 value and warns
    // once; `strict: true` throws, as Neo4j rejects the string.
    const reject = (
      code: DateTimeDeprecation,
      error: () => TypeError,
    ): void => {
      if (strict) throw error();
      warnDateTime(code, isoString);
    };

    // v2.9.0 — a date with an offset or zone but no time
    // (`2024-01-01Z`, `2024-01-01[Europe/Berlin]`) is rejected by Neo4j.
    // With `[Z]` it threw before v2.9.0 too.
    if (h === undefined && (offsetText ?? zoneText) !== undefined) {
      const error = () =>
        new TypeError(
          `Neo4jRecordFactory.dateTime: '${isoString}' is not an ISO-8601 date-time`,
        );
      if (isZ) throw error();
      reject('GRAFEO_RECORD_FACTORY_DATE_ONLY_ZONE', error);
    }

    // v2.9.0 — an offset outside ±18:00 or with minutes over 59 is
    // rejected by Neo4j (`+05:75` used to become +06:15).
    if (offsetText !== undefined && !offsetInRange(offsetText))
      reject(
        'GRAFEO_RECORD_FACTORY_OFFSET_RANGE',
        () =>
          new TypeError(
            `Neo4jRecordFactory.dateTime: '${isoString}' has a zone offset outside -18:00 to +18:00`,
          ),
      );

    // v2.9.0 — `[Z]` is Neo4j's spelling of offset 0 with no zone id
    // (`10:00[Z]` returns `10:00Z`). Before v2.9.0 it threw ("Invalid time
    // zone"), so this applies in both modes.
    let offset: string | undefined = offsetText;
    let zoneId: string | undefined = zoneText;
    if (isZ) {
      zoneId = undefined;
      if (offset === undefined) offset = 'Z';
      else if (parseOffsetSeconds(offset) !== 0)
        throw Neo4jRecordFactory.zoneMismatch(isoString);
    }
    if (zoneId !== undefined) {
      // v2.9.0 — ids `Intl` knows but Neo4j does not (`EST`, an offset
      // such as `[+05:00]`) are rejected by Neo4j.
      const id = zoneId;
      if (NEO4J_REJECTED_ZONE_IDS.has(id.toUpperCase()) || /^[+-]/.test(id))
        reject(
          'GRAFEO_RECORD_FACTORY_ZONE_ID_UNSUPPORTED',
          () =>
            new TypeError(
              `Neo4jRecordFactory.dateTime: '${isoString}' has a zone id Neo4j does not accept: '${id}'`,
            ),
        );
      // v2.9.0 — Neo4j returns the id in its own spelling
      // (`[europe/madrid]` → `Europe/Madrid`).
      const canonical = canonicalZoneId(id);
      if (canonical !== undefined && canonical !== id)
        if (strict) zoneId = canonical;
        else warnDateTime('GRAFEO_RECORD_FACTORY_ZONE_ID_CASE', isoString);
    }

    let offsetSeconds = 0;
    if (offset !== undefined) {
      offsetSeconds = parseOffsetSeconds(offset);
      // v2.9.0 — with both an offset and a zone id, Neo4j requires the
      // offset to be one the zone has at that wall time (either one in a
      // DST overlap, none in a gap) and rejects the string otherwise. The
      // default pairs any offset with any zone, as before
      // (`10:00Z[Europe/Madrid]` in July), a value no server returns.
      if (zoneId !== undefined) {
        let matches: boolean;
        try {
          matches = zoneOffsetsAtWall(
            zoneId,
            utcMs(year, month, day, hour, minute, second),
          ).valid.includes(offsetSeconds);
        } catch (e) {
          // A zone `Intl` does not know: Neo4j rejects it; the default
          // keeps the pre-v2.9.0 value without warning about it.
          if (strict) throw e;
          matches = true;
        }
        if (!matches)
          reject('GRAFEO_RECORD_FACTORY_ZONE_OFFSET_MISMATCH', () =>
            Neo4jRecordFactory.zoneMismatch(isoString),
          );
      }
    } else if (zoneId !== undefined) {
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

  private static zoneMismatch(isoString: string): TypeError {
    return new TypeError(
      `Neo4jRecordFactory.dateTime: '${isoString}' — timezone and offset do not match`,
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
