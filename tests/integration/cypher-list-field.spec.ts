/**
 * Live suite for strict item 24 (v2.14.0): list-typed `@cypher` fields.
 *
 * Opt-in on NEO4J_URI. Every node carries this run's `runId` and is
 * removed in `afterAll`; labels are `ItLf`-prefixed.
 *
 * `@neo4j/graphql` 5.x resolves a list `@cypher` field by `UNWIND`ing the
 * statement's column and `collect`ing every element: a statement returning
 * one row per element yields the whole list (in row order, duplicates
 * kept), one returning a single list row yields that list, and no rows
 * yield `[]`. Since v2.4.0 the OGM reduced the column with
 * `head(collect(...))`, so `tags` came back as ONE string. Strict mode
 * follows upstream on every path (root, nested, connection, interface /
 * union fragments, where, update response); default mode is unchanged
 * and warns once.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import {
  buildListOgm,
  ListIds,
  listFieldShapes,
} from '../cypher-list-field.cases';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

type Row = Record<string, unknown>;

describeLive('list @cypher fields (strict item 24) — live Neo4j', () => {
  const runId = `itlf-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;
  const ids: ListIds = { runId, user: id('u1') };
  let driver: Driver;
  let strict: OGM;
  let lenient: OGM;
  const warn = jest.fn();

  const run = (shape: string, ogm: OGM) =>
    listFieldShapes[shape](ogm, ids) as Promise<Row[]>;
  const byId = (rows: Row[]) =>
    Object.fromEntries(rows.map((r) => [r.id as string, r]));

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    await driver.verifyConnectivity();
    const session = driver.session();
    try {
      await session.run(
        `CREATE (u1:ItLfUser {id: $u1, runId: $runId, name: 'one'})
         CREATE (u2:ItLfUser {id: $u2, runId: $runId, name: 'two'})
         CREATE (u1)-[:ITLF_TAG]->(:ItLfTag {name: 'x', pos: 1, runId: $runId})
         CREATE (u1)-[:ITLF_TAG]->(:ItLfTag {name: 'y', pos: 2, runId: $runId})
         CREATE (u1)-[:ITLF_TAG]->(:ItLfTag {name: 'x', pos: 3, runId: $runId})
         CREATE (p:ItLfThing:ItLfPost {id: $p, runId: $runId, title: 'a b a'})
         CREATE (nt:ItLfThing:ItLfNote {id: $nt, runId: $runId, body: 'c d c d'})
         CREATE (u1)-[:ITLF_WROTE {note: 'n1'}]->(p)
         CREATE (u1)-[:ITLF_HAS]->(p), (u1)-[:ITLF_HAS]->(nt)`,
        { runId, u1: id('u1'), u2: id('u2'), p: id('p'), nt: id('nt') },
      );
    } finally {
      await session.close();
    }
    strict = buildListOgm(driver, true);
    lenient = buildListOgm(driver, undefined, { warn, debug: jest.fn() });
  });

  afterAll(async () => {
    if (!driver) return;
    const session = driver.session();
    try {
      await session.run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n', {
        runId,
      });
    } finally {
      await session.close();
    }
    await driver.close();
  });

  describe('strict: true returns the whole list', () => {
    it('root typed select: one row per element, in order, duplicates kept', async () => {
      const rows = await run('root typed select', strict);
      expect(rows).toEqual([
        {
          id: id('u1'),
          tags: ['x', 'y', 'x'],
          tagList: ['x', 'y', 'x'],
          firstTag: 'x',
        },
      ]);
    });

    it('root selectionSet with an alias', async () => {
      const [u] = await run('root selectionSet (aliased)', strict);
      expect(u).toMatchObject({
        tags: ['x', 'y', 'x'],
        labels: ['x', 'y', 'x'],
        tagList: ['x', 'y', 'x'],
        firstTag: 'x',
      });
    });

    it('findUnique', async () => {
      const u = (await run(
        'findUnique selectionSet',
        strict,
      )) as unknown as Row;
      expect(u.tags).toEqual(['x', 'y', 'x']);
    });

    it('no rows → [], and each node is returned exactly once', async () => {
      const rows = await strict.model('ItLfUser').find({
        where: { runId } as never,
        selectionSet: '{ id tags tagList firstTag }',
      });
      expect(rows).toHaveLength(2);
      expect(byId(rows as Row[])[id('u2')]).toEqual({
        id: id('u2'),
        tags: [],
        tagList: [],
        firstTag: null,
      });
    });

    it.each([
      'nested relationship typed select',
      'nested relationship selectionSet',
    ])('%s', async (shape) => {
      const [u] = await run(shape, strict);
      expect(u.posts).toEqual([{ id: id('p'), words: ['a', 'b', 'a'] }]);
    });

    it('connection edges node', async () => {
      const [u] = await run('connection edges node', strict);
      expect(u.postsConnection).toEqual({
        totalCount: 1,
        edges: [
          {
            properties: { note: 'n1' },
            node: { id: id('p'), words: ['a', 'b', 'a'] },
          },
        ],
      });
    });

    it('typed select connection', async () => {
      const [u] = await run('typed select connection', strict);
      expect(
        (u.postsConnection as { edges: { node: Row }[] }).edges[0].node,
      ).toEqual({ id: id('p'), words: ['a', 'b', 'a'] });
    });

    it('InterfaceModel fragments: each member its own list', async () => {
      const got = byId(await run('InterfaceModel fragments', strict));
      expect(got[id('p')]).toMatchObject({
        __typename: 'ItLfPost',
        words: ['a', 'b', 'a'],
      });
      expect(got[id('nt')]).toMatchObject({
        __typename: 'ItLfNote',
        words: ['c', 'd', 'c', 'd'],
      });
    });

    it('nested interface fragment', async () => {
      const [u] = await run('nested interface fragments', strict);
      const things = byId(u.things as Row[]);
      expect(things[id('p')].words).toEqual(['a', 'b', 'a']);
      expect(things[id('nt')].words ?? null).toBeNull();
    });

    it('nested union fragment', async () => {
      const [u] = await run('nested union fragments', strict);
      const items = byId(u.items as Row[]);
      expect(items[id('p')].words).toEqual(['a', 'b', 'a']);
    });

    it('where compares the whole list', async () => {
      expect(await run('where list equality', strict)).toEqual([
        { id: id('u1') },
      ]);
      expect(await run('where list _IN', strict)).toEqual([{ id: id('u1') }]);
      expect(await run('where through a relationship', strict)).toEqual([
        { id: id('u1') },
      ]);
      expect(await run('count with list where', strict)).toBe(2);
    });

    it('sort by a scalar @cypher field with the list selected', async () => {
      const rows = await run(
        'sort by a scalar @cypher field, list selected',
        strict,
      );
      expect(rows.map((r) => [r.id, r.tags])).toEqual([
        [id('u1'), ['x', 'y', 'x']],
        [id('u2'), []],
      ]);
    });

    it('update response', async () => {
      const res = (await run('update response', strict)) as unknown as {
        itLfUsers: Row[];
      };
      expect(res.itLfUsers).toEqual([{ id: id('u1'), tags: ['x', 'y', 'x'] }]);
    });
  });

  describe('default mode is unchanged and warns', () => {
    it('a one-row-per-element field resolves to a single element', async () => {
      const [u] = await run('root typed select', lenient);
      expect(typeof u.tags).toBe('string');
      // A single list row was already returned whole.
      expect(u.tagList).toEqual(['x', 'y', 'x']);
      expect(u.firstTag).toBe('x');
      const [n] = await run('nested relationship selectionSet', lenient);
      expect(typeof (n.posts as Row[])[0].words).toBe('string');
    });

    it('where on the list never matches (the alias is one element)', async () => {
      expect(await run('where list equality', lenient)).toEqual([]);
    });

    it('logs one cypher-list-field warning per type and field', async () => {
      await run('root typed select', lenient);
      const messages = warn.mock.calls
        .map(([m]) => m as string)
        .filter((m) => m.includes('"ItLfUser.tags"'));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('Enable `strict: true` (default in 3.0)');
    });
  });
});
