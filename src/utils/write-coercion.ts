import { int, isInt } from 'neo4j-driver';
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
 * Where-operator suffixes whose parameter is compared against the field
 * value (`''` = plain equality) and therefore needs the same temporal
 * constructor treatment as writes. String operators (`_CONTAINS`,
 * `_STARTS_WITH`, `_MATCHES`, ...) are excluded — their params are
 * strings by definition.
 */
const TEMPORAL_COMPARABLE_SUFFIXES = new Set([
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
 * the field's temporal Cypher constructor, so ISO-string inputs are
 * stored as native temporal properties instead of Strings. Reads convert
 * native temporals → ISO strings (ResultMapper), so this is the write
 * half of the same round-trip symmetry issue #5 fixed for integers.
 *
 * Only string values are wrapped — a driver temporal object already
 * packs natively and binds raw. Temporal LIST fields wrap element-wise
 * via a list comprehension when any element is a string.
 */
export function wrapTemporalWriteExpr(
  expr: string,
  value: unknown,
  propDef: PropertyDefinition | undefined,
): string {
  if (propDef === undefined) return expr;
  const ctor = TEMPORAL_CONSTRUCTORS[propDef.type];
  if (ctor === undefined) return expr;
  if (propDef.isArray) {
    if (!Array.isArray(value) || !value.some((el) => typeof el === 'string'))
      return expr;
    return `[wc_t IN ${expr} | ${ctor}(wc_t)]`;
  }
  if (typeof value !== 'string') return expr;
  return `${ctor}(${expr})`;
}

/**
 * Temporal wrapping for UNWIND item references (`item.prop`,
 * `connItem.edge.prop`), where ONE Cypher expression serves EVERY item in
 * the batch: the wrap decision must hold for all items' values for the
 * key. A mixed string/non-string column throws — a single expression
 * cannot be correct for both representations.
 */
export function wrapTemporalListItemExpr(
  expr: string,
  values: unknown[],
  propDef: PropertyDefinition | undefined,
): string {
  if (propDef === undefined) return expr;
  const ctor = TEMPORAL_CONSTRUCTORS[propDef.type];
  if (ctor === undefined) return expr;
  const defined = values.filter((v) => v !== null && v !== undefined);
  if (defined.length === 0) return expr;
  if (propDef.isArray) {
    const anyString = defined.some(
      (v) => Array.isArray(v) && v.some((el) => typeof el === 'string'),
    );
    return anyString ? `[wc_t IN ${expr} | ${ctor}(wc_t)]` : expr;
  }
  const stringCount = defined.filter((v) => typeof v === 'string').length;
  if (stringCount === 0) return expr;
  if (stringCount !== defined.length)
    throw new OGMError(
      `Mixed input types for ${propDef.type} field "${propDef.name}": some items pass ISO ` +
        `strings, others pass non-string values. Batched writes share one Cypher expression ` +
        `per field, so every item must use the same representation.`,
    );
  return `${ctor}(${expr})`;
}

/**
 * Wrap a WHERE parameter reference for a temporal field. With properties
 * stored as native temporals, comparing them to a raw string param is a
 * cross-type comparison — Neo4j evaluates it to NULL and silently drops
 * the row. `suffix` is the operator suffix (`''` for plain equality);
 * only comparison-shaped operators wrap, and `_IN`/`_NOT_IN` wrap their
 * list param element-wise.
 */
export function wrapTemporalWhereParam(
  paramRef: string,
  value: unknown,
  propDef: PropertyDefinition | undefined,
  suffix: string,
): string {
  if (propDef === undefined) return paramRef;
  const ctor = TEMPORAL_CONSTRUCTORS[propDef.type];
  if (ctor === undefined) return paramRef;
  if (!TEMPORAL_COMPARABLE_SUFFIXES.has(suffix)) return paramRef;
  if (suffix === '_IN' || suffix === '_NOT_IN') {
    if (!Array.isArray(value) || !value.some((el) => typeof el === 'string'))
      return paramRef;
    return `[wc_t IN ${paramRef} | ${ctor}(wc_t)]`;
  }
  if (typeof value !== 'string') return paramRef;
  return `${ctor}(${paramRef})`;
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
