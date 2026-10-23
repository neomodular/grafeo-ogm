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

/**
 * v2.16.0 — the grammar of Neo4j 5's `datetime(string)`, checked against
 * 5.26. Besides the calendar date (`2024-01-01`, `20240101`) it takes a
 * year alone, a year and month (`2024-01`, `202401`), a week date
 * (`2024-W01-1`, `2024W011`, `2024-W01`), a quarter date (`2024-Q1-01`,
 * `2024Q101`) and an ordinal date (`2024-001`, `2024001`); in the
 * extended format the month, day, week, day of quarter, hour, minute and
 * second may have one digit (`2024-1-1T1:2:3`). A signed year
 * (`+12345`, `-0001`) takes only the extended format, an unsigned one
 * exactly four digits. The time is either all extended (`10:00:00`) or
 * all basic (`100000`), the fraction has at most nine digits, and the
 * separator is `T` (never a space). Nothing may surround the string.
 */
const NEO4J_DATE_TIME = new RegExp(
  '^(?:' +
    // Four-digit year: extended or basic suffix.
    '(?<y4>\\d{4})(?:-(?:' +
    '(?<exMonth>\\d{1,2})-(?<exDay>\\d{1,2})|(?<exMonthOnly>\\d{2})' +
    '|W(?<exWeek>\\d{1,2})(?:-(?<exWeekDay>\\d))?' +
    '|Q(?<exQuarter>\\d)(?:-(?<exQuarterDay>\\d{1,2}))?' +
    '|(?<exOrdinal>\\d{3}))' +
    '|(?<bMonth>\\d{2})(?<bDay>\\d{2})?' +
    '|W(?<bWeek>\\d{2})(?<bWeekDay>\\d)?' +
    '|Q(?<bQuarter>\\d)(?<bQuarterDay>\\d{2})?' +
    '|(?<bOrdinal>\\d{3}))?' +
    // Signed year: extended suffix only.
    '|(?<ySigned>[+-]\\d{1,9})(?:-(?:' +
    '(?<sMonth>\\d{1,2})-(?<sDay>\\d{1,2})|(?<sMonthOnly>\\d{2})' +
    '|W(?<sWeek>\\d{1,2})(?:-(?<sWeekDay>\\d))?' +
    '|Q(?<sQuarter>\\d)(?:-(?<sQuarterDay>\\d{1,2}))?' +
    '|(?<sOrdinal>\\d{3})))?' +
    ')' +
    '(?:T(?:' +
    '(?<h>\\d{1,2})(?::(?<mi>\\d{1,2})(?::(?<s>\\d{1,2})(?:[.,](?<frac>\\d{1,9}))?)?)?' +
    '|(?<bh>\\d{2})(?:(?<bmi>\\d{2})(?:(?<bs>\\d{2})(?:[.,](?<bfrac>\\d{1,9}))?)?)?' +
    '))?' +
    '(?<offset>Z|[+-]\\d{2}(?::?\\d{2})?)?' +
    '(?:\\[(?<zone>[^\\]]+)\\])?$',
  'i',
);

/** The fields of a date-time string, before any zone rule is applied. */
interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  /** `T`, or a space (accepted by the 2.x default only). */
  sep?: string;
  h?: string;
  mi?: string;
  s?: string;
  frac?: string;
  offsetText?: string;
  zoneText?: string;
}

/** Days from 1970-01-01 to a proleptic Gregorian date (any year). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5);
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe + day - 1 - 719468;
}

/** The proleptic Gregorian date `days` after 1970-01-01. */
function civilFromDays(days: number): {
  year: number;
  month: number;
  day: number;
} {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36524) -
      Math.floor(doe / 146096)) /
      365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** ISO day of week (Monday 1 … Sunday 7) of a day count from 1970-01-01. */
