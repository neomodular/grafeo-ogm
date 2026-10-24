/**
 * Live suite (v2.21.0 — strict item 42): a JS `Date` in a where filter on a
 * `Date` / `LocalDateTime` / `Time` / `LocalTime` field.
 *
 * The driver packs a JS Date as an empty map, so on a962f44 (v2.20.1)
 * equality, ranges and `_IN` never matched and `_NOT` / `_NOT_IN` matched
 * every row with the field set, whatever the date. Default mode keeps those
 * results and warns; strict mode throws the write path's `OGMError`
 * (writes reject a Date for these types since v2.18.0).
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItWjdEvent @node {
    id: ID! @unique
    runId: String
    day: Date
    local: LocalDateTime
    t: Time
    lt: LocalTime
    days: [Date!]
  }
`;

describeLive(
  'JS Date where on non-DateTime temporals (strict item 42) — live',
  () => {
    const runId = `it-${randomUUID()}`;
    const D = new Date('2024-01-15T10:30:00Z');
    let driver: Driver;
    let lax: OGM;
    let strict: OGM;
    const warn = jest.fn();

    beforeAll(async () => {
      driver = neo4j.driver(
        URI!,
        neo4j.auth.basic(
          process.env.NEO4J_USER ?? 'neo4j',
          process.env.NEO4J_PASSWORD ?? 'password',
        ),
      );
      lax = new OGM({ typeDefs, driver, logger: { warn } as never });
      strict = new OGM({ typeDefs, driver, strict: true });
      const session = driver.session();
      try {
        await session.run(
          `CREATE (:ItWjdEvent {id: $runId + '-a', runId: $runId, day: date('2024-01-15'),
                   local: localdatetime('2024-01-15T10:30:00'), t: time('10:30:00Z'),
                   lt: localtime('10:30:00'), days: [date('2024-01-15')]}),
                (:ItWjdEvent {id: $runId + '-b', runId: $runId, day: date('2020-06-01'),
                   local: localdatetime('2020-06-01T00:00:00'), t: time('23:00:00+02:00'),
                   lt: localtime('23:00:00'), days: [date('2020-06-01')]}),
                (:ItWjdEvent {id: $runId + '-c', runId: $runId})`,
          { runId },
        );
      } finally {
        await session.close();
      }
    });

    afterAll(async () => {
      const session = driver.session();
      try {
        await session.run(
          'MATCH (n:ItWjdEvent {runId: $runId}) DETACH DELETE n',
          {
            runId,
          },
        );
      } finally {
        await session.close();
      }
      await driver.close();
    });

    const ids = async (ogm: OGM, where: Record<string, unknown>) =>
      (
        (await ogm.model('ItWjdEvent').find({
          where: { runId, ...where } as never,
          selectionSet: '{ id }',
        })) as { id: string }[]
      )
        .map((r) => r.id.slice(runId.length + 1))
        .sort();

    const neverMatch: Record<string, unknown>[] = [
      { day: D },
      { day_GT: D },
      { day_LTE: D },
      { day_IN: [D] },
      { local: D },
      { local_GTE: D },
      { t: D },
      { t_LT: D },
      { lt: D },
      { days: [D] },
      { days_IN: [[D]] },
    ];
    const everySet: Record<string, unknown>[] = [
      { day_NOT: D },
      { day_NOT_IN: [D] },
      { local_NOT: D },
      { t_NOT_IN: [D] },
      { days_NOT: [D] },
    ];

    it.each(neverMatch)(
      'default mode keeps the old empty result: %o',
      async (w) => {
        expect(await ids(lax, w)).toEqual([]);
      },
    );

    it.each(everySet)(
      'default mode keeps the old every-row-set result: %o',
      async (w) => {
        expect(await ids(lax, w)).toEqual(['a', 'b']);
      },
    );

    it('default mode warned with the item code', () => {
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls[0][0]).toMatch(/A JS Date in a where filter/);
    });

    it.each([...neverMatch, ...everySet])(
      'strict mode throws: %o',
      async (w) => {
        await expect(ids(strict, w)).rejects.toThrow(OGMError);
      },
    );

    it('ISO strings still compare correctly in both modes', async () => {
      for (const ogm of [lax, strict]) {
        expect(await ids(ogm, { day: '2024-01-15' })).toEqual(['a']);
        expect(await ids(ogm, { local_LT: '2024-01-01T00:00:00' })).toEqual([
          'b',
        ]);
        expect(await ids(ogm, { t: '10:30:00Z' })).toEqual(['a']);
      }
    });
  },
);
