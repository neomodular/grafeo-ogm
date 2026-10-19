/**
 * v2.7.0 — Cypher expressions for `<rel>Aggregate` selections.
 *
 * Upstream `@neo4j/graphql` 5.x computed each aggregate with a `CALL`
 * subquery and the aggregating functions (`count`, `min`, `max`, `avg`,
 * `sum`). Neo4j 5.x rejects an aggregating function anywhere inside a list
 * expression ("Can't use aggregating expressions inside of expressions
 * executing over lists"), and nested selections are pattern comprehensions,
 * so every aggregate here is a pure expression that works at any depth:
 *
 * - `count`: `COUNT { <pattern> WHERE … }`;
 * - the others: a `reduce(…)` fold over the pattern comprehension
 *   `[<pattern> WHERE … | <var>.<prop>]`, with nulls removed (as the
 *   aggregating functions ignore them).
 *
 * Each fold reproduces the aggregating function's own result exactly:
 * `avg` is the incremental mean Neo4j uses (`m += (x - m) / c`), `sum`
 * promotes an overflowing integer sum to a float as `sum()` does, `min` /
 * `max` use `<` / `>` (and, for durations, the duration orderability key
 * `min()` / `max()` order by). Verified against the functions on live 5.26.
 */
import { OGMError } from '../errors';
import type { PropertyDefinition } from '../schema/types';
import { escapeIdentifier } from '../utils/validation';

/** Suffix of a relationship aggregate selection field (`postsAggregate`). */
export const AGGREGATE_SUFFIX = 'Aggregate';

/** How a scalar type aggregates (upstream's aggregation type matrix). */
export type AggregateKind =
  | 'id'
  | 'string'
  | 'number'
  | 'bigint'
  | 'temporal'
  | 'duration';

const KIND_BY_TYPE: Record<string, AggregateKind> = {
  ID: 'id',
  String: 'string',
  Int: 'number',
  Float: 'number',
  BigInt: 'bigint',
  DateTime: 'temporal',
  LocalDateTime: 'temporal',
  LocalTime: 'temporal',
  Time: 'temporal',
  Duration: 'duration',
};

/**
 * Aggregates offered per kind. Upstream offers `shortest` / `longest` for
 * ID and String; `min` / `max` are also accepted there (lexicographic, as
 * `Model.aggregate()` returns them) so the selection types stay a superset
 * of what they declared before.
 */
export const AGGREGATES_BY_KIND: Record<AggregateKind, readonly string[]> = {
  id: ['shortest', 'longest', 'min', 'max'],
  string: ['shortest', 'longest', 'min', 'max'],
  number: ['min', 'max', 'average', 'sum'],
  bigint: ['min', 'max', 'average', 'sum'],
  temporal: ['min', 'max'],
  duration: ['min', 'max'],
};

/**
 * The aggregate kind of a property, or `null` when it has no aggregate:
 * lists, `@cypher` fields, Boolean, Date, enums, points and custom scalars
 * (upstream's `isAggregableField` + aggregation type matrix).
 */
export function aggregateKind(prop: PropertyDefinition): AggregateKind | null {
  if (prop.isArray || prop.isCypher) return null;
  return KIND_BY_TYPE[prop.type] ?? null;
}

const MAX_LONG = '9223372036854775807';
const MIN_LONG = '-9223372036854775808';

/** The duration orderability key `min()` / `max()` sort by. */
function durationKey(v: string): string {
  return `[${v}.months * 2629746 + ${v}.days * 86400 + ${v}.seconds, ${v}.nanosecondsOfSecond, ${v}.months, ${v}.days]`;
}

/** `reduce` picking the value that `better(x, a)` prefers. */
function pick(list: string, acc: string, x: string, better: string): string {
  return `reduce(${acc} = null, ${x} IN ${list} | CASE WHEN ${acc} IS NULL OR ${better} THEN ${x} ELSE ${acc} END)`;
}

