/**
 * Live nested aggregating `@cypher` field suite (v2.4.8).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * A `@cypher` field selected through a relationship is projected inline as
 * `head(COLLECT { ... })`. When its statement aggregates
 * (`RETURN count(p) AS postCount`), Neo4j 5 rejects the WHOLE query with
 * "Aggregation column contains implicit grouping expressions" — every
 * rewrite we tried (inner CALL, `WITH count() AS c`, `CALL (this) {}`,
 * COLLECT instead of a pattern comprehension) fails the same way. The OGM
 * now refuses the selection at compile time with an error naming the
 * field; selecting it at the top level keeps working.
 */
import { OGMError } from '../../src/errors';
import { describeLive, liveHarness } from '../fixtures/read-paths.fixture';

jest.setTimeout(60_000);

describeLive('Nested aggregating @cypher fields — live Neo4j', () => {
  const h = liveHarness();

  beforeAll(async () => {
    await h.setup();
    await h.run(
      `CREATE (u:LbUser {id: $u, runId: $runId})
       CREATE (u)-[:LB_WROTE]->(:LbPost {id: $p1, runId: $runId})
       CREATE (u)-[:LB_WROTE]->(:LbPost {id: $p2, runId: $runId})
       CREATE (u)-[:LB_HAS_ITEM]->(:LbDoc {id: $d, runId: $runId, rank: 4})`,
      { u: h.id('u'), p1: h.id('p1'), p2: h.id('p2'), d: h.id('d') },
    );
  });

  afterAll(() => h.teardown());

  it('selecting it through a relationship throws a clear OGMError', async () => {
    const attempt = h.ogm.model('LbPost').find({
      where: { id: h.id('p1') } as never,
      selectionSet: '{ id author { postCount } }',
    });
    await expect(attempt).rejects.toThrow(OGMError);
    await expect(attempt).rejects.toThrow(/LbUser\.postCount/);
  });

  it('the typed select path throws the same error', async () => {
    await expect(
      h.ogm.model('LbPost').find({
        where: { id: h.id('p1') } as never,
        select: { id: true, author: { select: { postCount: true } } },
      } as never),
    ).rejects.toThrow(/only be selected at the top level/);
  });

  it('top-level selection of the same field still works', async () => {
    const [u] = await h.ogm.model('LbUser').find({
      where: { id: h.id('u') } as never,
      selectionSet: '{ id postCount }',
    });
    expect(u.postCount).toBe(2);
  });

  it('a non-aggregating nested @cypher field still works', async () => {
    const [u] = await h.ogm.model('LbUser').find({
      where: { id: h.id('u') } as never,
      selectionSet: '{ id items { ... on LbDoc { dcount } } }',
    });
    expect(u.items).toEqual([expect.objectContaining({ dcount: 40 })]);
  });
});
