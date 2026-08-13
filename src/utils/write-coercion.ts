import { int, isInt, isPoint } from 'neo4j-driver';
import { OGMError } from '../errors';
import type { PropertyDefinition } from '../schema/types';

/**
 * GraphQL scalar types whose Neo4j storage type is INTEGER (Long).
 */
const INTEGER_SCALAR_TYPES = new Set(['Int', 'BigInt']);

/**
 * Temporal scalar types → the Cypher constructor that parses their ISO
 * string form into the native Neo4j temporal type. Writes wrap the
 * *parameter* in the constructor instead of converting the value in JS,
 * because Neo4j's own parsers handle everything JS `Date` cannot:
 * nanosecond precision, bracket timezone names
 * (`2024-01-15T10:30:00[America/New_York]`), and ISO-8601 durations.
 */
const TEMPORAL_CONSTRUCTORS: Record<string, string> = {
  DateTime: 'datetime',
  LocalDateTime: 'localdatetime',
  Date: 'date',
  Time: 'time',
  LocalTime: 'localtime',
  Duration: 'duration',
};

/**
 * Spatial scalar types → Cypher's `point()` constructor. Reads flatten a
 * native Point into a plain `{ x, y[, z], srid }` object (ResultMapper),
 * and `point()` accepts exactly that map back — `srid` key included — so
 * wrapping makes the read → write round-trip exact. Without the wrapper
 * the plain object is bound as a map property value, which Neo4j rejects
 * at runtime ("Property values can only be of primitive types...").
 */
const POINT_SCALAR_TYPES = new Set(['Point', 'CartesianPoint']);

/**
 * Where-operator suffixes whose parameter is compared against the field
 * value (`''` = plain equality) and therefore needs the same constructor
 * treatment as writes. String operators (`_CONTAINS`, `_STARTS_WITH`,
 * `_MATCHES`, ...) are excluded — their params are strings by definition.
 */
const COMPARABLE_SUFFIXES = new Set([
  '',
  '_NOT',
  '_GT',
  '_GTE',
  '_LT',
  '_LTE',
  '_IN',
  '_NOT_IN',
]);

/**
 * A Cypher constructor that turns a plain JS input into the native Neo4j
 * value the schema declares for a field.
 */
interface WriteConstructor {
  /** Cypher function name (`datetime`, `point`, ...). */
  fn: string;
  /** Whether a JS value is constructor INPUT (vs already driver-native). */
  wraps(value: unknown): boolean;
  /**
   * Element rule for lists. Temporal constructors accept already-native
   * temporal values (`datetime(datetime)` is legal Cypher), so a mixed
   * list can be wrapped wholesale (`'any'`). `point()` REJECTS a POINT
   * argument, so a mixed list has no single correct expression —
   * `'all'` wraps only uniform lists and throws on a mix.
   */
  arrayMode: 'any' | 'all';
}

function isTemporalStringInput(value: unknown): boolean {
  return typeof value === 'string';
}

/**
 * A plain object shaped like `point()` input: cartesian (`x`/`y`) or
 * geographic (`longitude`/`latitude`), optionally with `z`/`height` and
 * `srid`/`crs`. Driver Point instances are NOT inputs — they pack
 * natively and `point()` would reject them.
 */
function isPointWriteInput(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  if (isPoint(value) || isInt(value)) return false;
  const candidate = value as Record<string, unknown>;
  const cartesian =
    typeof candidate.x === 'number' && typeof candidate.y === 'number';
  const geographic =
    typeof candidate.longitude === 'number' &&
    typeof candidate.latitude === 'number';
  return cartesian || geographic;
}

function resolveWriteConstructor(
  propDef: PropertyDefinition,
): WriteConstructor | undefined {
  const temporal = TEMPORAL_CONSTRUCTORS[propDef.type];
  if (temporal !== undefined)
    return { fn: temporal, wraps: isTemporalStringInput, arrayMode: 'any' };
  if (POINT_SCALAR_TYPES.has(propDef.type))
    return { fn: 'point', wraps: isPointWriteInput, arrayMode: 'all' };
  return undefined;
}

/**
 * Decide whether a list of element values should be wrapped element-wise.
 * `'any'` mode wraps as soon as one element is constructor input; `'all'`
 * mode requires uniformity and throws on a mix, because the constructor
 * cannot be applied to the already-native elements.
 */