function minMax(
  kind: AggregateKind,
  op: 'min' | 'max',
  list: string,
  acc: string,
  x: string,
): string {
  const cmp = op === 'min' ? '<' : '>';
  if (kind === 'duration')
    return pick(list, acc, x, `${durationKey(x)} ${cmp} ${durationKey(acc)}`);
  return pick(list, acc, x, `${x} ${cmp} ${acc}`);
}

function sum(list: string, acc: string, x: string): string {
  // `sum()` turns an overflowing integer sum into a float; `+` throws.
  return (
    `reduce(${acc} = 0, ${x} IN ${list} | CASE WHEN ${acc} IS :: INTEGER AND ${x} IS :: INTEGER AND ` +
    `((${x} > 0 AND ${acc} > ${MAX_LONG} - ${x}) OR (${x} < 0 AND ${acc} < ${MIN_LONG} - ${x})) ` +
    `THEN toFloat(${acc}) + ${x} ELSE ${acc} + ${x} END)`
  );
}

function average(list: string, acc: string, x: string): string {
  return `CASE WHEN size(${list}) = 0 THEN null ELSE reduce(${acc} = [0.0, 0], ${x} IN ${list} | [${acc}[0] + (${x} - ${acc}[0]) / (${acc}[1] + 1), ${acc}[1] + 1])[0] END`;
}

const ZEROS = `'000000000000000000000'`;

/** `head([name IN [expr] | body])` — evaluates `expr` once, as `name`. */
function bind(name: string, expr: string, body: string): string {
  return `head([${name} IN [${expr}] | ${body}])`;
}

/**
 * ECMAScript `Number#toString` of a FLOAT expression `v`, in Cypher.
 * Cypher's `toString(float)` is Java's (`1.0`, `3.0E15`); upstream
 * serialized BigInt aggregates in JavaScript (`String(x)`: `1`,
 * `3000000000000000`). The shortest digits come from Java's string; this
 * re-places the decimal point by ECMA-262's rules. Fuzzed against
 * `String(x)` on 20k doubles on live 5.26: identical except the smallest
 * denormal (Java 17 prints `4.9E-324`), which no BigInt average reaches.
 */
