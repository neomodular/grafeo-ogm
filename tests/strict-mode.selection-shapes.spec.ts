/**
 * v2.8.0 — a KNOWN field selected in the wrong shape: a scalar given a
 * sub-selection (left out of the result) or a relationship / connection
 * without one (projected as a raw property, null). Like the 2.6.3
 * unknown-field check: default mode keeps the v2.7.0 Cypher (pinned in
 * `read-ignored-inputs.byte-identical.spec.ts`) and warns once per type +
 * field; `strict: true` throws an `OGMError` naming the type, the field and
 * the expected shape. Shapes that work never warn.
 */
import { OGMError } from '../src/errors';
import { Model } from '../src/model';
import {
  harness,
  type ModelOf,
} from './read-ignored-inputs.byte-identical.cases';

beforeEach(() => Model.clearSelectionCache());

const find =
  (selectionSet: string, type = 'LbUser') =>
  (m: ModelOf) =>
    m(type).find({ selectionSet });
const typed = (select: Record<string, unknown>) => (m: ModelOf) =>
  m('LbUser').find({ select } as never);

const SCALAR = (type: string, field: string, t: string) =>
  `Field "${field}" in selectionSet on type "${type}" is a scalar field (${t}) and takes no sub-selection: select it as "${field}".`;

const CASES: Array<{
  label: string;
  run: (m: ModelOf) => Promise<unknown>;
  /** The strict error; the warning carries the same type / field / shape. */
  error: string;
  /** What 2.x does, as the warning says. */
  outcome: string;
}> = [
  {
    label: 'scalar with a sub-selection',
    run: find('{ id name { x } }'),
    error: SCALAR('LbUser', 'name', 'String'),
    outcome: '2.x leaves it out of the result.',
  },
  {
    label: 'nested scalar with a sub-selection',
    run: find('{ posts { id title { x } } }'),
    error: SCALAR('LbPost', 'title', 'String'),
    outcome: '2.x leaves it out of the result.',
  },
  {
    label: 'connection node scalar with a sub-selection',
    run: find('{ postsConnection { edges { node { rank { x } } } } }'),
    error: SCALAR('LbPost', 'rank', 'Int'),
    outcome: '2.x leaves it out of the result.',
  },
  {
    label: 'union member scalar with a sub-selection',
    run: find('{ items { ... on LbPost { title { x } } } }'),
    error: SCALAR('LbPost', 'title', 'String'),
    outcome: '2.x leaves it out of the result.',
  },
  {
    label: 'interface scalar with a sub-selection',
    run: find('{ things { rank { x } } }'),
    error: SCALAR('LbThing', 'rank', 'Int'),
    outcome: '2.x leaves it out of the result.',
  },
  {
    label: 'edge property with a sub-selection',
    run: find('{ postsConnection { edges { properties { stars { x } } } } }'),
    error:
      'Field "stars" in selectionSet on relationship properties type "LbWrote" is a scalar field (Int) and takes no sub-selection: select it as "stars".',
    outcome: '2.x leaves it out of the result.',
  },
  {
    label: 'relationship without a sub-selection',
    run: find('{ id posts }'),
    error:
      'Field "posts" in selectionSet on type "LbUser" is a relationship to LbPost and needs a sub-selection, e.g. "posts { … }".',
    outcome:
      '2.x projects it as a raw node property (null unless one is stored).',
  },
  {
    label: 'singular relationship without a sub-selection',
    run: find('{ id author }', 'LbPost'),
    error:
      'Field "author" in selectionSet on type "LbPost" is a relationship to LbUser and needs a sub-selection, e.g. "author { … }".',
    outcome:
      '2.x projects it as a raw node property (null unless one is stored).',
  },
  {
    label: 'union member relationship without a sub-selection',
    run: find('{ items { ... on LbPost { author } } }'),
    error:
      'Field "author" in selectionSet on type "LbPost" is a relationship to LbUser and needs a sub-selection, e.g. "author { … }".',
    outcome:
      '2.x projects it as a raw node property (null unless one is stored).',
  },
  {
    label: 'connection without a sub-selection',
    run: find('{ id postsConnection }'),
    error:
      'Field "postsConnection" in selectionSet on type "LbUser" is a connection and needs a sub-selection, e.g. "postsConnection { edges { node { … } } }".',
    outcome:
      '2.x projects it as a raw node property (null unless one is stored).',
  },
  {
    label: 'typed: scalar given an object',
    run: typed({ id: true, name: { select: { x: true } } }),
    error:
      'Field "name" in select on type "LbUser" is a scalar field (String): select it with `name: true`.',
    outcome: '2.x leaves it out of the result.',
  },
  {
    label: 'typed: relationship given a number',
    run: typed({ id: true, posts: 1 }),
    error:
      'Field "posts" in select on type "LbUser" is a relationship to LbPost: select it with `posts: true` (all scalar fields) or `posts: { select: { … }, where?, orderBy? }`.',
    outcome: '2.x leaves it out of the result.',
  },
  {
    label: 'typed: relationship object with an unknown key',
    run: typed({ id: true, posts: { selct: { id: true } } }),
    error:
      'Field "posts" in select on type "LbUser" is a relationship to LbPost and takes `select`, `where` and `orderBy`, not "selct".',
    outcome: '2.x leaves it out of the result.',
  },
  {
    label: 'typed: relationship object with a known and an unknown key',
    run: typed({ posts: { select: { id: true }, wehre: { title: 'a' } } }),
    error:
      'Field "posts" in select on type "LbUser" is a relationship to LbPost and takes `select`, `where` and `orderBy`, not "wehre".',
    outcome: '2.x ignores the unknown key.',
  },
  {
    label: 'typed: edge property given an object',
    run: typed({
      postsConnection: {
        select: { edges: { properties: { select: { stars: { x: 1 } } } } },
      },
    }),
    error:
      'Field "stars" in select on relationship properties type "LbWrote" is a scalar field (Int): select it with `stars: true`.',
    outcome: '2.x leaves it out of the result.',
  },
  // v2.23.0 — connection select shapes (silently dropped before v2.23.0).
  {
    label: 'typed: connection given a number',
    run: typed({ postsConnection: 1 }),
    error:
      'Field "postsConnection" in select on type "LbUser" is a connection of LbPost: select it with `postsConnection: true` or `postsConnection: { select: { edges: { node, properties, cursor }, totalCount, pageInfo }, where?, orderBy? }`.',
    outcome: '2.x returns every edge as an empty object.',
  },
  {
    label: 'typed: connection object with an unknown key',
    run: typed({ postsConnection: { selct: { edges: true } } }),
    error:
      'Field "postsConnection" in select on type "LbUser" is a connection of LbPost and takes `select` (required), `where` and `orderBy`, not "selct".',
    outcome: '2.x returns every edge as an empty object.',
  },
  {
    label: 'typed: connection object with select and an unknown key',
    run: typed({ postsConnection: { select: { edges: true }, first: 2 } }),
    error:
      'Field "postsConnection" in select on type "LbUser" is a connection of LbPost and takes `select` (required), `where` and `orderBy`, not "first".',
    outcome: '2.x ignores the unknown key.',
  },
  {
    label: 'typed: connection without select',
    run: typed({ postsConnection: { where: { node: { title: 'a' } } } }),
    error:
      'Field "postsConnection" in select on type "LbUser" is a connection of LbPost and takes `select` (required), `where` and `orderBy`.',
    outcome: '2.x returns every edge as an empty object.',
  },
  {
    label: 'typed: connection totalCount given an object',
    run: typed({
      postsConnection: { select: { totalCount: { select: {} }, edges: true } },
    }),
    error:
      'Field "totalCount" in select on type "LbUserPostsConnection" is a scalar field (Int!): select it with `totalCount: true`.',
    outcome: '2.x leaves it out of the result.',
  },
  {
    label: 'typed: connection edges given a number',
    run: typed({ postsConnection: { select: { edges: 1 } } }),
    error:
      'Field "edges" in select on type "LbUserPostsConnection" is a list of edges: select it with `edges: true` or `edges: { node, properties, cursor }`.',
    outcome: '2.x returns every edge as an empty object.',
  },
  {
    label: 'typed: connection edge node without select',
    run: typed({
      postsConnection: { select: { edges: { node: { title: true } } } },
    }),
    error:
      'Field "node" in select on type "LbUserPostsRelationship" is the LbPost node and takes only `select`, not "title": select it with `node: true` (all scalar fields) or `node: { select: { … } }`.',
    outcome: '2.x leaves it out of the result.',
  },
  {
    label: 'typed: connection edge node with select and an unknown key',
    run: typed({
      postsConnection: {
        select: {
          edges: {
            node: { select: { id: true }, where: { title: 'a' } },
          },
        },
      },
    }),
    error:
      'Field "node" in select on type "LbUserPostsRelationship" is the LbPost node and takes only `select`, not "where": select it with `node: true` (all scalar fields) or `node: { select: { … } }`.',
    outcome: '2.x ignores the unknown key.',
  },
  {
    label: 'typed: connection edge properties given a string',
    run: typed({
      postsConnection: { select: { edges: { properties: 'stars' } } },
    }),
    error:
      'Field "properties" in select on type "LbUserPostsRelationship" is the relationship properties (LbWrote): select it with `properties: true` (all scalar fields) or `properties: { select: { … } }`.',
    outcome: '2.x leaves it out of the result.',
  },
];