function decideElementsWrap(
  elements: unknown[],
  ctor: WriteConstructor,
  propDef: PropertyDefinition,
): boolean {
  const defined = elements.filter((el) => el !== null && el !== undefined);
  if (defined.length === 0) return false;
  const matches = defined.filter((el) => ctor.wraps(el)).length;
  if (matches === 0) return false;
  if (ctor.arrayMode === 'any') return true;
  if (matches !== defined.length)
    throw new OGMError(
      `Mixed input representations for ${propDef.type} field "${propDef.name}": ` +
        `some values are plain ${ctor.fn}() inputs, others are driver-native values. ` +
        `${ctor.fn}() cannot be applied to an already-native value, so every value ` +
        `must use the same representation.`,
    );
  return true;
}

/**
 * Coerce a JS write value bound for an `Int`/`BigInt`-typed schema field
 * into a Neo4j Integer so the stored property is a Long, not a Double.
 *
 * The driver packs EVERY JS `number` as a Bolt FLOAT64 (packstream:
 * `typeof x === 'number'` → `packFloat`) — `disableLosslessIntegers`
 * only affects the read direction. Reads convert Integer → number
 * (ResultMapper), so without write-side coercion the round-trip is
 * asymmetric: every OGM-written Int property lands as a Double. Once a
 * field holds a mixed Long/Double population, Long-typed consumers break
 * (e.g. `apoc.coll.sortMulti` throws `java.lang.Double cannot be cast to
 * class java.lang.Long`).
 *
 * Non-integral numbers and non-integer strings for Int/BigInt fields
 * throw instead of truncating or storing a String property, matching the
 * v1.14 contract of rejecting inputs that would be silently corrupted.
 * Values the coercion doesn't own — null/undefined, driver Integer
 * instances, fields of any other scalar type, or fields absent from the
 * schema — pass through untouched.
 */
export function coerceWriteValue(
  value: unknown,
  propDef: PropertyDefinition | undefined,
): unknown {
  if (propDef === undefined || value === null || value === undefined)
    return value;
  if (!INTEGER_SCALAR_TYPES.has(propDef.type)) return value;

  if (propDef.isArray) {
    if (!Array.isArray(value)) return value;
    return value.map((element) => coerceIntegerElement(element, propDef));
  }

  return coerceIntegerElement(value, propDef);
}

function coerceIntegerElement(
  value: unknown,
  propDef: PropertyDefinition,
): unknown {
  if (value === null || value === undefined) return value;
  // `int()` accepts strings in every driver major — `toString()` keeps
  // bigint inputs working regardless of the installed driver's overloads.
  if (typeof value === 'bigint') return int(value.toString());
  if (typeof value === 'number') {
    if (!Number.isInteger(value))
      throw new OGMError(
        `Expected an integer for ${propDef.type} field "${propDef.name}" but got ${value}. ` +
          `Storing it would corrupt the property's integer type; pass a whole number ` +
          `(or declare the field as Float).`,
      );
    return int(value);
  }
  if (typeof value === 'string') {
    // The generated BigInt scalar declares `input: string` (64-bit values
    // don't fit a JS number), so integer strings are the CANONICAL input
    // shape for BigInt fields — binding them raw would store a String
    // property. Same reject-don't-corrupt rule as numbers for anything
    // that isn't a plain base-10 integer literal.
    if (!/^-?\d+$/.test(value))
      throw new OGMError(
        `Expected an integer for ${propDef.type} field "${propDef.name}" but got the string "${value}". ` +
          `Pass a base-10 integer literal string, a whole number, or a bigint.`,
      );
    return int(value);
  }
  // Already a driver Integer — pass through unchanged.
  if (isInt(value)) return value;
  return value;
}

/**
 * Wrap a write RHS expression (`$param`, or an UNWIND item reference) in
 * the field's Cypher constructor — temporal (`datetime()`, ...) for
 * ISO-string inputs, `point()` for plain point maps — so the stored
 * property is the native type the schema declares. Reads convert native
 * values to plain JS (ResultMapper); this is the write half of the same
 * round-trip symmetry issue #5 fixed for integers.
 *
 * Driver-native values (temporal instances, Point instances) bind raw.
 * List fields wrap element-wise via a list comprehension, following the
 * constructor's element rule (see WriteConstructor.arrayMode).
 */