function jsNumberString(v: string, q: string): string {
  const [b, m, e, ds, lz, d, n] = ['b', 'm', 'e', 's', 'z', 'd', 'n'].map(
    (s) => `${q}${s}`,
  );
  const format =
    `CASE WHEN size(${d}) <= ${n} AND ${n} <= 21 THEN ${d} + substring(${ZEROS}, 0, ${n} - size(${d})) ` +
    `WHEN 0 < ${n} AND ${n} <= 21 THEN substring(${d}, 0, ${n}) + '.' + substring(${d}, ${n}) ` +
    `WHEN -6 < ${n} AND ${n} <= 0 THEN '0.' + substring(${ZEROS}, 0, -${n}) + ${d} ` +
    `ELSE substring(${d}, 0, 1) + CASE WHEN size(${d}) > 1 THEN '.' + substring(${d}, 1) ELSE '' END + 'e' + ` +
    `CASE WHEN ${n} >= 1 THEN '+' ELSE '-' END + toString(abs(${n} - 1)) END`;
  const digits = bind(
    b,
    `toString(abs(${v}))`,
    bind(
      m,
      `split(split(${b}, 'E')[0], '.')`,
      bind(
        e,
        `CASE WHEN ${b} CONTAINS 'E' THEN toInteger(split(${b}, 'E')[1]) ELSE 0 END`,
        bind(
          ds,
          `${m}[0] + coalesce(${m}[1], '')`,
          // [leading, trailing] zero counts of the digit string.
          bind(
            lz,
            `[size(${ds}) - size(ltrim(replace(${ds}, '0', ' '))), size(${ds}) - size(rtrim(replace(${ds}, '0', ' ')))]`,
            bind(
              d,
              `substring(${ds}, ${lz}[0], size(${ds}) - ${lz}[0] - ${lz}[1])`,
              bind(
                n,
                `size(${m}[0]) + ${e} - ${lz}[0]`,
                `(CASE WHEN ${v} < 0 THEN '-' ELSE '' END) + ${format}`,
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return (
    `CASE WHEN ${v} = 0 THEN '0' WHEN isNaN(${v}) THEN 'NaN' ` +
    `WHEN ${v} > 1.7976931348623157E308 THEN 'Infinity' WHEN ${v} < -1.7976931348623157E308 THEN '-Infinity' ` +
    `ELSE ${digits} END`
  );
}

/**
 * A BigInt aggregate as a string, as upstream's `BigInt` scalar serialized
 * it: an integer exactly (`toString`), a float (an `average`, an
 * overflowed `sum`) as JavaScript's `Number#toString` would.
 */
function bigintString(expr: string, v: string, q: string): string {
  return bind(
    v,
    expr,
    `CASE WHEN ${v} IS NULL THEN null WHEN ${v} IS :: INTEGER THEN toString(${v}) ELSE ${jsNumberString(v, q)} END`,
  );
}

/**
 * The expression for one aggregate `op` over `list` (a non-null value
 * list expression already bound to a variable). `depth` keeps the
 * accumulator / element variables unique per nesting level.
 */
export function aggregateExpression(
  kind: AggregateKind,
  op: string,
  list: string,
  depth: number,
): string {
  const acc = `__a${depth}`;
  const x = `__x${depth}`;
  const v = `__b${depth}`;
  if (kind === 'id' || kind === 'string') {
    if (op === 'min' || op === 'max') return minMax(kind, op, list, acc, x);
    if (kind === 'id')
      // Upstream: ID shortest / longest are min / max.
      return minMax(kind, op === 'shortest' ? 'min' : 'max', list, acc, x);
    // Upstream: `ORDER BY size(v) DESC` then head (longest) / last
    // (shortest) — the first longest, the last shortest, in match order.
    return op === 'longest'
      ? pick(list, acc, x, `size(${x}) > size(${acc})`)
      : pick(list, acc, x, `size(${x}) <= size(${acc})`);
  }
  const expr =
    op === 'min' || op === 'max'
      ? minMax(kind, op, list, acc, x)
      : op === 'sum'
        ? sum(list, acc, x)
        : average(list, acc, x);
  return kind === 'bigint' ? bigintString(expr, v, `__f${depth}`) : expr;
}

/**
 * `head([__l IN [<non-null values>] | { <op>: <expr>, … }])` — binds the
 * value list once and projects every selected aggregate of one field.
 * `entries` are `[escapedKey, op]` pairs.
 */
export function fieldAggregateMap(
  kind: AggregateKind,
  values: string,
  entries: ReadonlyArray<[string, string]>,
  typeName: string | null,
  typenameKeys: readonly string[],
  depth: number,
): string {
  const list = `__l${depth}`;
  const v = `__v${depth}`;
  const parts = [
    ...typenameKeys.map((k) => `${k}: '${typeName}'`),
    ...entries.map(
      ([key, op]) => `${key}: ${aggregateExpression(kind, op, list, depth)}`,
    ),
  ];
  return `head([${list} IN [[${v} IN ${values} WHERE ${v} IS NOT NULL]] | { ${parts.join(', ')} }])`;
}

/** `<var>.<prop>` for a stored property. */
export function propertyRef(varName: string, prop: PropertyDefinition): string {
  return `${varName}.${escapeIdentifier(prop.name)}`;
}

/** Throw for an aggregate the field's type does not offer. */
export function assertAggregateOp(
  kind: AggregateKind,
  op: string,
  where: string,
): void {
  if (!AGGREGATES_BY_KIND[kind].includes(op))
    throw new OGMError(
      `Unknown aggregate "${op}" on ${where}. Available: ${AGGREGATES_BY_KIND[kind].join(', ')}.`,
    );
}

/** The scalar type name of upstream's aggregation selection for a kind. */
export function aggregateSelectionTypeName(prop: PropertyDefinition): string {
  return `${prop.type}AggregateSelection`;
}
