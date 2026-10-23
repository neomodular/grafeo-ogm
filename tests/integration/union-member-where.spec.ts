/**
 * Live: a union MEMBER key in a where on a union target (v2.12.0).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed in `afterAll`.
 *
 * `items: { where: { ItUmDoc: { rank: 2 } } }`, `itemsConnection` with
 * `{ node: { ItUmDoc: … } }` (the generated shape) or the upstream
 * `{ ItUmDoc: { node: … } }`, in a selection or a root filter, filters by
 * the member, with each member's read policy, in default and strict mode
 * alike. Pre-2.12.0 the member key compiled as a node property, so the
 * list was always empty and `_NONE` / `_NOT` matched every user (the
 * upstream shape in a root filter was ignored).
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { Model } from '../../src/model';
import { OGM } from '../../src/ogm';
import { permissive, restrictive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(120_000);

const typeDefs = /* GraphQL */ `
  interface ItUmThing {
    id: ID!
    runId: String
    rank: Int
  }
  union ItUmItem = ItUmPost | ItUmDoc
  type ItUmUser @node {
    id: ID! @unique
    runId: String
    name: String
    items: [ItUmItem!]! @relationship(type: "IT_UM_HAS_ITEM", direction: OUT)
    things: [ItUmThing!]! @relationship(type: "IT_UM_HAS_THING", direction: OUT)
  }
  type ItUmPost implements ItUmThing @node {
    id: ID! @unique
    runId: String
    rank: Int
    title: String
    secret: Boolean
  }
  type ItUmDoc implements ItUmThing @node {
    id: ID! @unique
    runId: String
    rank: Int
    body: String
  }
`;

const policies = {
  ItUmPost: [
    permissive({ operations: ['read'], name: 'post.read', when: () => ({}) }),
    restrictive({
      operations: ['read'],
      name: 'post.no-secret',
      when: () => ({ secret: false }),
    }),
  ],
};

type Row = Record<string, unknown>;

