/**
 * v2.7.1 — a KNOWN field selected in the wrong shape: a scalar given a
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
];

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
    ['typed scalar false / null', typed({ id: true, name: false, big: null })],
    ['typed relationship {}', typed({ posts: {} })],
  ] as const)('%s', async (_label, run) => {
    for (const strict of [false, true]) {
      const h = harness({ strict });
      await run(h.model);
      expect(h.logger.warn).not.toHaveBeenCalled();
    }
  });
});

describe('typed relationship {} (v2.7.1)', () => {
  it('selects every scalar of the target, like `true`', async () => {
    const a = harness();
    await typed({ id: true, posts: {} })(a.model);
    const b = harness();
    await typed({ id: true, posts: true })(b.model);
    expect(a.last().cypher).toBe(b.last().cypher);
  });
});
