/**
 * Live `_MATCHES` dot-all contains suite (vNEXT — issue #2).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * The ReDoS guard now accepts the dot-all contains form `(?is).*term.*`:
 * with DOTALL the trailing `.*` matches any remainder on its first try, so
 * Java's matcher never retries earlier positions and the match is linear.
 * Without DOTALL, `(?i).*x.*` on a long `x…\n` value is quadratic (~9 s at
 * 100k chars on 5.26) and Neo4j cannot interrupt a running regex, so it
 * stays refused. This suite runs the accepted form on the server against
 * the adversarial 1M-char subject and checks the booleans.
 */
import { OGMError } from '../../src/errors';
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

type IdRow = { id: string };

describeLive('_MATCHES dot-all contains form — live Neo4j', () => {
  const h = liveHarness();

  beforeAll(async () => {
    await h.setup();
    await h.run(
      `CREATE (:LbUser {id: $big, runId: $runId, name: $bigName})
       CREATE (:LbUser {id: $multi, runId: $runId, name: 'first line\nhas an x (1) here'})
       CREATE (:LbUser {id: $upper, runId: $runId, name: 'XYZ'})
       CREATE (:LbUser {id: $none, runId: $runId, name: 'abc\ndef'})
       CREATE (:LbUser {id: $bigNone, runId: $runId, name: $bigNoneName})`,
      {
        big: h.id('big'),
        bigName: 'x'.repeat(1_000_000) + '\n',
        multi: h.id('multi'),
        upper: h.id('upper'),
        none: h.id('none'),
        bigNone: h.id('big-none'),
        bigNoneName: 'b'.repeat(1_000_000) + '\n',
      },
    );
  });

  afterAll(() => h.teardown());

  const ids = (rows: unknown) => (rows as IdRow[]).map((r) => r.id).sort();

  it('`(?is).*x.*` runs linearly on a 1M-char `x…\\n` value and matches correctly', async () => {
    const started = Date.now();
    const rows = await h.ogm.model('LbUser').find({
      where: { runId: h.runId, name_MATCHES: '(?is).*x.*' },
      selectionSet: '{ id }',
    });
    const elapsed = Date.now() - started;
    expect(ids(rows)).toEqual(
      [h.id('big'), h.id('multi'), h.id('upper')].sort(),
    );
    expect(elapsed).toBeLessThan(1000);
  });

  it('agrees with `_CONTAINS` + `mode: insensitive` on ASCII data', async () => {
    const regex = await h.ogm.model('LbUser').find({
      where: { runId: h.runId, name_MATCHES: '(?is).*x.*' },
      selectionSet: '{ id }',
    });
    const contains = await h.ogm.model('LbUser').find({
      where: { runId: h.runId, name_CONTAINS: 'x', mode: 'insensitive' },
      selectionSet: '{ id }',
    });
    expect(ids(regex)).toEqual(ids(contains));
  });

  it('an escaped interpolated term matches literally', async () => {
    const rows = await h.ogm.model('LbUser').find({
      where: { runId: h.runId, name_MATCHES: '(?s).*x \\(1\\).*' },
      selectionSet: '{ id }',
    });
    expect(ids(rows)).toEqual([h.id('multi')]);
  });

  it('`(?i).*x.*` (no DOTALL) is still refused, with a dot-all hint', async () => {
    const attempt = h.ogm.model('LbUser').find({
      where: { runId: h.runId, name_MATCHES: '(?i).*x.*' },
      selectionSet: '{ id }',
    });
    await expect(attempt).rejects.toThrow(OGMError);
    await expect(attempt).rejects.toThrow(/did you mean the dot-all form/);
  });
});