describeLive('union member where — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const id = (s: string) => `${runId}-${s}`;
  const strip = (v: unknown): unknown =>
    JSON.parse(JSON.stringify(v).split(`${runId}-`).join(''));
  let driver: Driver;

  function make(opts: { strict?: boolean; secured?: boolean } = {}) {
    const logger = { debug: jest.fn(), warn: jest.fn() };
    const ogm = new OGM({
      typeDefs,
      driver,
      logger,
      ...(opts.strict ? { strict: true } : {}),
      ...(opts.secured ? { policies } : {}),
    });
    const bound = opts.secured ? ogm.withContext({}) : ogm;
    return { logger, user: bound.model('ItUmUser') };
  }

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
      // Alice → p1 (post, rank 1), d1 (doc, rank 2); bob → p2 (SECRET post,
      // rank 2); Carol → nothing.
      await session.run(
        `CREATE (u1:ItUmUser {id: $runId + '-u1', runId: $runId, name: 'Alice'})
         CREATE (u2:ItUmUser {id: $runId + '-u2', runId: $runId, name: 'bob'})
         CREATE (:ItUmUser {id: $runId + '-u3', runId: $runId, name: 'Carol'})
         CREATE (p1:ItUmPost {id: $runId + '-p1', runId: $runId, rank: 1, title: 'p', secret: false})
         CREATE (p2:ItUmPost {id: $runId + '-p2', runId: $runId, rank: 2, title: 's', secret: true})
         CREATE (d1:ItUmDoc {id: $runId + '-d1', runId: $runId, rank: 2, body: 'd'})
         CREATE (u1)-[:IT_UM_HAS_ITEM]->(p1) CREATE (u1)-[:IT_UM_HAS_ITEM]->(d1)
         CREATE (u2)-[:IT_UM_HAS_ITEM]->(p2)
         CREATE (u1)-[:IT_UM_HAS_THING]->(p1) CREATE (u1)-[:IT_UM_HAS_THING]->(d1)`,
        { runId },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (driver) {
      const session = driver.session();
      try {
        await session.run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n', {
          runId,
        });
      } finally {
        await session.close();
      }
      await driver.close();
    }
  });

  beforeEach(() => Model.clearSelectionCache());

  const DOC2 = { ItUmDoc: { rank: 2 } };

  /** Alice's projection of `select` / `selectionSet`, run ids stripped. */
  async function alice(
    user: Model,
    args: { select?: Row; selectionSet?: string },
  ): Promise<Row> {
    const rows = (await user.find({
      where: { id: id('u1') },
      ...args,
    } as never)) as Row[];
    expect(rows).toHaveLength(1);
    return strip(rows[0]) as Row;
  }

  /** Names of the users matching a root `where`, sorted. */
  async function names(user: Model, where: Row): Promise<string[]> {
    const rows = (await user.find({
      where: { runId, ...where },
      selectionSet: '{ name }',
    })) as Row[];
    return rows.map((r) => r.name as string).sort();
  }

  const SELECTIONS: Array<
    [string, { select?: Row; selectionSet?: string }, Row]
  > = [
    [
      'typed select items where',
      { select: { items: { where: DOC2, select: { id: true } } } },
      { items: [{ __typename: 'ItUmDoc', id: 'd1' }] },
    ],
    [
      'selectionSet items(where)',
      {
        selectionSet:
          '{ items(where: { ItUmDoc: { rank: 2 } }) { ... on ItUmDoc { id } ... on ItUmPost { id } } }',
      },
      { items: [{ __typename: 'ItUmDoc', id: 'd1' }] },
    ],
    [
      'typed select itemsConnection where { node }',
      {
        select: {
          itemsConnection: {
            where: { node: DOC2 },
            select: {
              totalCount: true,
              edges: { node: { select: { id: true } } },
            },
          },
        },
      },
      {
        itemsConnection: {
          totalCount: 1,
          edges: [{ node: { __typename: 'ItUmDoc', id: 'd1' } }],
        },
      },
    ],
    [
      'selectionSet itemsConnection(where: { node })',
      {
        selectionSet:
          '{ itemsConnection(where: { node: { ItUmDoc: { rank: 2 } } }) { totalCount edges { node { ... on ItUmDoc { id } } } } }',
      },
      {
        itemsConnection: {
          totalCount: 1,
          edges: [{ node: { __typename: 'ItUmDoc', id: 'd1' } }],
        },
      },
    ],
    [
      'selectionSet itemsConnection(where: { node_NOT })',
      {
        selectionSet:
          '{ itemsConnection(where: { node_NOT: { ItUmDoc: { rank: 2 } } }) { totalCount } }',
      },
      { itemsConnection: { totalCount: 1 } },
    ],
    [
      'selectionSet itemsConnection upstream { ItUmDoc: { node } }',
      {
        selectionSet:
          '{ itemsConnection(where: { ItUmDoc: { node: { rank: 2 } } }) { totalCount } }',
      },
      { itemsConnection: { totalCount: 1 } },
    ],
    [
      'typed select items where, two members',
      {
        select: {
          items: {
            where: { ItUmDoc: { rank: 2 }, ItUmPost: { rank: 1 } },
            select: { id: true },
          },
        },
      },
      {
        items: [
          { __typename: 'ItUmDoc', id: 'd1' },
          { __typename: 'ItUmPost', id: 'p1' },
        ],
      },
    ],
  ];

  // Pre-2.12.0 every one of these was empty (`items: []`, `totalCount: 0`):
  // `n0.ItUmDoc = $p` is null, and so is its negation.
  describe.each(SELECTIONS)('%s', (_label, args, expected) => {
    it.each([false, true])(
      'the member filter applies (strict: %s), no warning',
      async (strict) => {
        const { user, logger } = make({ strict });
        const row = await alice(user, args);
        if (Array.isArray(row.items))
          (row.items as Row[]).sort((a, b) =>
            String(a.id).localeCompare(String(b.id)),
          );
        expect(row).toEqual(expected);
        expect(logger.warn).not.toHaveBeenCalled();
      },
    );
  });

  const ROOTS: Array<[string, Row, string[], string[]]> = [
    // label, where, result, pre-2.12.0 result (documentation only)
    [
      'itemsConnection_SOME { node }',
      { itemsConnection_SOME: { node: DOC2 } },
      ['Alice'],
      [],
    ],
    [
      'itemsConnection { node }',
      { itemsConnection: { node: DOC2 } },
      ['Alice'],
      [],
    ],
    [
      'itemsConnection_NONE { node }',
      { itemsConnection_NONE: { node: DOC2 } },
      ['Carol', 'bob'],
      ['Alice', 'Carol', 'bob'],
    ],
    [
      'itemsConnection_NOT { node }',
      { itemsConnection_NOT: { node: DOC2 } },
      ['Carol', 'bob'],
      ['Alice', 'Carol', 'bob'],
    ],
    [
      'itemsConnection_SINGLE { node }',
      { itemsConnection_SINGLE: { node: DOC2 } },
      ['Alice'],
      [],
    ],
    [
      'itemsConnection_ALL { node }',
      { itemsConnection_ALL: { node: DOC2 } },
      ['Carol'],
      ['Alice', 'Carol', 'bob'],
    ],
    [
      'itemsConnection_SOME { node_NOT }',
      { itemsConnection_SOME: { node_NOT: DOC2 } },
      ['Alice', 'bob'],
      [],
    ],
    [
      'itemsConnection_SOME upstream { ItUmDoc: { node } }',
      { itemsConnection_SOME: { ItUmDoc: { node: { rank: 2 } } } },
      ['Alice'],
      ['Alice', 'bob'],
    ],
    [
      'itemsConnection_SOME upstream, no match',
      { itemsConnection_SOME: { ItUmDoc: { node: { rank: 99 } } } },
      [],
      ['Alice', 'bob'],
    ],
    [
      'itemsConnection_NONE upstream',
      { itemsConnection_NONE: { ItUmDoc: { node: { rank: 2 } } } },
      ['Carol', 'bob'],
      ['Carol'],
    ],
  ];

  describe.each(ROOTS)('root %s', (_label, where, result) => {
    it.each([false, true])('strict: %s', async (strict) => {
      const { user, logger } = make({ strict });
      expect(await names(user, where)).toEqual(result);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  // Already worked before 2.12.0 (a root `items_SOME` has always compiled
  // per member): pinned in both modes.
  describe.each([false, true])(
    'root items_* member key (strict: %s)',
    (strict) => {
      it('matches by member', async () => {
        const { user, logger } = make({ strict });
        expect(await names(user, { items_SOME: DOC2 })).toEqual(['Alice']);
        expect(await names(user, { items_NONE: DOC2 })).toEqual([
          'Carol',
          'bob',
        ]);
        expect(
          await names(user, { items_SOME: { ItUmPost: { rank: 2 } } }),
        ).toEqual(['bob']);
        expect(logger.warn).not.toHaveBeenCalled();
      });
    },
  );

  describe.each([false, true])(
    'the member read policy (strict: %s)',
    (strict) => {
      const SECRET2 = { ItUmPost: { rank: 2 } };

      it('a hidden member node is not returned by a nested where', async () => {
        const open = make({ strict }).user;
        const secured = make({ strict, secured: true }).user;
        const select = { items: { where: SECRET2, select: { id: true } } };
        const run = async (user: Model) =>
          strip(await user.find({ where: { id: id('u2') }, select } as never));
        expect(await run(open)).toEqual([
          { items: [{ __typename: 'ItUmPost', id: 'p2' }] },
        ]);
        expect(await run(secured)).toEqual([{ items: [] }]);
      });

      it('a hidden member node does not count in a connection totalCount', async () => {
        const selectionSet =
          '{ itemsConnection(where: { node: { ItUmPost: { rank: 2 } } }) { totalCount } }';
        const run = async (user: Model) =>
          strip(await user.find({ where: { id: id('u2') }, selectionSet }));
        expect(await run(make({ strict }).user)).toEqual([
          { itemsConnection: { totalCount: 1 } },
        ]);
        expect(await run(make({ strict, secured: true }).user)).toEqual([
          { itemsConnection: { totalCount: 0 } },
        ]);
      });

      it('root _SOME / _NONE judge visible member nodes only', async () => {
        const open = make({ strict }).user;
        const secured = make({ strict, secured: true }).user;
        const some = { itemsConnection_SOME: { node: SECRET2 } };
        const none = { itemsConnection_NONE: { node: SECRET2 } };
        const upstream = {
          itemsConnection_SOME: { ItUmPost: { node: { rank: 2 } } },
        };
        expect(await names(open, some)).toEqual(['bob']);
        expect(await names(secured, some)).toEqual([]);
        expect(await names(open, none)).toEqual(['Alice', 'Carol']);
        expect(await names(secured, none)).toEqual(['Alice', 'Carol', 'bob']);
        expect(await names(open, upstream)).toEqual(['bob']);
        expect(await names(secured, upstream)).toEqual([]);
      });
    },
  );

  // An interface target has no member keys in its generated where (only
  // the interface's own fields), so it never had this bug: pinned here in
  // both modes.
  describe.each([false, true])('interface target (strict: %s)', (strict) => {
    it('nested, connection and root filters match', async () => {
      const { user, logger } = make({ strict });
      expect(
        await alice(user, {
          select: {
            things: { where: { rank: 2 }, select: { id: true } },
            thingsConnection: {
              where: { node: { rank: 2 } },
              select: { totalCount: true },
            },
          },
        }),
      ).toEqual({
        things: [{ __typename: 'ItUmDoc', id: 'd1' }],
        thingsConnection: { totalCount: 1 },
      });
      expect(
        await names(user, { thingsConnection_SOME: { node: { rank: 2 } } }),
      ).toEqual(['Alice']);
      expect(
        await names(user, { thingsConnection_NONE: { node: { rank: 2 } } }),
      ).toEqual(['Carol', 'bob']);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