/** v2.23.0 — keys a connection's `select` / `edges` does not take. */
const UNKNOWN_CONNECTION_KEYS: Array<{
  label: string;
  run: (m: ModelOf) => Promise<unknown>;
  error: string;
}> = [
  {
    label: 'edges wrapped in select',
    run: typed({
      postsConnection: {
        select: {
          edges: {
            select: {
              node: { select: { title: true } },
              properties: { select: { stars: true } },
            },
          },
        },
      },
    }),
    error:
      'Unknown field "select" in select on type "LbUserPostsRelationship". `node`, `properties` and `cursor` go directly under `edges`, without a `select`: `edges: { node: { select: { … } }, properties: { select: { … } } }`.',
  },
  {
    label: 'unknown key in the connection select',
    run: typed({ postsConnection: { select: { edgs: true } } }),
    error: 'Unknown field "edgs" in select on type "LbUserPostsConnection".',
  },
  {
    label: 'node directly under the connection select',
    run: typed({ postsConnection: { select: { node: true } } }),
    error:
      'Unknown field "node" in select on type "LbUserPostsConnection". "node" is a field of each edge: `select: { edges: { node: … } }`.',
  },
  {
    label: 'unknown key in edges',
    run: typed({ postsConnection: { select: { edges: { nod: true } } } }),
    error: 'Unknown field "nod" in select on type "LbUserPostsRelationship".',
  },
];

