/**
 * Live `_MATCHES` guard on characters outside the BMP (v2.28.1 — security).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * Java's regex engine reads code points: `😀*😀*…y` is `x*x*…y` to the
 * server and backtracks exponentially (k = 6 took 14 s on 5.26). Pre-2.28.1
 * the guard read UTF-16 code units, took each emoji's high surrogate for a
 * required atom between the quantified ones, and accepted the pattern. This
 * suite checks that the guard now refuses it, and that the patterns it
 * accepts mean on the server what the guard modelled: one emoji is one atom
 * and a class range spans code points. The refused patterns are never run
 * with the fix; on the pre-fix code they run against a short value, so the
 * failing run stays fast.
 */
import { OGMError } from '../../src/errors';
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

type IdRow = { id: string };

const E = '\u{1F600}'; // 😀
const F = '\u{1F601}'; // 😁

describeLive('_MATCHES with characters outside the BMP — live Neo4j', () => {
  const h = liveHarness();

  beforeAll(async () => {
    await h.setup();
    await h.run(
      `CREATE (:LbUser {id: $smile, runId: $runId, name: $smileName})
       CREATE (:LbUser {id: $grin, runId: $runId, name: $grinName})`,
      {
        smile: h.id('smile'),
        smileName: E.repeat(3) + 'x',
        grin: h.id('grin'),
        grinName: F + 'x',
      },
    );
  });

  afterAll(() => h.teardown());

  const find = (pattern: string) =>
    h.ogm.model('LbUser').find({
      where: { runId: h.runId, name_MATCHES: pattern },
      selectionSet: '{ id }',
    });
  const ids = (rows: unknown) => (rows as IdRow[]).map((r) => r.id).sort();

  it.each([2, 3, 6])(
    'refuses %i quantified emoji in a row before the query runs',
    async (k) => {
      await expect(find((E + '*').repeat(k) + 'y')).rejects.toThrow(OGMError);
      await expect(find((E + '*').repeat(k) + 'y')).rejects.toThrow(/contend/);
    },
  );

  it('refuses an unpaired surrogate', async () => {
    await expect(find('\uD83D*x')).rejects.toThrow(/unpaired UTF-16 surrogate/);
  });

  it('an accepted emoji pattern quantifies the whole code point', async () => {
    expect(ids(await find(`^${E}+x$`))).toEqual([h.id('smile')]);
    expect(ids(await find(`${E}{3}x`))).toEqual([h.id('smile')]);
  });

  it('a class range spans code points', async () => {
    expect(ids(await find(`[${E}-\u{1F64F}]x`))).toEqual([h.id('grin')]);
    expect(ids(await find(`[${E}-\u{1F64F}]+x`))).toEqual(
      [h.id('smile'), h.id('grin')].sort(),
    );
  });

  // The long emoji value exists only for this test, after the refused
  // patterns (which the pre-fix code would have run against it) are done.
  it('two quantified, distinct emoji run linearly', async () => {
    await h.run('CREATE (:LbUser {id: $big, runId: $runId, name: $bigName})', {
      big: h.id('big'),
      bigName: E.repeat(50_000) + 'x',
    });
    const started = Date.now();
    expect(ids(await find(`${E}*${F}*x`))).toEqual(
      [h.id('smile'), h.id('grin'), h.id('big')].sort(),
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