function isoWeekday(days: number): number {
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

/** Number of ISO weeks (52 or 53) in a week-based year. */
function isoWeeksInYear(year: number): number {
  const jan1 = isoWeekday(daysFromCivil(year, 1, 1));
  return jan1 === 4 || (jan1 === 3 && isLeapYear(year)) ? 53 : 52;
}

/**
 * Parse `iso` with Neo4j's grammar (v2.16.0). Returns undefined when Neo4j
 * cannot parse the text, and throws a TypeError for a week, quarter,
 * ordinal or calendar field out of range (as Neo4j rejects it). A day past
 * the end of its month (`2024-02-30`) is left to the caller.
 */
function parseNeo4jDateTime(iso: string): DateTimeParts | undefined {
  const g = NEO4J_DATE_TIME.exec(iso)?.groups;
  if (!g) return undefined;
  const fail = (what: string) =>
    new TypeError(`Neo4jRecordFactory.dateTime: '${iso}' — invalid ${what}`);
  const num = (...vals: Array<string | undefined>) => {
    const v = vals.find((x) => x !== undefined);
    return v === undefined ? undefined : Number(v);
  };

  const year = Number(g.y4 ?? g.ySigned);
  let month = 1;
  let day = 1;
  const week = num(g.exWeek, g.bWeek, g.sWeek);
  const quarter = num(g.exQuarter, g.bQuarter, g.sQuarter);
  const ordinal = num(g.exOrdinal, g.bOrdinal, g.sOrdinal);
  if (week !== undefined) {
    const weekDay = num(g.exWeekDay, g.bWeekDay, g.sWeekDay) ?? 1;
    if (week < 1 || week > isoWeeksInYear(year)) throw fail('week');
    if (weekDay < 1 || weekDay > 7) throw fail('day of week');
    // Week 1 is the week with the year's first Thursday (and so Jan 4).
    const jan4 = daysFromCivil(year, 1, 4);
    const monday1 = jan4 - (isoWeekday(jan4) - 1);
    // The date may fall in the previous or next calendar year.
    const date = civilFromDays(monday1 + (week - 1) * 7 + weekDay - 1);
    ({ month, day } = date);
    return finish(date.year);
  } else if (quarter !== undefined) {
    const quarterDay = num(g.exQuarterDay, g.bQuarterDay, g.sQuarterDay) ?? 1;
    if (quarter < 1 || quarter > 4) throw fail('quarter');
    const start = daysFromCivil(year, quarter * 3 - 2, 1);
    const end =
      quarter === 4
        ? daysFromCivil(year + 1, 1, 1)
        : daysFromCivil(year, quarter * 3 + 1, 1);
    if (quarterDay < 1 || quarterDay > end - start)
      throw fail('day of quarter');
    ({ month, day } = civilFromDays(start + quarterDay - 1));
  } else if (ordinal !== undefined) {
    if (ordinal < 1 || ordinal > (isLeapYear(year) ? 366 : 365))
      throw fail('day of year');
    ({ month, day } = civilFromDays(daysFromCivil(year, 1, 1) + ordinal - 1));
  } else {
    month =
      num(g.exMonth, g.exMonthOnly, g.bMonth, g.sMonth, g.sMonthOnly) ?? 1;
    day = num(g.exDay, g.bDay, g.sDay) ?? 1;
    if (month < 1 || month > 12) throw fail('month');
    if (day < 1 || day > 31) throw fail('day');
  }
  return finish(year);

  function finish(y: number): DateTimeParts {
    const timed = g!.h !== undefined || g!.bh !== undefined;
    return {
      year: y,
      month,
      day,
      sep: timed ? 'T' : undefined,
      h: g!.h ?? g!.bh,
      mi: g!.mi ?? g!.bmi,
      s: g!.s ?? g!.bs,
      frac: g!.frac ?? g!.bfrac,
      offsetText: g!.offset,
      zoneText: g!.zone,
    };
  }
}

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
  // v2.16.0
  GRAFEO_RECORD_FACTORY_INVALID_DATE:
    'names a day its month does not have (such as February 30); Neo4j rejects it, the factory accepts it',
  GRAFEO_RECORD_FACTORY_UNPARSEABLE:
    'is text Neo4j cannot parse as a date-time (a space before the time, surrounding whitespace, more than nine fractional digits, a time mixing `10:00` and `0000`, an unsigned year of five or more digits, or a non-ISO format); Neo4j rejects it, the factory accepts it',
  GRAFEO_RECORD_FACTORY_READ_DIFFERS:
    'is a signed year in the basic format, which Neo4j reads as all year (`+20240101` is the year 20240101); the factory reads a date from it',
  GRAFEO_RECORD_FACTORY_LEGACY_PARSE:
    'is a form Neo4j reads (an ordinal or year-month date, or a one-digit month or day) that the factory still parses with `Date`, as before v2.5.0, which can give another value than Neo4j (the machine zone, another year)',
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
   * v2.16.0 — every form Neo4j reads is read the same way: week dates
   * (`2024-W01-1`), quarter dates (`2024-Q1-01`), ordinal dates
   * (`2024-001`), year-month (`202401`) and one-digit fields
   * (`2024-1-1T1:2:3`). Under `{ strict: true }` the string goes through
   * Neo4j's grammar only, so a day its month lacks (`2024-02-30`), a space
   * before the time, surrounding whitespace, a tenth fractional digit or a
   * non-ISO format throws, as on the server. The default keeps the value
   * such a string had in v2.15.0 and warns once
   * (`GRAFEO_RECORD_FACTORY_INVALID_DATE`, `_UNPARSEABLE`, `_READ_DIFFERS`,
   * `_LEGACY_PARSE`).
   *
   * Before v2.4.8 the value was converted to UTC with the offset dropped
   * and the fraction cut to milliseconds; before v2.5.0 an offset-less
   * string was read in the machine's local zone.
   */
  static dateTime(
    isoString: string,
    options: DateTimeFactoryOptions = {},
  ): unknown {
    // v2.16.0 — strict reads the string with Neo4j's own grammar and throws
    // for text Neo4j cannot parse (it used to fall back to `Date`, and to
    // accept a space before the time). The default keeps its v2.15.0
    // reading of every string that did not throw, and warns where Neo4j
    // differs; a Neo4j form that used to throw (a week or quarter date, a
    // one-digit hour) is read as Neo4j reads it.
    let parts: DateTimeParts | undefined;
    let newForm = false;
    if (options.strict === true) {
      parts = parseNeo4jDateTime(isoString);
      if (!parts)
        throw new TypeError(
          `Neo4jRecordFactory.dateTime: '${isoString}' is not an ISO-8601 date-time`,
        );
    } else {
      const m = ISO_DATE_TIME.exec(isoString.trim());
      if (m) {
        const [, ey, emo, ed, by, bmo, bd, sep, h, mi, s, frac, off, zone] = m;
        parts = {
          year: Number(ey ?? by),
          month: Number(emo ?? bmo),
          day: Number(ed ?? bd),
          sep,
          h,
          mi,
          s,
          frac,
          offsetText: off,
          zoneText: zone,
        };
      } else {
        const legacyOk = !Number.isNaN(new Date(isoString).getTime());
        let neo: DateTimeParts | undefined;
        try {
          neo = parseNeo4jDateTime(isoString);
        } catch (e) {
          // A Neo4j form with a field out of range: it threw before too
          // unless `Date` took it.
          if (!legacyOk) throw e;
          neo = undefined;
        }
        if (neo !== undefined && !legacyOk) {
          parts = neo;
          newForm = true;
        } else {
          // A string `Date` understands (e.g. RFC 2822) keeps the
          // pre-v2.5.0 parse.
          if (legacyOk)
            warnDateTime(
              neo !== undefined
                ? 'GRAFEO_RECORD_FACTORY_LEGACY_PARSE'
                : 'GRAFEO_RECORD_FACTORY_UNPARSEABLE',
              isoString,
            );
          return Neo4jRecordFactory.legacyDateTime(isoString);
        }
      }
    }

    const { sep, h, mi, s, frac, offsetText, zoneText } = parts;
    let { year, month, day } = parts;
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
    // v2.16.0 — a Neo4j form that threw before (`newForm`) has no earlier
    // value to keep either.
    const strict = options.strict === true || newlyAccepted || newForm;
    // In the 2.x default, each check below keeps the v2.8.0 value and warns
    // once; `strict: true` throws, as Neo4j rejects the string.
    const reject = (
      code: DateTimeDeprecation,
      error: () => TypeError,
    ): void => {
      if (strict) throw error();
      warnDateTime(code, isoString);
    };

    // v2.16.0 — text the default accepts but Neo4j cannot parse (a space
    // before the time, surrounding whitespace, a time mixing `10:00` and
    // `0000`, an unsigned five-digit year), or reads as another date (a
    // signed basic year, `+20240101`, is all year to Neo4j). Strict already
    // threw above or used Neo4j's reading.
    if (options.strict !== true && !newForm) {
      let neo: DateTimeParts | undefined | 'rejected';
      try {
        neo = parseNeo4jDateTime(isoString);
      } catch {
        // Neo4j parses it but rejects a field; the checks below or the
        // driver's own range checks handle it as before.
        neo = 'rejected';
      }
      if (neo === undefined)
        warnDateTime('GRAFEO_RECORD_FACTORY_UNPARSEABLE', isoString);
      else if (
        neo !== 'rejected' &&
        (neo.year !== year || neo.month !== month || neo.day !== day)
      )
        warnDateTime('GRAFEO_RECORD_FACTORY_READ_DIFFERS', isoString);
    }

    // v2.16.0 — a day past the end of its month (`2024-02-30`, `2023-02-29`,
    // `2024-04-31`) is rejected by Neo4j ("Invalid date"). The default keeps
    // the v2.15.0 value (a DateTime with that day), as before — also for
    // the v2.9.0 forms (`[Z]`, an hour alone) that otherwise read strictly.
    if (
      month >= 1 &&
      month <= 12 &&
      day <= 31 &&
      day > daysInMonth(year, month)
    ) {
      if (options.strict === true || newForm)
        throw new TypeError(
          `Neo4jRecordFactory.dateTime: '${isoString}' — invalid date: month ${month} of ${year} has ${daysInMonth(year, month)} days`,
        );
      warnDateTime('GRAFEO_RECORD_FACTORY_INVALID_DATE', isoString);
    }

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