describe('v2.23.0 — unknown keys in a typed connection select', () => {
  it.each(UNKNOWN_CONNECTION_KEYS.map((c) => [c.label, c] as const))(
    'default: %s warns once, output unchanged',
    async (_label, c) => {
      const h = harness();
      await c.run(h.model);
      await c.run(h.model);
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      const [, field, owner] = c.error.match(
        /^Unknown field "([^"]+)" in select on (type "[^"]+")/,
      )!;
      expect(String(h.logger.warn.mock.calls[0][0])).toContain(
        `selects "${field}", which is not a field of ${owner}; 2.x leaves it out of the result.`,
      );
    },
  );

  it.each(UNKNOWN_CONNECTION_KEYS.map((c) => [c.label, c] as const))(
    'strict: %s throws',
    async (_label, c) => {
      const h = harness({ strict: true });
      await expect(c.run(h.model)).rejects.toThrow(new OGMError(c.error));
      expect(h.logger.warn).not.toHaveBeenCalled();
    },
  );
});

describe('known fields in the wrong shape — default mode', () => {
  it.each(CASES.map((c) => [c.label, c] as const))(
    '%s: one warning',
    async (_label, c) => {
      const h = harness();
      await c.run(h.model);
      await c.run(h.model); // cached parse, same OGM: still one warning
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      const message = String(h.logger.warn.mock.calls[0][0]);
      const [, field, owner, shape] = c.error.match(
        /^Field "([^"]+)" in \w+ on (.+?) ((?:is|takes).*)\.$/,
      )!;
      expect(message).toContain(
        `selects "${field}" on ${owner} in the wrong shape: it ${shape}; ${c.outcome}`,
      );
      expect(message).toContain('Enable `strict: true` (default in 3.0)');
    },
  );
});

