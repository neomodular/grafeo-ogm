/**
 * Live where-value coercion suite (v2.4.8).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * Writes store BigInt as a Long and DateTime as a native datetime, but
 * where filters bound the caller's value raw: a BigInt filter given a
 * string (the generated input type) compared a String with a Long, and a
 * DateTime filter given a JS `Date` never matched — both silently
 * returned nothing.
 */
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

describeLive('Where value coercion — live Neo4j', () => {
  const h = liveHarness();
  // Above 2^53: only an exact Long comparison can match it.
  const BIG = '9007199254740993';
  const AT = '2024-01-15T10:30:00Z';

  beforeAll(async () => {
    await h.setup();
    await h.ogm.model('LbUser').create({
      input: [{ id: h.id('u'), runId: h.runId, big: BIG, at: AT }],
    } as never);
    await h.ogm.model('LbUser').create({
      input: [
        {
          id: h.id('v'),
          runId: h.runId,
          big: '5',
          at: '2020-06-01T00:00:00Z',
        },
      ],
    } as never);
  });

  afterAll(() => h.teardown());

  const ids = async (where: Record<string, unknown>) =>
    (
      (await h.ogm.model('LbUser').find({
        where: { runId: h.runId, ...where } as never,
        selectionSet: '{ id }',
      })) as { id: string }[]
    )
      .map((r) => r.id)
      .sort();

  it('BigInt equality with a string', async () => {
    expect(await ids({ big: BIG })).toEqual([h.id('u')]);
  });

  it('BigInt _IN / _NOT_IN with strings', async () => {
    expect(await ids({ big_IN: [BIG, '1'] })).toEqual([h.id('u')]);
    expect(await ids({ big_NOT_IN: [BIG] })).toEqual([h.id('v')]);
  });

  it('BigInt range with a string and with a bigint', async () => {
    expect(await ids({ big_GT: '9007199254740992' })).toEqual([h.id('u')]);
    expect(await ids({ big_LT: BigInt(BIG) })).toEqual([h.id('v')]);
  });

  it('BigInt still accepts a plain number', async () => {
    expect(await ids({ big: 5 })).toEqual([h.id('v')]);
  });

  it('DateTime equality with a JS Date', async () => {
    expect(await ids({ at: new Date(AT) })).toEqual([h.id('u')]);
  });

  it('DateTime range and _IN with JS Dates', async () => {
    expect(await ids({ at_GTE: new Date('2024-01-01T00:00:00Z') })).toEqual([
      h.id('u'),
    ]);
    expect(
      await ids({ at_IN: [new Date(AT), '2020-06-01T00:00:00Z'] }),
    ).toEqual([h.id('u'), h.id('v')]);
  });
});
