/**
 * vNEXT — a JS `Date` written to a temporal field. The driver cannot pack a
 * `Date` (it goes over the wire as an empty map), so every write path
 * crashed server-side with "Property values can only be of primitive types
 * … Map{}". `DateTime` now binds the Date's ISO string inside `datetime()`
 * — the conversion the where path already applies — and the other temporal
 * types reject a Date with an OGMError. The live half is
 * `tests/integration/date-write-coercion.spec.ts`.
 */
import { OGMError } from '../src/errors';
import type { PropertyDefinition } from '../src/schema/types';
import {
  coerceWriteValue,
  wrapListItemExpr,
  wrapWriteExpr,
} from '../src/utils/write-coercion';

function prop(
  name: string,
  overrides: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return {
    name,
    type: 'String',
    required: false,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher: false,
    directives: [],
    ...overrides,
  };
}

const d = new Date('2024-05-01T10:00:00.000Z');
const at = prop('at', { type: 'DateTime' });
const ats = prop('ats', { type: 'DateTime', isArray: true });

describe('JS Date for a DateTime write (vNEXT)', () => {
  it('binds the ISO string and wraps it in datetime()', () => {
    expect(coerceWriteValue(d, at)).toBe('2024-05-01T10:00:00.000Z');
    expect(wrapWriteExpr('$p', d, at)).toBe('datetime($p)');
  });

  it('converts Dates inside a list field element-wise', () => {
    expect(coerceWriteValue([d, '2024-01-01T00:00:00Z', null], ats)).toEqual([
      '2024-05-01T10:00:00.000Z',
      '2024-01-01T00:00:00Z',
      null,
    ]);
    expect(wrapWriteExpr('$p', [d], ats)).toBe('[wc_t IN $p | datetime(wc_t)]');
  });

  it('wraps an UNWIND column of Dates (createMany / array connect edges)', () => {
    expect(wrapListItemExpr('item.at', [d, undefined, d], at)).toBe(
      'datetime(item.at)',
    );
    // Dates and ISO strings share one expression.
    expect(wrapListItemExpr('item.at', [d, '2024-01-01T00:00:00Z'], at)).toBe(
      'datetime(item.at)',
    );
  });

  it('throws an OGMError for an invalid Date', () => {
    expect(() => coerceWriteValue(new Date('nope'), at)).toThrow(OGMError);
  });

  it.each(['Date', 'LocalDateTime', 'Time', 'LocalTime', 'Duration'])(
    'rejects a JS Date for a %s field with an OGMError',
    (type) => {
      const p = prop('x', { type });
      expect(() => coerceWriteValue(d, p)).toThrow(OGMError);
      expect(() => coerceWriteValue(d, p)).toThrow(/JS Date cannot be written/);
      expect(() =>
        coerceWriteValue([d], prop('xs', { type, isArray: true })),
      ).toThrow(OGMError);
    },
  );

  it('leaves non-Date values alone (byte-identical for every input that worked)', () => {
    expect(coerceWriteValue('2024-01-01T00:00:00Z', at)).toBe(
      '2024-01-01T00:00:00Z',
    );
    expect(wrapWriteExpr('$p', '2024-01-01T00:00:00Z', at)).toBe(
      'datetime($p)',
    );
    expect(coerceWriteValue('2024-01-01', prop('day', { type: 'Date' }))).toBe(
      '2024-01-01',
    );
    expect(coerceWriteValue(d, prop('s'))).toBe(d);
    expect(coerceWriteValue(d, undefined)).toBe(d);
  });
});
