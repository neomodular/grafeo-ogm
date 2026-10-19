/**
 * Value generators for every scalar kind of `ItPScalars` (rule 6), in the
 * input representations the generated types accept, plus the Cypher
 * expression Neo4j itself uses to build the expected stored value.
 */
import fc from 'fast-check';

type Rec = Record<string, unknown>;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

const yearArb = fc.oneof(
  fc.integer({ min: 1, max: 9999 }),
  fc.constantFrom(1970, 2000, 2024),
);
const dateParts = fc.record({
  y: yearArb,
  m: fc.integer({ min: 1, max: 12 }),
  d: fc.integer({ min: 1, max: 28 }),
});
const timeParts = fc.record({
  h: fc.integer({ min: 0, max: 23 }),
  mi: fc.integer({ min: 0, max: 59 }),
  s: fc.integer({ min: 0, max: 59 }),
  // 0 – 9 fractional digits.
  frac: fc.option(fc.stringMatching(/^[0-9]{1,9}$/), { nil: undefined }),
});
const offsetArb = fc.oneof(
  fc.constant('Z'),
  fc
    .tuple(
      fc.constantFrom('+', '-'),
      fc.integer({ min: 0, max: 14 }),
      fc.constantFrom(0, 30, 45),
    )
    .map(([sg, h, m]) => `${sg}${pad(h)}:${pad(m)}`),
);
const zoneArb = fc.constantFrom(
  'Europe/Berlin',
  'America/New_York',
  'Asia/Kolkata',
  'UTC',
  'Australia/Lord_Howe',
);