export function wrapWriteExpr(
  expr: string,
  value: unknown,
  propDef: PropertyDefinition | undefined,
): string {
  if (propDef === undefined) return expr;
  const ctor = resolveWriteConstructor(propDef);
  if (ctor === undefined) return expr;
  if (propDef.isArray) {
    if (!Array.isArray(value)) return expr;
    if (!decideElementsWrap(value, ctor, propDef)) return expr;
    return `[wc_t IN ${expr} | ${ctor.fn}(wc_t)]`;
  }
  if (!ctor.wraps(value)) return expr;
  return `${ctor.fn}(${expr})`;
}

/**
 * Constructor wrapping for UNWIND item references (`item.prop`,
 * `connItem.edge.prop`), where ONE Cypher expression serves EVERY item in
 * the batch: the wrap decision must hold for all items' values for the
 * key. A column mixing constructor inputs with driver-native values
 * throws — a single expression cannot be correct for both.
 */
export function wrapListItemExpr(
  expr: string,
  values: unknown[],
  propDef: PropertyDefinition | undefined,
): string {
  if (propDef === undefined) return expr;
  const ctor = resolveWriteConstructor(propDef);
  if (ctor === undefined) return expr;
  if (propDef.isArray) {
    const flattened = values
      .filter((v): v is unknown[] => Array.isArray(v))
      .flat();
    if (flattened.length === 0) return expr;
    if (!decideElementsWrap(flattened, ctor, propDef)) return expr;
    return `[wc_t IN ${expr} | ${ctor.fn}(wc_t)]`;
  }
  const defined = values.filter((v) => v !== null && v !== undefined);
  if (defined.length === 0) return expr;
  const matches = defined.filter((v) => ctor.wraps(v)).length;
  if (matches === 0) return expr;
  if (matches !== defined.length)
    throw new OGMError(
      `Mixed input types for ${propDef.type} field "${propDef.name}": some items pass ` +
        `plain ${ctor.fn}() inputs, others pass driver-native values. Batched writes ` +
        `share one Cypher expression per field, so every item must use the same ` +
        `representation.`,
    );
  return `${ctor.fn}(${expr})`;
}

/**
 * Wrap a WHERE parameter reference for a constructor-typed field. With
 * properties stored natively, comparing them to a raw string/map param is
 * a cross-type comparison — Neo4j evaluates it to NULL and silently
 * drops the row. `suffix` is the operator suffix (`''` for plain
 * equality); only comparison-shaped operators wrap, and `_IN`/`_NOT_IN`
 * wrap their list param element-wise.
 */
export function wrapWhereParam(
  paramRef: string,
  value: unknown,
  propDef: PropertyDefinition | undefined,
  suffix: string,
): string {
  if (propDef === undefined) return paramRef;
  const ctor = resolveWriteConstructor(propDef);
  if (ctor === undefined) return paramRef;
  if (!COMPARABLE_SUFFIXES.has(suffix)) return paramRef;
  if (suffix === '_IN' || suffix === '_NOT_IN') {
    if (!Array.isArray(value)) return paramRef;
    if (!decideElementsWrap(value, ctor, propDef)) return paramRef;
    return `[wc_t IN ${paramRef} | ${ctor.fn}(wc_t)]`;
  }
  if (!ctor.wraps(value)) return paramRef;
  return `${ctor.fn}(${paramRef})`;
}

/**
 * Materialize a parsed `@default` into a driver-ready bound value. The
 * parser stores every default as a string (`'true'`, `'5'`, `'WELCOME'`);
 * conversion is by declared scalar type, and Int/BigInt defaults route
 * through the same Integer coercion as user input. Temporal defaults stay
 * ISO strings here — they get their constructor wrapper at the binding
 * site like any other temporal write.
 */
export function resolveDefaultWriteValue(propDef: PropertyDefinition): unknown {
  const raw = propDef.defaultValue;
  if (raw === undefined) return undefined;
  switch (propDef.type) {
    case 'Boolean':
      return raw === 'true';
    case 'Float':
      return Number(raw);
    case 'Int':
    case 'BigInt':
      return coerceWriteValue(raw, propDef);
    default:
      return raw;
  }
}
