/**
 * v2.6.0 — strict mode on the write paths: default mode warns once per
 * OGM and shape (and compiles as v2.5.3, see strict-mode.byte-identical),
 * `strict: true` throws or compiles the corrected Cypher.
 */
import { OGMError } from '../src/errors';
import { OGM } from '../src/ogm';
import {
  badWriteShapes,
  legitWriteShapes,
  Recorded,
  recordingDriver,
  Run,
  writeTypeDefs,
} from './strict-mode.writes.cases';

function setup(strict?: boolean) {
  const records: Recorded[] = [];
  const logger = { debug: jest.fn(), warn: jest.fn() };
  const ogm = new OGM({
    typeDefs: writeTypeDefs,
    driver: recordingDriver(records),
    logger,
    ...(strict === undefined ? {} : { strict }),
  });
  /** Warnings logged after construction (item 4 also warns at construction). */
  const warnings = () =>
    logger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => !m.includes('share relationship type'));
  return { ogm, records, logger, warnings };
}

const STRICT_HINT = 'Enable `strict: true` (default in 3.0)';

async function warnsOnce(run: Run, expected: string | RegExp) {
  const { ogm, warnings } = setup();
  await run(ogm);
  await run(ogm);
  await run(ogm);
  expect(warnings()).toHaveLength(1);
  expect(warnings()[0]).toMatch(expected);
  expect(warnings()[0]).toContain(STRICT_HINT);
}

describe('legitimate write shapes never warn and compile the same strict', () => {
  it.each(Object.entries(legitWriteShapes))('%s', async (_name, run) => {
    const lenient = setup();
    await run(lenient.ogm);
    expect(lenient.warnings()).toEqual([]);
    const strict = setup(true);
    await run(strict.ogm);
    expect(strict.records).toEqual(lenient.records);
  });
});

describe('item 1 — unknown connect / disconnect item keys', () => {
  const cases = [
    'connect: unknown item key (array, UNWIND path)',
    'connect: unknown item key (single object)',
    'connect: unknown item key (nested in update)',
    'connect: unknown item key (nested in create)',
  ];
  it.each(cases)('default warns once: %s', (name) =>
    warnsOnce(
      badWriteShapes[name],
      'Unknown key(s) "wehre" in a connect item on "pets" is ignored; with no "where", the item connects EVERY "Pet" node.',
    ),
  );
  it.each(cases)('strict throws: %s', async (name) => {
    const { ogm } = setup(true);
    await expect(badWriteShapes[name](ogm)).rejects.toThrow(
      new OGMError(
        'Unknown key(s) "wehre" in a connect item on "pets". Allowed: "where", "edge", "overwrite", "connect".',
      ),
    );
  });

  const disconnectCases = [
    'disconnect: unknown item key',
    'disconnect: unknown item key (nested in update)',
  ];
  it.each(disconnectCases)('default warns once: %s', (name) =>
    warnsOnce(
      badWriteShapes[name],
      'Unknown key(s) "wehre" in a disconnect item on "pets" is ignored; with no "where", the item unlinks EVERY related "Pet" node.',
    ),
  );
  it.each(disconnectCases)('strict throws: %s', async (name) => {
    const { ogm } = setup(true);
    await expect(badWriteShapes[name](ogm)).rejects.toThrow(
      'Unknown key(s) "wehre" in a disconnect item on "pets". Allowed: "where", "disconnect".',
    );
  });

  it('an unknown key next to a where is reported without the widening note', async () => {
    const { ogm, warnings } = setup();
    await ogm.model('User').update({
      where: { id: 'u1' },
      connect: { pets: [{ where: { node: { id: 'p1' } }, extra: 1 }] },
    });
    expect(warnings()).toEqual([
      '[OGM] Unknown key(s) "extra" in a connect item on "pets" is ignored. Allowed: "where", "edge", "overwrite", "connect". ' +
        'Enable `strict: true` (default in 3.0) to throw an OGMError for unknown connect item keys.',
    ]);
  });
});
