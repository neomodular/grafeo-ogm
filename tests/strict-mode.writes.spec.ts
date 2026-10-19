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

/** Legitimate shapes strict mode still compiles differently (item 4). */
const BLANKET = new Set(['disconnect null', 'disconnect {} (unshared type)']);

describe('legitimate write shapes never warn and compile the same strict', () => {
  it.each(Object.entries(legitWriteShapes))('%s', async (name, run) => {
    const lenient = setup();
    await run(lenient.ogm);
    expect(lenient.warnings()).toEqual([]);
    const strict = setup(true);
    await run(strict.ogm);
    if (BLANKET.has(name))
      // Strict binds the target label even when no other field shares the type.
      expect(strict.records[0].cypher).toContain(
        'OPTIONAL MATCH (n)-[r_posts_0:`WROTE`]->(:`Post`)',
      );
    else expect(strict.records).toEqual(lenient.records);
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

describe('item 2 — unknown edge-property keys', () => {
  const cases = [
    'edge: unknown key on connect (UNWIND path)',
    'edge: unknown key on connect (single object)',
    'edge: unknown key on nested create (in create)',
    'edge: unknown key on nested create (in update)',
    'edge: unknown key on nested update',
  ];
  it.each(cases)('default warns once: %s', (name) =>
    warnsOnce(
      badWriteShapes[name],
      'Unknown field "rolee" in the edge input of "posts" is not a property of the relationship properties type "Wrote"; ' +
        'it is written to the relationship as a stray property.',
    ),
  );
  it.each(cases)('strict throws: %s', async (name) => {
    const { ogm, records } = setup(true);
    await expect(badWriteShapes[name](ogm)).rejects.toThrow(
      /^Unknown field "rolee" in the edge input \((connect|nested create|nested update)\) of "posts": it is not a property of the relationship properties type "Wrote"\./,
    );
    expect(records).toEqual([]);
  });

  it('a relationship without @relationshipProperties has no edge fields', async () => {
    const { ogm } = setup(true);
    await expect(
      ogm.model('User').update({
        where: { id: 'u1' },
        connect: { pets: [{ where: { node: { id: 'p1' } }, edge: { x: 1 } }] },
      }),
    ).rejects.toThrow('which declares no @relationshipProperties');
  });
});

describe('item 3 — upsert where with several unique keys', () => {
  const run = badWriteShapes['upsert: two unique keys in where'];
  it('default warns once', () =>
    warnsOnce(
      run,
      'upsert on User with several unique keys in "where" ("id", "email") MERGEs on all of them together',
    ));
  it('strict throws before running anything', async () => {
    const { ogm, records } = setup(true);
    await expect(run(ogm)).rejects.toThrow(
      'upsert "where" must name exactly one @id / @unique field of User; got "id", "email".',
    );
    expect(records).toEqual([]);
  });
});

describe('item 4 — blanket disconnect on a shared relationship type', () => {
  it('default warns once per sharing pair, at construction', async () => {
    const { ogm, logger } = setup();
    await badWriteShapes['blanket disconnect on a shared relationship type'](
      ogm,
    );
    const shared = logger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('share relationship type'));
    expect(shared).toEqual([
      '[OGM] User.pets (Pet) and User.toys (Toy) share relationship type "HAS" (OUT): a blanket disconnect ' +
        "(null / {}) on either also unlinks the other's nodes. Enable `strict: true` (default in 3.0) to " +
        "restrict a blanket disconnect to the field's own target type.",
    ]);
  });

  it('strict does not warn and binds the target label', async () => {
    const top = setup(true);
    await badWriteShapes['blanket disconnect on a shared relationship type'](
      top.ogm,
    );
    expect(top.logger.warn).not.toHaveBeenCalled();
    expect(top.records[0].cypher).toBe(
      [
        'MATCH (n:`User`)',
        'WHERE n.`id` = $param0',
        'WITH n',
        'CALL {',
        'WITH n',
        'OPTIONAL MATCH (n)-[r_pets_0:`HAS`]->(:`Pet`)',
        'DELETE r_pets_0',
        'RETURN count(*) AS _r_pets_0',
        '}',
        "RETURN n { __typename: 'User', .`id`, .`email`, .`name` }",
      ].join('\n'),
    );
    const nested = setup(true);
    await badWriteShapes[
      'blanket disconnect on a shared relationship type (nested in update)'
    ](nested.ogm);
    expect(nested.records[0].cypher).toContain(
      'OPTIONAL MATCH (n)-[r_disc_pets_0_0:`HAS`]->(:`Pet`)\nDELETE r_disc_pets_0_0',
    );
  });

  it('strict restricts an abstract target to its members', async () => {
    const records: Recorded[] = [];
    const ogm = new OGM({
      typeDefs: /* GraphQL */ `
        interface Animal {
          name: String
        }
        type Dog implements Animal @node {
          name: String
        }
        type Cat implements Animal @node {
          name: String
        }
        type Owner @node {
          id: ID! @id @unique
          animals: [Animal!]! @relationship(type: "OWNS", direction: OUT)
        }
      `,
      driver: recordingDriver(records),
      strict: true,
    });
    await ogm
      .model('Owner')
      .update({ where: { id: 'o1' }, disconnect: { animals: null } });
    expect(records[0].cypher).toContain(
      'OPTIONAL MATCH (n)-[r_animals_0:`OWNS`]->(target_animals_0)\n' +
        'WHERE (target_animals_0:`Dog` OR target_animals_0:`Cat`)\n' +
        'DELETE r_animals_0',
    );
  });
});