const dateStr = dateParts.map(
  ({ y, m, d }) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`,
);
const timeStr = timeParts.map(
  ({ h, mi, s, frac }) =>
    `${pad(h)}:${pad(mi)}:${pad(s)}${frac ? `.${frac}` : ''}`,
);

export const SCALAR_GEN: Record<
  string,
  { arb: fc.Arbitrary<unknown>; cypher: (p: string) => string }
> = {
  // Int beyond 2^31 (stored as a 64-bit Long) and up to 2^53.
  i: {
    arb: fc.oneof(
      fc.integer(),
      fc.constantFrom(
        2 ** 31,
        -(2 ** 31) - 1,
        2 ** 40,
        Number.MAX_SAFE_INTEGER,
        -Number.MAX_SAFE_INTEGER,
      ),
    ),
    cypher: (p) => p,
  },
  // BigInt in all three input forms: string, number, bigint.
  bi: {
    arb: fc.oneof(
      fc
        .bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n })
        .map((b) => b.toString()),
      fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
      fc.integer().map((n) => n),
    ),
    cypher: (p) => p,
  },
  f: { arb: fc.double({ noNaN: true }), cypher: (p) => p },
  b: { arb: fc.boolean(), cypher: (p) => p },
  s: {
    arb: fc.oneof(
      fc.string({ unit: 'grapheme', maxLength: 12 }),
      fc.constantFrom(
        "O'Brien",
        'say "hi"',
        'back\\slash',
        'tab\there',
        'new\nline',
        '🙂👍🏽',
        'ñandú',
        '',
        ' ',
      ),
    ),
    cypher: (p) => p,
  },
  xid: {
    arb: fc.oneof(
      fc.uuid(),
      fc.string({ unit: 'grapheme-ascii', maxLength: 8 }),
    ),
    cypher: (p) => p,
  },
  dt: {
    // An offset OR a zone id (both together are only valid when they agree).
    arb: fc
      .tuple(
        dateStr,
        timeStr,
        fc.oneof(
          offsetArb,
          zoneArb.map((z) => `[${z}]`),
        ),
      )
      .map(([d, t, z]) => `${d}T${t}${z}`),
    cypher: (p) => `datetime(${p})`,
  },
  d: { arb: dateStr, cypher: (p) => `date(${p})` },
  ldt: {
    arb: fc.tuple(dateStr, timeStr).map(([d, t]) => `${d}T${t}`),
    cypher: (p) => `localdatetime(${p})`,
  },
  t: {
    arb: fc.tuple(timeStr, offsetArb).map(([t, o]) => `${t}${o}`),
    cypher: (p) => `time(${p})`,
  },
  lt: { arb: timeStr, cypher: (p) => `localtime(${p})` },
  dur: {
    arb: fc
      .record(
        {
          Y: fc.integer({ min: 0, max: 30 }),
          M: fc.integer({ min: 0, max: 30 }),
          D: fc.integer({ min: 0, max: 400 }),
          H: fc.integer({ min: 0, max: 48 }),
          Mi: fc.integer({ min: 0, max: 90 }),
          S: fc.oneof(
            fc.integer({ min: 0, max: 90 }),
            fc.constantFrom(0.5, 1.000000001),
          ),
        },
        { requiredKeys: [] },
      )
      .map((r) => {
        const date = `${r.Y !== undefined ? `${r.Y}Y` : ''}${r.M !== undefined ? `${r.M}M` : ''}${r.D !== undefined ? `${r.D}D` : ''}`;
        const time = `${r.H !== undefined ? `${r.H}H` : ''}${r.Mi !== undefined ? `${r.Mi}M` : ''}${r.S !== undefined ? `${r.S}S` : ''}`;
        if (!date && !time) return 'PT0S';
        return `P${date}${time ? `T${time}` : ''}`;
      }),
    cypher: (p) => `duration(${p})`,
  },
  p: {
    arb: fc.oneof(
      fc.record({
        longitude: fc.double({ min: -180, max: 180, noNaN: true }),
        latitude: fc.double({ min: -90, max: 90, noNaN: true }),
      }),
      fc.record({
        longitude: fc.double({ min: -180, max: 180, noNaN: true }),
        latitude: fc.double({ min: -90, max: 90, noNaN: true }),
        height: fc.double({ min: -1e4, max: 1e4, noNaN: true }),
      }),
    ),
    cypher: (p) => `point(${p})`,
  },
  cp: {
    arb: fc.oneof(
      fc.record({
        x: fc.double({ noNaN: true, noDefaultInfinity: true }),
        y: fc.double({ noNaN: true, noDefaultInfinity: true }),
      }),
      fc.record({
        x: fc.double({ noNaN: true, noDefaultInfinity: true }),
        y: fc.double({ noNaN: true, noDefaultInfinity: true }),
        z: fc.double({ noNaN: true, noDefaultInfinity: true }),
      }),
    ),
    cypher: (p) => `point(${p})`,
  },
};

export const SCALAR_KEYS = Object.keys(SCALAR_GEN);
/** The list field of each scalar field (`i` → `is`). */
export const LIST_OF: Record<string, string> = {
  i: 'is',
  bi: 'bis',
  f: 'fs',
  b: 'bs',
  s: 'ss',
  xid: 'xids',
  dt: 'dts',
  d: 'ds',
  ldt: 'ldts',
  t: 'ts',
  lt: 'lts',
  dur: 'durs',
  p: 'ps',
  cp: 'cps',
};
const ELEMENT_OF = Object.fromEntries(
  Object.entries(LIST_OF).map(([k, v]) => [v, k]),
);

/** Element field of a list field, or the field itself. */
export const elementField = (field: string) => ELEMENT_OF[field] ?? field;
export const isListField = (field: string) => field in ELEMENT_OF;

/**
 * Point lists must be homogeneous: `point()` cannot mix 2D and 3D, and
 * Neo4j rejects a list mixing CRSs. Generated per list from one shape.
 */
function listArb(field: string): fc.Arbitrary<unknown[]> {
  const el = SCALAR_GEN[field].arb;
  if (field === 'p' || field === 'cp')
    return fc.array(el, { minLength: 1, maxLength: 3 }).map((xs) => {
      const keys = Object.keys(xs[0] as Rec)
        .sort()
        .join();
      return xs.filter(
        (x) =>
          Object.keys(x as Rec)
            .sort()
            .join() === keys,
      );
    });
  if (field === 'bi')
    // One representation per list (strings), so a list never mixes forms.
    return fc.array(
      fc
        .bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n })
        .map((b) => b.toString()),
      {
        minLength: 0,
        maxLength: 3,
      },
    );
  return fc.array(el, { minLength: 0, maxLength: 3 });
}

/** A random subset of scalar and list fields with values. */
export function scalarValues(): fc.Arbitrary<Rec> {
  const entries: Record<string, fc.Arbitrary<unknown>> = {};
  for (const f of SCALAR_KEYS) {
    entries[f] = SCALAR_GEN[f].arb;
    entries[LIST_OF[f]] = listArb(f);
  }
  return fc.record(entries, { requiredKeys: [] });
}

/** Cypher building the value Neo4j itself stores for `field` from `$param`. */
export function expectedExpr(field: string, param: string): string {
  const el = elementField(field);
  const ctor = SCALAR_GEN[el].cypher;
  if (isListField(field)) return `[x IN ${param} | ${ctor('x')}]`;
  return ctor(param);
}
