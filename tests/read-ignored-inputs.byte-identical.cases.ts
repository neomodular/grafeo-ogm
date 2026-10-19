/**
 * v2.7.1 — read selections whose compiled Cypher must not change: shapes
 * next to the new connection `pageInfo` / `cursor` (which select neither),
 * and, in default mode, the shape mismatches and union-parent `where` that
 * 2.x keeps (and now warns about). Captured from v2.7.0 (4f6a04a) in
 * `read-ignored-inputs.byte-identical.spec.ts`.
 */
import { isInt, type Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { policies, typeDefs } from './fixtures/read-paths.fixture';

export type Opts = { policies?: boolean; strict?: boolean };
export type ModelOf = (name: string) => ReturnType<OGM['model']>;

export function harness(opts: Opts = {}) {
  const session = {
    run: jest.fn().mockResolvedValue({
      records: [],
      summary: { counters: { updates: () => ({}) } },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const driver = {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
  const logger = { debug: jest.fn(), warn: jest.fn() };
  const ogm = new OGM({
    typeDefs,
    driver,
    logger,
    ...(opts.policies ? { policies } : {}),
    ...(opts.strict ? { strict: true } : {}),
  });
  const bound = opts.policies ? ogm.withContext({}) : ogm;
  return {
    logger,
    model: ((name: string) => bound.model(name)) as ModelOf,
    last: () => {
      const calls = session.run.mock.calls;
      const call = calls[calls.length - 1];
      return {
        cypher: call[0] as string,
        params: call[1] as Record<string, unknown>,
      };
    },
  };
}

/** Params as JSON, neo4j Integers as `{ $int: "<value>" }`. */
export const serialize = (params: Record<string, unknown>): unknown =>
  JSON.parse(
    JSON.stringify(params, (_k, v: unknown) =>
      isInt(v) ? { $int: v.toString() } : v,
    ),
  );

const find =
  (selectionSet: string) =>
  (m: ModelOf): Promise<unknown> =>
    m('LbUser').find({ selectionSet });
const typed =
  (select: Record<string, unknown>) =>
  (m: ModelOf): Promise<unknown> =>
    m('LbUser').find({ select } as never);

export type Case = [string, Opts, (m: ModelOf) => Promise<unknown>];

/** Bug 1 — connections that select neither `pageInfo` nor `cursor`. */
export const CONNECTION_CASES: Case[] = [
  [
    'selectionSet sort, node + properties',
    {},
    find(
      '{ postsConnection(sort: [{ edge: { stars: DESC } }]) { totalCount edges { node { id } properties { stars } } } }',
    ),
  ],
  [
    'selectionSet sort, aliased keys',
    {},
    find(
      '{ p: postsConnection(sort: [{ node: { title: ASC } }]) { es: edges { nd: node { id } } } }',
    ),
  ],
  [
    'edges with properties only',
    {},
    find('{ postsConnection { edges { properties { stars note } } } }'),
  ],
  [
    'connection selected twice (merged)',
    {},
    find(
      '{ postsConnection { totalCount } postsConnection { edges { node { id } } } }',
    ),
  ],
  [
    'strict: connection selected twice',
    { strict: true },
    find(
      '{ postsConnection { totalCount } postsConnection { edges { node { id } } } }',
    ),
  ],
  [
    'strict: aliased extra edges with node aliases',
    { strict: true },
    find(
      '{ postsConnection { a: edges { x: node { id } y: node { title } } b: edges { properties { stars } node { id } } } }',
    ),
  ],
  [
    'default: aliased extra edges merged',
    {},
    find(
      '{ postsConnection { a: edges { node { id } } b: edges { node { title } } } }',
    ),
  ],
  [
    'connection through a union member fragment',
    {},
    find(
      '{ items { ... on LbPost { authorConnection { totalCount edges { node { id } } } } } }',
    ),
  ],
  [
    'connection through a union member fragment, read policy',
    { policies: true },
    find(
      '{ items { ... on LbPost { title } } postsConnection { edges { node { id } } } }',
    ),
  ],
  ['typed connection true', {}, typed({ postsConnection: true })],
  [
    'typed edges true + totalCount',
    {},
    typed({ postsConnection: { select: { totalCount: true, edges: true } } }),
  ],
  [
    'typed totalCount only',
    {},
    typed({
      postsConnection: {
        where: { node: { title: 'a' } },
        select: { totalCount: true },
      },
    }),
  ],
  [
    'typed edges node true + properties select',
    {},
    typed({
      postsConnection: {
        select: {
          edges: { node: true, properties: { select: { stars: true } } },
        },
      },
    }),
  ],
  [
    'typed connection object without select',
    {},
    typed({ postsConnection: { where: { node: { title: 'a' } } } }),
  ],
  [
    'mutation response connection',
    {},
    (m) =>
      m('LbUser').update({
        where: { id: 'u1' },
        update: { name: 'U' },
        selectionSet:
          '{ lbUsers { id postsConnection { totalCount edges { node { id } } } } }',
      } as never),
  ],
];

/** Bug 3 — known fields in the wrong shape: default mode keeps the Cypher. */
export const SHAPE_CASES: Case[] = [
  ['scalar with a sub-selection', {}, find('{ id name { x } }')],
  ['relationship without a sub-selection', {}, find('{ id posts }')],
  [
    'singular relationship without a sub-selection',
    {},
    (m) => m('LbPost').find({ selectionSet: '{ id author }' }),
  ],
  ['connection without a sub-selection', {}, find('{ id postsConnection }')],
  [
    'nested: scalar with a sub-selection',
    {},
    find('{ posts { id title { x } } }'),
  ],
  [
    'connection node: scalar with a sub-selection',
    {},
    find('{ postsConnection { edges { node { id title { x } } } } }'),
  ],
  [
    'edge property with a sub-selection',
    {},
    find('{ postsConnection { edges { properties { stars { x } note } } } }'),
  ],
  [
    'union member: scalar with a sub-selection',
    {},
    find('{ items { ... on LbPost { id title { x } } } }'),
  ],
  [
    'union: relationship without a sub-selection',
    {},
    find('{ items { ... on LbPost { id author } } }'),
  ],
  [
    'interface: scalar with a sub-selection',
    {},
    find('{ things { id rank { x } } }'),
  ],
  [
    'typed: scalar given an object',
    {},
    typed({ id: true, name: { select: { x: true } } }),
  ],
  ['typed: relationship given a number', {}, typed({ id: true, posts: 1 })],
  [
    'typed: relationship object with an unknown key',
    {},
    typed({ id: true, posts: { selct: { id: true } } }),
  ],
  [
    'typed: edge property given an object',
    {},
    typed({
      postsConnection: {
        select: {
          edges: { properties: { select: { stars: { x: true }, note: true } } },
        },
      },
    }),
  ],
];

/** Bug 2 — typed select `where` under a union parent: 2.x ignores it. */
export const UNION_WHERE_CASES: Case[] = [
  [
    'union parent: relationship where',
    {},
    typed({
      items: {
        select: {
          id: true,
          author: { select: { id: true }, where: { name: 'x' } },
        },
      },
    }),
  ],
  [
    'union parent: relationship where, read policy',
    { policies: true },
    typed({
      items: {
        select: {
          id: true,
          author: { where: { name: 'x' } },
        },
      },
    }),
  ],
];
