/**
 * Live: known fields selected in the wrong shape (v2.7.1).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * A scalar with a sub-selection (`name { x }`) was left out of the result
 * and a relationship without one (`posts`) came back as a raw property,
 * null, with no error. Default mode keeps that result and warns once;
 * `strict: true` throws before anything runs. A typed relationship given
 * `{}` (offered by the generated types) was left out; it now selects every
 * scalar of the target, as `true` does.
 */
import { Model } from '../../src/model';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';
import {
  describeLive,
  liveHarness,
  typeDefs,
  type Row,
} from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

describeLive('selection shape mismatches — live Neo4j', () => {
  const h = liveHarness();

  beforeAll(async () => {
    await h.setup();
    await h.run(
      `CREATE (u:LbUser {id: $u, runId: $runId, name: 'Ann'})
       CREATE (u)-[:LB_WROTE {stars: 5}]->(:LbPost {id: $p1, runId: $runId, title: 'a', secret: false})`,
      { u: h.id('u'), p1: h.id('p1') },
    );
  });

  afterAll(() => h.teardown());
  beforeEach(() => Model.clearSelectionCache());

  const make = (strict?: boolean) => {
    const logger = { debug: jest.fn(), warn: jest.fn() };
    const ogm = new OGM({
      typeDefs,
      driver: h.driver,
      logger,
      ...(strict === undefined ? {} : { strict }),
    });
    return { user: ogm.model('LbUser'), logger };
  };
  const where = () => ({ id: h.id('u') }) as never;

  it('default: the v2.7.0 result, one warning per type + field', async () => {
    const { user, logger } = make();
    for (let i = 0; i < 2; i++) {
      const rows = (await user.find({
        where: where(),
        selectionSet: '{ id name { x } posts postsConnection }',
      })) as Row[];
      expect(rows).toEqual([
        { id: h.id('u'), posts: null, postsConnection: null },
      ]);
    }
    const messages = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain(
      'selects "name" on type "LbUser" in the wrong shape: it is a scalar field (String) and takes no sub-selection: select it as "name"; 2.x leaves it out of the result.',
    );
    expect(messages[1]).toContain(
      'selects "posts" on type "LbUser" in the wrong shape: it is a relationship to LbPost and needs a sub-selection, e.g. "posts { … }"; 2.x projects it as a raw node property (null unless one is stored).',
    );
    expect(messages[2]).toContain('"postsConnection"');
  });

  it('default: typed scalar given an object is left out, with a warning', async () => {
    const { user, logger } = make(false);
    const rows = (await user.find({
      where: where(),
      select: { id: true, name: { select: {} } },
    } as never)) as Row[];
    expect(rows).toEqual([{ id: h.id('u') }]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('strict: throws before running', async () => {
    const { user } = make(true);
    await expect(
      user.find({ where: where(), selectionSet: '{ id posts }' }),
    ).rejects.toThrow(
      new OGMError(
        'Field "posts" in selectionSet on type "LbUser" is a relationship to LbPost and needs a sub-selection, e.g. "posts { … }".',
      ),
    );
    await expect(
      user.find({
        where: where(),
        select: { id: true, posts: 'yes' },
      } as never),
    ).rejects.toThrow(OGMError);
  });

  it('typed relationship {} selects every scalar, in both modes', async () => {
    for (const strict of [false, true]) {
      const { user, logger } = make(strict);
      const rows = (await user.find({
        where: where(),
        select: { id: true, posts: {} },
      } as never)) as Row[];
      expect(rows).toEqual([
        {
          id: h.id('u'),
          posts: [
            {
              id: h.id('p1'),
              runId: h.runId,
              rank: null,
              title: 'a',
              secret: false,
            },
          ],
        },
      ]);
      expect(logger.warn).not.toHaveBeenCalled();
    }
  });
});
