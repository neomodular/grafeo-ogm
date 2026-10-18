/**
 * Live relationship-index fulltext suite (v2.4.8).
 *
 * Opt-in on NEO4J_URI (see `tests/fixtures/read-paths.fixture.ts`).
 *
 * `queryRelationships` yields one row per matching RELATIONSHIP, and the
 * endpoint was projected without collapsing them: a user with two
 * matching `LB_WROTE` edges came back twice, `count` was inflated and
 * `limit` cut the page short. The fix keeps one row per node with its
 * best score.
 */
import {
  describeLive,
  liveHarness,
  type Row,
} from '../fixtures/read-paths.fixture';

jest.setTimeout(120_000);

describeLive('Relationship fulltext — live Neo4j', () => {
  const h = liveHarness();
  const word = `kw${h.runId.replace(/-/g, '')}`;
  const ft = { posts: { LbWroteNoteSearch: { phrase: word } } };

  beforeAll(async () => {
    await h.setup();
    await h.run(
      'CREATE FULLTEXT INDEX LbWroteNoteSearch IF NOT EXISTS FOR ()-[r:LB_WROTE]-() ON EACH [r.note]',
    );
    // u1 wrote two matching posts, u2 one, u3 none.
    await h.run(
      `CREATE (u1:LbUser {id: $u1, runId: $runId})
       CREATE (u2:LbUser {id: $u2, runId: $runId})
       CREATE (u3:LbUser {id: $u3, runId: $runId})
       CREATE (u1)-[:LB_WROTE {note: $word}]->(:LbPost {id: $p1, runId: $runId})
       CREATE (u1)-[:LB_WROTE {note: $word + ' ' + $word}]->(:LbPost {id: $p2, runId: $runId})
       CREATE (u2)-[:LB_WROTE {note: $word}]->(:LbPost {id: $p3, runId: $runId})
       CREATE (u3)-[:LB_WROTE {note: 'other'}]->(:LbPost {id: $p4, runId: $runId})`,
      {
        word,
        u1: h.id('u1'),
        u2: h.id('u2'),
        u3: h.id('u3'),
        p1: h.id('p1'),
        p2: h.id('p2'),
        p3: h.id('p3'),
        p4: h.id('p4'),
      },
    );
    await h.run('CALL db.awaitIndexes(60)');
    for (let i = 0; i < 50; i++) {
      const [r] = await h.run(
        `CALL db.index.fulltext.queryRelationships('LbWroteNoteSearch', $word) YIELD relationship RETURN count(relationship) AS c`,
        { word },
      );
      if (Number(r.c) >= 3) break;
      await new Promise((res) => setTimeout(res, 200));
    }
  });

  afterAll(async () => {
    if (h.driver) await h.run('DROP INDEX LbWroteNoteSearch IF EXISTS');
    await h.teardown();
  });

  const U = () => h.ogm.model('LbUser');
  const ids = (rows: unknown) =>
    (rows as Row[]).map((r) => r.id as string).sort();

  it('returns each matching node once', async () => {
    const rows = await U().find({ fulltext: ft, selectionSet: '{ id }' });
    expect(ids(rows)).toEqual([h.id('u1'), h.id('u2')]);
  });

  it('counts each matching node once', async () => {
    expect(await U().count({ fulltext: ft })).toBe(2);
  });

  it('limit counts distinct nodes, not matching relationships', async () => {
    // Three matching relationships, two nodes: a limit of 3 must not
    // surface a duplicate.
    const rows = await U().find({
      fulltext: ft,
      selectionSet: '{ id }',
      options: { limit: 3 },
    });
    expect(ids(rows)).toEqual([h.id('u1'), h.id('u2')]);
  });

  it('still works as an AND branch', async () => {
    const rows = await U().find({
      fulltext: { AND: [ft, ft] } as never,
      selectionSet: '{ id }',
    });
    expect(ids(rows)).toEqual([h.id('u1'), h.id('u2')]);
  });

  it('still works as an OR branch', async () => {
    const rows = await U().find({
      fulltext: { OR: [ft, ft] } as never,
      selectionSet: '{ id }',
    });
    expect(ids(rows)).toEqual([h.id('u1'), h.id('u2')]);
  });

  it('still works under NOT', async () => {
    const rows = await U().find({
      where: { runId: h.runId } as never,
      fulltext: { NOT: ft } as never,
      selectionSet: '{ id }',
    });
    expect(ids(rows)).toEqual([h.id('u3')]);
  });
});
