/**
 * v2.12.0 — a union MEMBER key in a where (`{ LbDoc: … }`) on a union
 * target. `UNION_MEMBER_WHERE_CASES` are the shapes that change (before
 * 2.12.0 they compiled the member key as a node property, or ignored it);
 * `UNCHANGED_WHERE_CASES` are where inputs that already worked and must
 * compile byte-identically to v2.10.0 (74dea63).
 */
import type { ModelOf } from './read-ignored-inputs.byte-identical.cases';

const find =
  (selectionSet: string, where?: Record<string, unknown>) =>
  (m: ModelOf): Promise<unknown> =>
    m('LbUser').find({ where, selectionSet } as never);
const typed =
  (select: Record<string, unknown>) =>
  (m: ModelOf): Promise<unknown> =>
    m('LbUser').find({ select } as never);
const root = (where: Record<string, unknown>) => find('{ id }', where);

const DOC2 = { LbDoc: { rank: 2 } };

export type UnionCase = {
  label: string;
  run: (m: ModelOf) => Promise<unknown>;
};

export const UNION_MEMBER_WHERE_CASES: UnionCase[] = [
  {
    label: 'typed select items where',
    run: typed({ items: { where: DOC2, select: { id: true } } }),
  },
  {
    label: 'selectionSet items(where)',
    run: find(
      '{ items(where: { LbDoc: { rank: 2 } }) { ... on LbDoc { id } } }',
    ),
  },
  {
    label: 'typed select items where, two members',
    run: typed({
      items: {
        where: { LbDoc: { rank: 2 }, LbPost: { title: 'a' } },
        select: { id: true },
      },
    }),
  },
  {
    label: 'typed select itemsConnection where node',
    run: typed({
      itemsConnection: {
        where: { node: DOC2 },
        select: { totalCount: true, edges: { node: true } },
      },
    }),
  },
  {
    label: 'selectionSet itemsConnection(where: { node })',
    run: find(
      '{ itemsConnection(where: { node: { LbDoc: { rank: 2 } } }) { totalCount edges { node { ... on LbDoc { id } } } } }',
    ),
  },
  {
    label: 'selectionSet itemsConnection(where: { node_NOT })',
    run: find(
      '{ itemsConnection(where: { node_NOT: { LbDoc: { rank: 2 } } }) { totalCount } }',
    ),
  },
  {
    label: 'selectionSet itemsConnection upstream member shape',
    run: find(
      '{ itemsConnection(where: { LbDoc: { node: { rank: 2 } } }) { totalCount } }',
    ),
  },
  {
    label: 'root itemsConnection_SOME { node }',
    run: root({ itemsConnection_SOME: { node: DOC2 } }),
  },
  {
    label: 'root itemsConnection { node }',
    run: root({ itemsConnection: { node: DOC2 } }),
  },
  {
    label: 'root itemsConnection_NONE { node }',
    run: root({ itemsConnection_NONE: { node: DOC2 } }),
  },
  {
    label: 'root itemsConnection_NOT { node }',
    run: root({ itemsConnection_NOT: { node: DOC2 } }),
  },
  {
    label: 'root itemsConnection_SINGLE { node }',
    run: root({ itemsConnection_SINGLE: { node: DOC2 } }),
  },
  {
    label: 'root itemsConnection_ALL { node }',
    run: root({ itemsConnection_ALL: { node: DOC2 } }),
  },
  {
    label: 'root itemsConnection_SOME { node_NOT }',
    run: root({ itemsConnection_SOME: { node_NOT: DOC2 } }),
  },
  {
    label: 'root itemsConnection_SOME upstream member shape',
    run: root({ itemsConnection_SOME: { LbDoc: { node: { rank: 2 } } } }),
  },
  {
    label: 'root itemsConnection_NONE upstream member shape, two members',
    run: root({
      itemsConnection_NONE: {
        LbDoc: { node: { rank: 2 } },
        LbPost: { node: { title: 'a' } },
      },
    }),
  },
  {
    label: 'selectionSet itemsAggregate(where)',
    run: find('{ itemsAggregate(where: { LbDoc: { rank: 2 } }) { count } }'),
  },
];

/** Already-working where inputs: the Cypher must not change in 2.12.0. */
export const UNCHANGED_WHERE_CASES: UnionCase[] = [
  {
    label: 'root items_SOME member key',
    run: root({ items_SOME: DOC2 }),
  },
  {
    label: 'root items bare member key',
    run: root({ items: DOC2 }),
  },
  {
    label: 'root items_NONE two member keys',
    run: root({ items_NONE: { LbDoc: { rank: 2 }, LbPost: { title: 'a' } } }),
  },
  {
    label: 'root items_ALL member key',
    run: root({ items_ALL: DOC2 }),
  },
  {
    label: 'root items_SINGLE member key',
    run: root({ items_SINGLE: DOC2 }),
  },
  {
    label: 'root itemsConnection_SOME node shared field',
    run: root({ itemsConnection_SOME: { node: { rank: 2 } } }),
  },
  {
    label: 'root itemsConnection_NONE node_NOT shared field',
    run: root({ itemsConnection_NONE: { node_NOT: { id: 'x' } } }),
  },
  {
    label: 'typed select items where shared field',
    run: typed({ items: { where: { rank: 2 }, select: { id: true } } }),
  },
  {
    label: 'selectionSet items(where) shared field',
    run: find('{ items(where: { rank: 2 }) { ... on LbDoc { id } } }'),
  },
  {
    label: 'selectionSet itemsConnection(where: { node }) shared field',
    run: find(
      '{ itemsConnection(where: { node: { rank: 2 } }) { totalCount edges { node { ... on LbDoc { id } } } } }',
    ),
  },
  {
    label: 'selectionSet itemsConnection bare shared field',
    run: find('{ itemsConnection(where: { rank: 2 }) { totalCount } }'),
  },
  {
    label: 'selectionSet itemsAggregate(where) shared field',
    run: find('{ itemsAggregate(where: { rank: 2 }) { count } }'),
  },
  {
    label: 'root posts_SOME',
    run: root({ posts_SOME: { title: 'a' } }),
  },
  {
    label: 'root postsConnection_SOME node + edge',
    run: root({
      postsConnection_SOME: { node: { title: 'a' }, edge: { stars: 3 } },
    }),
  },
  {
    label: 'root things_SOME (interface)',
    run: root({ things_SOME: { rank: 2 } }),
  },
  {
    label: 'root thingsConnection_NONE (interface)',
    run: root({ thingsConnection_NONE: { node: { rank: 2 } } }),
  },
  {
    label: 'typed select posts where',
    run: typed({ posts: { where: { title: 'a' }, select: { id: true } } }),
  },
  {
    label: 'typed select things where (interface)',
    run: typed({ things: { where: { rank: 2 }, select: { id: true } } }),
  },
  {
    label: 'selectionSet postsConnection(where: node + edge)',
    run: find(
      '{ postsConnection(where: { node: { title: "a" }, edge: { stars: 3 } }) { totalCount edges { node { id } } } }',
    ),
  },
  {
    label: 'selectionSet thingsConnection(where: { node })',
    run: find(
      '{ thingsConnection(where: { node: { rank: 2 } }) { totalCount } }',
    ),
  },
  {
    label: 'root friends_SOME nested items_SOME member key',
    run: root({ friends_SOME: { items_SOME: DOC2 } }),
  },
];