describe('known fields in the wrong shape — strict: true', () => {
  it.each(CASES.map((c) => [c.label, c] as const))(
    '%s: throws',
    async (_label, c) => {
      const h = harness({ strict: true });
      await expect(c.run(h.model)).rejects.toThrow(new OGMError(c.error));
      expect(h.logger.warn).not.toHaveBeenCalled();
    },
  );
});

describe('shapes that work never warn', () => {
  it.each([
    ['relationship with a sub-selection', find('{ posts { id } }')],
    [
      'connection with a sub-selection',
      find('{ postsConnection { totalCount } }'),
    ],
    ['aggregate', find('{ postsAggregate { count } }')],
    ['typed relationship true (all scalars)', typed({ posts: true })],
    [
      'typed singular relationship true',
      (m: ModelOf) => m('LbPost').find({ select: { author: true } } as never),
    ],
    [
      'typed relationship where only',
      typed({ posts: { where: { title: 'a' } } }),
    ],
    ['typed connection true', typed({ postsConnection: true })],
    [
      'typed connection, every documented key',
      typed({
        postsConnection: {
          where: { node: { title: 'a' } },
          orderBy: [{ edge: { stars: 'DESC' } }],
          select: {
            totalCount: true,
            pageInfo: { select: { hasNextPage: true } },
            edges: {
              cursor: true,
              node: { select: { id: true } },
              properties: { select: { stars: true } },
            },
          },
        },
      }),
    ],
    [
      'typed connection true / false / null parts',
      typed({
        postsConnection: {
          select: {
            totalCount: false,
            pageInfo: null,
            edges: { node: true, properties: true, cursor: false },
          },
        },
      }),
    ],
    ['typed scalar false / null', typed({ id: true, name: false, big: null })],
  ] as const)('%s', async (_label, run) => {
    for (const strict of [false, true]) {
      const h = harness({ strict });
      await run(h.model);
      expect(h.logger.warn).not.toHaveBeenCalled();
    }
  });
});

describe('typed relationship {} (v2.8.0)', () => {
  it('default: left out as in v2.7.0, warned once', async () => {
    const a = harness();
    await typed({ id: true, posts: {} })(a.model);
    await typed({ id: true, posts: {} })(a.model);
    const b = harness();
    await typed({ id: true })(b.model);
    expect(a.last().cypher).toBe(b.last().cypher);
    expect(a.logger.warn).toHaveBeenCalledTimes(1);
    expect(String(a.logger.warn.mock.calls[0][0])).toContain(
      'Typed select `posts: {}` (a relationship to LbPost) is left out of the result.',
    );
  });

  it('strict: selects every scalar of the target, like `true`', async () => {
    const a = harness({ strict: true });
    await typed({ id: true, posts: {} })(a.model);
    const b = harness({ strict: true });
    await typed({ id: true, posts: true })(b.model);
    expect(a.last().cypher).toBe(b.last().cypher);
    expect(a.logger.warn).not.toHaveBeenCalled();
  });
});
