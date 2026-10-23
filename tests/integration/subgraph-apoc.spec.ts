/**
 * Live subgraph suite (v2.5.0).
 *
 * Opt-in: runs only when NEO4J_APOC_URI is set, because cloneSubgraph and
 * deleteSubgraph need the APOC plugin and the default live container
 * (NEO4J_URI) has none. Credentials come from NEO4J_APOC_USER and
 * NEO4J_APOC_PASSWORD. Every node it creates carries this run's `runId`
 * and is removed in `afterEach`.
 *
 * Pins two traversal bugs from before v2.5.0:
 * - owned relationships were expanded in BOTH directions, so deleting
 *   Book A climbed from a shared Chapter back up to Book B and deleted it,
 *   and deleting a Chapter deleted its parent Book;
 * - the root was matched with no label, and owned nodes without an `id`
 *   collapsed onto one `null` key in the clone's nodeMapping.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import {
  cloneSubgraph,
  deleteSubgraph,
} from '../../src/subgraph/subgraph-operations';
import { SubgraphConfig } from '../../src/subgraph/types';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_APOC_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

describeLive('subgraph operations — live Neo4j with APOC', () => {
  let driver: Driver;
  let runId: string;

  const bookConfig: SubgraphConfig = {
    ownedLabels: ['LeBook', 'LeChapter'],
    ownedRelationships: ['LE_HAS_CHAPTER'],
    maxLevel: 5,
    referenceRelationships: [],
  };

  async function run(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> {
    const session = driver.session();
    try {
      const res = await session.run(cypher, { ...params, runId });
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  async function inTx<T>(
    fn: (tx: import('neo4j-driver').Transaction) => Promise<T>,
  ): Promise<T> {
    const session = driver.session();
    const tx = session.beginTransaction();
    try {
      const out = await fn(tx);
      await tx.commit();
      return out;
    } catch (e) {
      await tx.rollback();
      throw e;
    } finally {
      await session.close();
    }
  }

  async function ids(label: string): Promise<string[]> {
    const rows = await run(
      `MATCH (n:${label} {runId: $runId}) RETURN n.id AS id ORDER BY id`,
    );
    return rows.map((r) => r.id as string);
  }

  /** Book A and Book B share chapter c-shared; Book A also owns c-a. */
  async function seedSharedChapter(): Promise<void> {
    await run(
      `CREATE (a:LeBook {id: 'book-a', runId: $runId}),
              (b:LeBook {id: 'book-b', runId: $runId}),
              (ca:LeChapter {id: 'c-a', runId: $runId}),
              (cs:LeChapter {id: 'c-shared', runId: $runId}),
              (a)-[:LE_HAS_CHAPTER]->(ca),
              (a)-[:LE_HAS_CHAPTER]->(cs),
              (b)-[:LE_HAS_CHAPTER]->(cs)`,
    );
  }

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_APOC_USER ?? 'neo4j',
        process.env.NEO4J_APOC_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    await driver.verifyConnectivity();
  });

  beforeEach(() => {
    runId = `it-${randomUUID()}`;
  });

  afterEach(async () => {
    await run('MATCH (n {runId: $runId}) DETACH DELETE n');
  });

  afterAll(async () => {
    await driver.close();
  });

  it('deleting Book A leaves Book B, which shares a chapter, in place', async () => {
    await seedSharedChapter();

    await inTx((tx) => deleteSubgraph('book-a', bookConfig, tx));

    expect(await ids('LeBook')).toEqual(['book-b']);
    // The shared chapter is owned by Book A too, so it goes with Book A.
    expect(await ids('LeChapter')).toEqual([]);
  });

  it('deleting a chapter does not delete its parent book', async () => {
    await seedSharedChapter();

    const res = await inTx((tx) =>
      deleteSubgraph('c-a', { ...bookConfig, rootLabel: 'LeChapter' }, tx),
    );

    expect(res.deletedCount).toBe(1);
    expect(await ids('LeBook')).toEqual(['book-a', 'book-b']);
    expect(await ids('LeChapter')).toEqual(['c-shared']);
  });

  it('cloning Book A does not pull in Book B', async () => {
    await seedSharedChapter();

    const res = await inTx((tx) => cloneSubgraph('book-a', bookConfig, tx));

    expect([...res.nodeMapping.keys()].sort()).toEqual([
      'book-a',
      'c-a',
      'c-shared',
    ]);
    expect(await ids('LeBook')).toHaveLength(3); // a, b, clone of a
  });

  it('an incoming owned relationship (<TYPE) traverses child → parent only', async () => {
    await seedSharedChapter();

    const res = await inTx((tx) =>
      deleteSubgraph(
        'c-a',
        {
          ...bookConfig,
          rootLabel: 'LeChapter',
          ownedRelationships: ['<LE_HAS_CHAPTER'],
        },
        tx,
      ),
    );

    // c-a and its parent book-a; the climb stops there because
    // book-a → c-shared is OUTGOING from book-a.
    expect(res.deletedCount).toBe(2);
    expect(await ids('LeBook')).toEqual(['book-b']);
    expect(await ids('LeChapter')).toEqual(['c-shared']);
  });

  it('<TYPE> traverses both directions, as before v2.5.0', async () => {
    await seedSharedChapter();

    await inTx((tx) =>
      deleteSubgraph(
        'book-a',
        { ...bookConfig, ownedRelationships: ['<LE_HAS_CHAPTER>'] },
        tx,
      ),
    );

    expect(await ids('LeBook')).toEqual([]);
  });

  it('the root must carry the root label', async () => {
    // An unrelated node of another label happens to share the id.
    await run(
      `CREATE (:LeBook {id: 'dup', runId: $runId}),
              (:LeOther {id: 'dup', runId: $runId})`,
    );

    const res = await inTx((tx) => deleteSubgraph('dup', bookConfig, tx));

    expect(res.deletedCount).toBe(1);
    expect(await ids('LeOther')).toEqual(['dup']);
  });

  it('refuses to clone when an owned node has no id, and clones nothing', async () => {
    await run(
      `CREATE (a:LeBook {id: 'book-a', runId: $runId}),
              (c1:LeChapter {runId: $runId}),
              (c2:LeChapter {runId: $runId}),
              (a)-[:LE_HAS_CHAPTER]->(c1),
              (a)-[:LE_HAS_CHAPTER]->(c2)`,
    );

    await expect(
      inTx((tx) => cloneSubgraph('book-a', bookConfig, tx)),
    ).rejects.toThrow(/2 owned node\(s\) have no `id`/);

    const rows = await run('MATCH (n {runId: $runId}) RETURN count(n) AS c');
    expect(rows[0].c).toBe(3);
  });

  it('refuses to clone when two owned nodes share an id', async () => {
    await run(
      `CREATE (a:LeBook {id: 'book-a', runId: $runId}),
              (c1:LeChapter {id: 'same', runId: $runId}),
              (c2:LeChapter {id: 'same', runId: $runId}),
              (a)-[:LE_HAS_CHAPTER]->(c1),
              (a)-[:LE_HAS_CHAPTER]->(c2)`,
    );

    await expect(
      inTx((tx) => cloneSubgraph('book-a', bookConfig, tx)),
    ).rejects.toThrow(/1 owned node\(s\) share an `id`/);
  });

  // -------------------------------------------------------------------
  // v2.16.0 — strict item 26: a reference relationship between two owned
  // nodes. APOC clones it clone to clone (subgraphAll returns every
  // relationship among the owned nodes); the 2.x default also re-attaches
  // it from the clone back to the source's original.
  // -------------------------------------------------------------------

  const refConfig = (direction: 'OUT' | 'IN'): SubgraphConfig => ({
    ...bookConfig,
    referenceRelationships: [
      { fromLabel: 'LeChapter', relationshipType: 'LE_NEXT', direction },
      { fromLabel: 'LeChapter', relationshipType: 'LE_LANG', direction: 'OUT' },
    ],
  });

  /** Book A owns c1 → c2 (LE_NEXT); both chapters reference a shared language. */
  async function seedInternalReference(): Promise<void> {
    await run(
      `CREATE (a:LeBook {id: 'book-a', runId: $runId}),
              (c1:LeChapter {id: 'c1', runId: $runId}),
              (c2:LeChapter {id: 'c2', runId: $runId}),
              (en:LeLang {id: 'en', runId: $runId}),
              (a)-[:LE_HAS_CHAPTER]->(c1),
              (a)-[:LE_HAS_CHAPTER]->(c2),
              (c1)-[:LE_NEXT {w: 1}]->(c2),
              (c1)-[:LE_LANG]->(en),
              (c2)-[:LE_LANG]->(en)`,
    );
  }

  /** Every relationship of a type, as `from->to`, a clone written `x'`. */
  async function edges(type: string): Promise<string[]> {
    const rows = await run(
      `MATCH (x {runId: $runId})-[r:${type}]->(y {runId: $runId})
       RETURN coalesce(x.clonedFromId + "'", x.id) + '->' +
              coalesce(y.clonedFromId + "'", y.id) AS e ORDER BY e`,
    );
    return rows.map((r) => r.e as string);
  }

  it.each(['OUT', 'IN'] as const)(
    'strict clones a reference relationship between owned nodes once, clone to clone (%s, v2.16.0)',
    async (direction) => {
      await seedInternalReference();

      await inTx((tx) =>
        cloneSubgraph('book-a', refConfig(direction), tx, undefined, {
          strict: true,
        }),
      );

      expect(await edges('LE_NEXT')).toEqual(["c1'->c2'", 'c1->c2']);
      // A reference to a node outside the subgraph is still re-attached.
      expect(await edges('LE_LANG')).toEqual([
        "c1'->en",
        'c1->en',
        "c2'->en",
        'c2->en',
      ]);
      const props = await run(
        `MATCH (:LeChapter {clonedFromId: 'c1', runId: $runId})-[r:LE_NEXT]->()
         RETURN r.w AS w`,
      );
      expect(props).toEqual([{ w: 1 }]);
    },
  );

  it.each([
    ['OUT', ["c1'->c2", "c1'->c2'", 'c1->c2']],
    ['IN', ["c1'->c2'", 'c1->c2', "c1->c2'"]],
  ] as const)(
    'the default keeps the extra link back into the source and warns once (%s, v2.16.0)',
    async (direction, expected) => {
      await seedInternalReference();
      const warn = jest.fn();
      const logger = { debug: () => {}, warn };

      await inTx((tx) =>
        cloneSubgraph('book-a', refConfig(direction), tx, logger),
      );
      expect(await edges('LE_NEXT')).toEqual(expected);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /reference relationship LE_NEXT .* joins two owned nodes.*`strict: true`/,
      );

      // Warn-once per logger: a second clone does not warn again.
      await inTx((tx) =>
        cloneSubgraph('book-a', refConfig(direction), tx, logger),
      );
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it('OGM.$cloneSubgraph follows new OGM({ strict }) (v2.16.0)', async () => {
    await seedInternalReference();
    const typeDefs = 'type LeBook @node { id: ID! }';
    const warn = jest.fn();
    const logger = { debug: () => {}, warn };

    const strictOgm = new OGM({ typeDefs, driver, logger, strict: true });
    await strictOgm.$cloneSubgraph('book-a', refConfig('OUT'));
    expect(await edges('LE_NEXT')).toEqual(["c1'->c2'", 'c1->c2']);

    const defaultOgm = new OGM({ typeDefs, driver, logger });
    await defaultOgm.$cloneSubgraph('book-a', refConfig('OUT'));
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      expect.stringMatching(/LE_NEXT \(OUT\) from LeChapter joins two owned/),
    ]);
  });

  it('a delete with a root id of another label is a no-op', async () => {
    await seedSharedChapter();

    // 'c-a' is a LeChapter; the default root label is LeBook.
    const res = await inTx((tx) => deleteSubgraph('c-a', bookConfig, tx));

    expect(res.deletedCount).toBe(0);
    expect(await ids('LeChapter')).toEqual(['c-a', 'c-shared']);
  });
});
