/**
 * v2.6.3 — selected field names are checked against the schema (#23).
 *
 * Default mode: the v2.6.2 Cypher, byte for byte, plus exactly one warning
 * per type + field (also when the shape runs again, from the parse cache,
 * and on a second OGM). `strict: true`: an `OGMError` naming the type and
 * field. Known fields of every kind never warn and never throw.
 */
import { Driver } from 'neo4j-driver';
import { OGMError } from '../src/errors';
import { Model } from '../src/model';
import { OGM } from '../src/ogm';
import {
  KNOWN_CASES,
  UNKNOWN_CASES,
  selectionFieldTypeDefs,
} from './strict-mode.selection-fields.cases';

function recordingDriver(records: string[]): Driver {
  const session = {
    run: jest.fn((cypher: string) => {
      records.push(cypher);
      return Promise.resolve({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { session: jest.fn().mockReturnValue(session) } as unknown as Driver;
}

function makeOgm(strict: boolean | undefined) {
  const records: string[] = [];
  const logger = { debug: jest.fn(), warn: jest.fn() };
  const ogm = new OGM({
    typeDefs: selectionFieldTypeDefs,
    driver: recordingDriver(records),
    logger,
    ...(strict === undefined ? {} : { strict }),
  });
  return { ogm, records, logger };
}

const unknownWarnings = (logger: { warn: jest.Mock }) =>
  logger.warn.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes('which is not a field of'));

beforeEach(() => Model.clearSelectionCache());

describe.each([
  ['strict unset', undefined],
  ['strict: false', false],
] as const)('unknown selected fields — %s', (_label, strict) => {
  it.each(UNKNOWN_CASES.map((c) => [c.label, c] as const))(
    '%s: v2.6.2 Cypher + one warning',
    async (_name, c) => {
      const { ogm, records, logger } = makeOgm(strict);
      await c.run(ogm);
      await c.run(ogm); // cached parse, same OGM: still one warning
      expect(records).toEqual([c.expected, c.expected]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const message = String(logger.warn.mock.calls[0][0]);
      const field = c.names.match(/^Unknown field "([^"]+)"/)![1];
      expect(message).toContain(`selects "${field}", which is not a field of`);
      expect(message).toContain(c.names.split(' on ')[1].replace(/\.$/, ''));
      if (c.hint) expect(message).toContain(c.hint);
      expect(message).toContain('Enable `strict: true` (default in 3.0)');

      // A second OGM reuses the cross-OGM parse cache and warns too.
      const other = makeOgm(strict);
      await c.run(other.ogm);
      expect(other.records).toEqual([c.expected]);
      expect(other.logger.warn).toHaveBeenCalledTimes(1);
    },
  );
});

describe('unknown selected fields — strict: true', () => {
  it.each(UNKNOWN_CASES.map((c) => [c.label, c] as const))(
    '%s: throws',
    async (_name, c) => {
      const { ogm, records, logger } = makeOgm(true);
      const err = await c.run(ogm).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OGMError);
      expect((err as Error).message).toBe(
        c.hint ? `${c.names} ${c.hint}` : c.names,
      );
      expect(records).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );
});

describe('known selected fields', () => {
  it.each(
    KNOWN_CASES.flatMap((c) =>
      [undefined, true].map((strict) => [c.label, strict, c] as const),
    ),
  )('%s (strict: %s): no warning, no error', async (_name, strict, c) => {
    const { ogm, records, logger } = makeOgm(strict);
    await c.run(ogm);
    expect(records).toHaveLength(1);
    expect(unknownWarnings(logger)).toEqual([]);
    if (strict === undefined) expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns once per type + field, not per shape', async () => {
    const { ogm, logger } = makeOgm(undefined);
    await ogm.model('Plan').find({ selectionSet: '{ id nmae }' });
    await ogm.model('Plan').find({ selectionSet: '{ name nmae }' });
    await ogm.model('Plan').find({ selectionSet: '{ nmae owners { nmae } }' });
    expect(unknownWarnings(logger)).toEqual([
      expect.stringContaining('not a field of type "Plan"'),
      expect.stringContaining('not a field of type "User"'),
    ]);
  });

  it('an instance-level selectionSet is checked on every call', async () => {
    const { ogm, logger } = makeOgm(true);
    const plan = ogm.model('Plan');
    plan.selectionSet = '{ id nmae }';
    await expect(plan.find()).rejects.toThrow(
      'Unknown field "nmae" in selectionSet on type "Plan".',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
