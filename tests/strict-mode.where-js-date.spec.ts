/**
 * vNEXT — strict item 42: a JS `Date` in a where filter on a temporal field
 * other than `DateTime`. The driver packs the Date as an empty map, so the
 * filter never matches (equality, ranges, `_IN`) or matches every row with
 * the field set (`_NOT`, `_NOT_IN`). Default mode keeps the Cypher and
 * params byte for byte and warns once per OGM, type and field; strict mode
 * throws the same `OGMError` as a write (v2.18.0).
 */
import { OGM } from '../src/ogm';
import { OGMError } from '../src/errors';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';

const typeDefs = /* GraphQL */ `
  type Ev @node {
    id: ID! @unique
    at: DateTime
    day: Date
    local: LocalDateTime
    t: Time
    lt: LocalTime
    days: [Date!]
    links: [Ev!]! @relationship(type: "LINK", direction: OUT)
  }
`;

const D = new Date('2024-01-15T10:30:00Z');

function build(strict: boolean | undefined) {
  const records: Recorded[] = [];
  const warn = jest.fn();
  const ogm = new OGM({
    typeDefs,
    driver: recordingDriver(records),
    logger: { warn } as never,
    ...(strict === undefined ? {} : { strict }),
  });
  return { ogm, records, warn };
}

const shapes: Record<string, Record<string, unknown>> = {
  'Date eq': { day: D },
  'Date _NOT': { day_NOT: D },
  'Date _GT': { day_GT: D },
  'Date _IN': { day_IN: [D, '2020-01-01'] },
  'Date _NOT_IN': { day_NOT_IN: [D] },
  'LocalDateTime _LTE': { local_LTE: D },
  'Time eq': { t: D },
  'LocalTime _GTE': { lt_GTE: D },
  'list Date eq': { days: [D] },
  'list Date _IN': { days_IN: [[D]] },
  'relationship filter': { links_SOME: { day: D } },
};

/** Pre-vNEXT Cypher (captured from a962f44, v2.20.1). */
const BEFORE: Record<string, string> = {
  'Date eq': 'n.`day` = $param0',
  'Date _NOT': 'n.`day` <> $param0',
  'Date _GT': 'n.`day` > $param0',
  'Date _IN': 'n.`day` IN [wc_t IN $param0 | date(wc_t)]',
  'Date _NOT_IN': 'NOT n.`day` IN $param0',
  'LocalDateTime _LTE': 'n.`local` <= $param0',
  'Time eq': 'n.`t` = $param0',
  'LocalTime _GTE': 'n.`lt` >= $param0',
  'list Date eq': 'n.`days` = $param0',
  'list Date _IN': 'n.`days` IN $param0',
  'relationship filter':
    'EXISTS { MATCH (n)-[:`LINK`]->(r0:`Ev`) WHERE r0.`day` = $param1 }',
};

describe('strict item 42: JS Date where on a non-DateTime temporal field', () => {
  it.each(Object.entries(shapes))(
    'default mode: %s keeps its Cypher and warns once',
    async (name, where) => {
      const unset = build(undefined);
      const off = build(false);
      await unset.ogm.model('Ev').find({ where, selectionSet: '{ id }' });
      await unset.ogm.model('Ev').find({ where, selectionSet: '{ id }' });
      await off.ogm.model('Ev').find({ where, selectionSet: '{ id }' });
      expect(off.records[0]).toEqual(unset.records[0]);
      expect(unset.records[0].cypher).toContain(BEFORE[name]);
      expect(unset.warn).toHaveBeenCalledTimes(1);
      expect(unset.warn.mock.calls[0][0]).toMatch(/strict: true/);
    },
  );

  it.each(Object.entries(shapes))(
    'strict mode: %s throws OGMError',
    async (_name, where) => {
      const { ogm, records } = build(true);
      await expect(
        ogm.model('Ev').find({ where, selectionSet: '{ id }' }),
      ).rejects.toThrow(OGMError);
      await expect(
        ogm.model('Ev').find({ where, selectionSet: '{ id }' }),
      ).rejects.toThrow(/A JS Date cannot be compared with/);
      expect(records).toHaveLength(0);
    },
  );

  it('fast-path array connect where: warns by default, throws in strict', async () => {
    const connect = { links: [{ where: { node: { day: D } } }] };
    const lax = build(undefined);
    await lax.ogm.model('Ev').update({ where: { id: 'e1' }, connect });
    expect(lax.warn).toHaveBeenCalledTimes(1);
    const strict = build(true);
    await expect(
      strict.ogm.model('Ev').update({ where: { id: 'e1' }, connect }),
    ).rejects.toThrow(OGMError);
  });

  it('DateTime, ISO strings and string operators are unaffected', async () => {
    const { ogm, warn } = build(true);
    await ogm.model('Ev').find({
      where: { at: D, at_IN: [D], day: '2024-01-15', t_GT: '10:00:00Z' },
      selectionSet: '{ id }',
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
