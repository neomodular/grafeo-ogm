/**
 * Live: OGM features that need APOC, on a server with and without it (vNEXT).
 *
 * Opt-in on NEO4J_URI. The suite probes the server (`RETURN apoc.version()`)
 * and checks whichever case it gets, so it runs (and is never skipped) both
 * on the default local container (no APOC) and on CI's live service (APOC):
 * - without APOC, a nested relationship sort, a typed `orderBy` and a
 *   connection `sort` throw an `OGMError` that names the feature and APOC
 *   (pre-vNEXT: Neo4j's raw `Unknown function 'apoc.coll.sortMulti'`), and
 *   `cloneSubgraph` / `deleteSubgraph` say that they need APOC;
 * - with APOC, the same calls sort / run.
 * The mapping itself is also pinned by a mock test
 * (tests/executor-missing-apoc.spec.ts). Every node it creates carries
 * this run's `runId` and is removed in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError, SubgraphOperationError } from '../../src/errors';
import { permissive } from '../../src/policy/types';
import {
  cloneSubgraph,
  deleteSubgraph,
} from '../../src/subgraph/subgraph-operations';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItMaBook @node {
    id: ID! @unique
    runId: String
    title: String
    chapters: [ItMaChapter!]!
      @relationship(type: "IT_MA_HAS", properties: "ItMaHas", direction: OUT)
  }
  type ItMaChapter @node {
    id: ID! @unique
    runId: String
    title: String
  }
  type ItMaHas @relationshipProperties {
    position: Int
  }
`;

type Row = Record<string, unknown>;

const policies = {
  ItMaBook: [
    permissive({
      operations: ['read'],
      when: (c) => ({ runId: c.runId as string }),
    }),
  ],
  ItMaChapter: [
    permissive({
      operations: ['read'],
      when: (c) => ({ runId: c.runId as string }),
    }),
  ],
};

describeLive('features that need APOC — live Neo4j', () => {
  let driver: Driver;
  let hasApoc: boolean;
  const runId = `it-ma-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;

  async function run(cypher: string, params: Row = {}): Promise<Row[]> {
    const session = driver.session();
    try {
      const res = await session.run(cypher, { ...params, runId });
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    await driver.verifyConnectivity();
    hasApoc = await run('RETURN apoc.version() AS v').then(
      () => true,
      () => false,
    );
    await run(
      `CREATE (b:ItMaBook {id: $b, runId: $runId, title: 'B'})
       CREATE (b)-[:IT_MA_HAS {position: 2}]->(:ItMaChapter {id: $c1, runId: $runId, title: 'b'})
       CREATE (b)-[:IT_MA_HAS {position: 1}]->(:ItMaChapter {id: $c2, runId: $runId, title: 'a'})
       CREATE (b)-[:IT_MA_HAS {position: 3}]->(:ItMaChapter {id: $c3, runId: $runId, title: 'c'})`,
      { b: id('b'), c1: id('c1'), c2: id('c2'), c3: id('c3') },
    );
  });

  afterAll(async () => {
    if (!driver) return;
    await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
    await driver.close();
  });

  /** Asserts the missing-APOC OGMError, with the Neo4j error as `cause`. */
  async function expectMissingApoc(call: Promise<unknown>): Promise<void> {
    const err = await call.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OGMError);
    const e = err as OGMError;
    expect(e.message).toMatch(/needs the APOC plugin/);
    expect(e.message).toMatch(/apoc\.coll\.sortMulti/);
    expect(e.message).toMatch(/Sorting a relationship field or a connection/);
    expect(e.message).toMatch(/#does-grafeo-ogm-work-with-neo4j-aura/);
    expect((e.cause as { code?: string }).code).toBe(
      'Neo.ClientError.Statement.SyntaxError',
    );
    expect((e.cause as Error).message).toMatch(
      /^Unknown function 'apoc\.coll\.sortMulti'/,
    );
  }

  describe.each([
    ['default', undefined, false],
    ['strict', true, false],
    ['default + policies', undefined, true],
    ['strict + policies', true, true],
  ])('%s', (_label, strict, withPolicies) => {
    const books = () => {
      const ogm = new OGM({
        typeDefs,
        driver,
        strict,
        logger: { warn: () => undefined, debug: () => undefined },
        ...(withPolicies ? { policies } : {}),
      });
      return withPolicies
        ? ogm.withContext({ runId }).model('ItMaBook')
        : ogm.model('ItMaBook');
    };
    const titles = (rows: unknown, key: string) =>
      ((rows as Row[])[0][key] as Row[]).map((c) =>
        'node' in c ? (c.node as Row).title : c.title,
      );

    it('a selectionSet relationship options.sort', async () => {
      const call = books().find({
        where: { id: id('b') },
        selectionSet:
          '{ id chapters(options: { sort: [{ title: ASC }] }) { title } }',
      });
      if (!hasApoc) return expectMissingApoc(call);
      expect(titles(await call, 'chapters')).toEqual(['a', 'b', 'c']);
    });

    it('a typed relationship orderBy', async () => {
      const call = books().find({
        where: { id: id('b') },
        select: {
          id: true,
          chapters: { select: { title: true }, orderBy: { title: 'DESC' } },
        },
      });
      if (!hasApoc) return expectMissingApoc(call);
      expect(titles(await call, 'chapters')).toEqual(['c', 'b', 'a']);
    });

    it('a selectionSet connection sort', async () => {
      const call = books().find({
        where: { id: id('b') },
        selectionSet:
          '{ id chaptersConnection(sort: [{ edge: { position: DESC } }]) { edges { node { title } } } }',
      });
      if (!hasApoc) return expectMissingApoc(call);
      const edges = ((await call) as Row[])[0].chaptersConnection as {
        edges: Row[];
      };
      expect(edges.edges.map((e) => (e.node as Row).title)).toEqual([
        'c',
        'b',
        'a',
      ]);
    });

    it('a root sort needs no APOC', async () => {
      const rows = await books().find({
        where: { id: id('b') },
        selectionSet: '{ title }',
        options: { sort: [{ title: 'ASC' }] },
      });
      expect(rows).toEqual([{ title: 'B' }]);
    });
  });

  describe('subgraph operations', () => {
    const config = {
      ownedLabels: ['ItMaBook', 'ItMaChapter'],
      ownedRelationships: ['IT_MA_HAS'],
      maxLevel: 2,
      referenceRelationships: [],
    };

    async function inRolledBackTx<T>(
      fn: (tx: import('neo4j-driver').Transaction) => Promise<T>,
    ): Promise<T> {
      const session = driver.session();
      const tx = session.beginTransaction();
      try {
        return await fn(tx);
      } finally {
        if (tx.isOpen()) await tx.rollback();
        await session.close();
      }
    }

    it.each(['clone', 'delete'] as const)('%sSubgraph', async (op) => {
      const err = await inRolledBackTx<unknown>((tx) =>
        op === 'clone'
          ? cloneSubgraph(id('b'), config, tx)
          : deleteSubgraph(id('b'), config, tx),
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      if (hasApoc) {
        // Rolled back: the subgraph ran against APOC, nothing persisted.
        expect(err).toBeUndefined();
        return;
      }
      expect(err).toBeInstanceOf(SubgraphOperationError);
      const e = err as SubgraphOperationError;
      expect(e.message).toMatch(
        new RegExp(`${op}Subgraph needs the APOC plugin`),
      );
      expect(e.message).toMatch(/#does-grafeo-ogm-work-with-neo4j-aura/);
      expect((e.cause as { code?: string }).code).toBe(
        'Neo.ClientError.Procedure.ProcedureNotFound',
      );
    });
  });
});
