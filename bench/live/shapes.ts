import type { Transaction } from 'neo4j-driver';
import type { OGM } from '../../src/ogm';

type Ctx = { transaction: Transaction };
export interface Shape {
  name: string;
  ogm?: 'default' | 'strict' | 'policy';
  run: (ogm: OGM, context: Ctx) => Promise<unknown>;
}

const U = (o: OGM) => o.model('PfUser');
const P = (o: OGM) => o.model('PfPost');
const T = (o: OGM) => o.model('PfTag');

/* eslint-disable @typescript-eslint/no-explicit-any */
export const SHAPES: Shape[] = [
  // ---------------- reads ----------------
  {
    name: 'find.byUnique',
    run: (o, context) =>
      U(o).find({ where: { id: 'u5' }, selectionSet: '{ id name }', context }),
  },
  {
    name: 'find.where.scalar+sort+page',
    run: (o, context) =>
      U(o).find({
        where: { age_GT: 30, name_CONTAINS: '9' },
        options: {
          sort: [{ age: 'DESC' }, { id: 'ASC' }],
          limit: 20,
          offset: 40,
        },
        selectionSet: '{ id name age }',
        context,
      }),
  },
  {
    name: 'find.nested.rel.fan100',
    run: (o, context) =>
      U(o).find({
        where: { bucket: 100 },
        options: { limit: 20, sort: [{ id: 'ASC' }] },
        selectionSet: '{ id posts { id title tags { name } } }',
        context,
      }),
  },
  {
    name: 'find.nested.rel.filtered',
    run: (o, context) =>
      U(o).find({
        where: { id_IN: ['u1', 'u2', 'u500', 'u5000'] },
        selectionSet:
          '{ id posts(where: { score_GT: 5 }, options: { limit: 3, sort: [{ score: DESC }] }) { id score } }',
        context,
      }),
  },
  {
    name: 'find.where.rel.SOME',
    run: (o, context) =>
      U(o).find({
        where: { posts_SOME: { score_GT: 90 } },
        options: { limit: 50 },
        selectionSet: '{ id }',
        context,
      }),
  },
  {
    name: 'find.where.rel.NONE+ALL',
    run: (o, context) =>
      U(o).find({
        where: {
          posts_NONE: { score_GT: 5 },
          posts_ALL: { score_LT: 50 },
          bucket: 10,
        },
        selectionSet: '{ id }',
        context,
      }),
  },
  {
    name: 'find.where.connection',
    run: (o, context) =>
      P(o).find({
        where: {
          tagsConnection_SOME: { edge: { weight: 3 }, node: { name: 'tag5' } },
        },
        selectionSet: '{ id }',
        context,
      }),
  },
  {
    name: 'find.connection.edges+totalCount',
    run: (o, context) =>
      U(o).find({
        where: { bucket: 100 },
        options: { limit: 10 },
        selectionSet:
          '{ id postsConnection(sort: [{ node: { score: DESC } }]) { totalCount edges { node { id score } } } }',
        context,
      }),
  },
  {
    name: 'find.cypherField',
    run: (o, context) =>
      U(o).find({
        where: { bucket: 10 },
        options: { limit: 100 },
        selectionSet: '{ id postCount }',
        context,
      }),
  },
  {
    name: 'find.cypherField.sort',
    run: (o, context) =>
      U(o).find({
        where: { bucket: 10 },
        options: { limit: 10, sort: [{ postCount: 'DESC' }] },
        selectionSet: '{ id postCount }',
        context,
      }),
  },
  {
    name: 'find.cypherField.where',
    run: (o, context) =>
      U(o).find({
        where: { postCount_GT: 50 },
        selectionSet: '{ id }',
        context,
      }),
  },
  {
    name: 'find.interface.rel',
    run: (o, context) =>
      U(o).find({
        where: { id_IN: ['u1', 'u2', 'u3'] },
        selectionSet:
          '{ id content { __typename id title ... on PfPost { score } } }',
        context,
      }),
  },
  {
    name: 'find.select.api',
    run: (o, context) =>
      U(o).find({
        where: { bucket: 100 },
        options: { limit: 20 },
        select: {
          id: true,
          posts: { select: { id: true }, where: { score_LT: 3 } },
        },
        context,
      } as any),
  },
  {
    name: 'count.where',
    run: (o, context) => P(o).count({ where: { score_GT: 3 }, context }),
  },
  {
    name: 'aggregate',
    run: (o, context) =>
      P(o).aggregate({
        where: { score_GT: 3 },
        aggregate: { count: true, score: true },
        context,
      }),
  },
  {
    name: 'interfaceModel.find',
    run: (o, context) =>
      o.interfaceModel('PfContent').find({
        where: { title_STARTS_WITH: 'note 1' },
        selectionSet: '{ id title }',
        context,
      } as any),
  },
  // ---------------- writes ----------------
  {
    name: 'create.plain',
    run: (o, context) =>
      U(o).create({
        input: [{ id: 'nu1', email: 'nu1@x', name: 'n' }],
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },
  {
    name: 'create.nestedCreate',
    run: (o, context) =>
      U(o).create({
        input: [
          {
            id: 'nu2',
            email: 'nu2@x',
            posts: {
              create: [
                { node: { id: 'np1', title: 'a' } },
                { node: { id: 'np2', title: 'b' } },
              ],
            },
          },
        ],
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },
  {
    name: 'create.connect.byUnique',
    run: (o, context) =>
      P(o).create({
        input: [
          {
            id: 'np3',
            title: 'x',
            author: { connect: { where: { node: { id: 'u7' } } } },
            tags: {
              connect: [
                { where: { node: { name: 'tag1' } }, edge: { weight: 1 } },
                { where: { node: { name: 'tag2' } }, edge: { weight: 2 } },
              ],
            },
          },
        ],
        selectionSet: '{ pfPosts { id } }',
        context,
      } as any),
  },
  {
    name: 'create.connect.nonUnique',
    run: (o, context) =>
      P(o).create({
        input: [
          {
            id: 'np4',
            title: 'x',
            tags: {
              connect: [{ where: { node: { name_STARTS_WITH: 'tag99' } } }],
            },
          },
        ],
        selectionSet: '{ pfPosts { id } }',
        context,
      } as any),
  },
  {
    name: 'createMany.100',
    run: (o, context) =>
      U(o).createMany({
        data: Array.from({ length: 100 }, (_, i) => ({
          id: `cm${i}`,
          email: `cm${i}@x`,
        })),
        context,
      } as any),
  },
  {
    name: 'create.10.withConnect',
    run: (o, context) =>
      P(o).create({
        input: Array.from({ length: 10 }, (_, i) => ({
          id: `bp${i}`,
          title: 't',
          author: { connect: { where: { node: { id: `u${i}` } } } },
        })),
        selectionSet: '{ pfPosts { id } }',
        context,
      } as any),
  },
  {
    name: 'update.set.byUnique',
    run: (o, context) =>
      U(o).update({
        where: { id: 'u9' },
        update: { name: 'renamed' },
        selectionSet: '{ pfUsers { id name } }',
        context,
      } as any),
  },
  {
    name: 'update.set.many(bucket10)',
    run: (o, context) =>
      U(o).update({
        where: { bucket: 10 },
        update: { name: 'renamed' },
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },
  {
    name: 'update.connect.byUnique',
    run: (o, context) =>
      P(o).update({
        where: { id: 'u5-p3' },
        connect: {
          tags: [{ where: { node: { name: 'tag900' } }, edge: { weight: 9 } }],
        },
        selectionSet: '{ pfPosts { id } }',
        context,
      } as any),
  },
  {
    name: 'update.connect.many(bucket10->tag)',
    run: (o, context) =>
      U(o).update({
        where: { bucket: 10 },
        connect: { posts: [{ where: { node: { id: 'u5000-p0' } } }] },
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },
  {
    name: 'update.disconnect.byUnique',
    run: (o, context) =>
      U(o).update({
        where: { id: 'u5' },
        disconnect: { posts: [{ where: { node: { id: 'u5-p1' } } }] },
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },
  {
    name: 'update.disconnect.fan100',
    run: (o, context) =>
      U(o).update({
        where: { id: 'u5' },
        disconnect: { posts: [{ where: { node: { score_LT: 50 } } }] },
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },
  {
    name: 'update.nested.update',
    run: (o, context) =>
      U(o).update({
        where: { id: 'u5' },
        update: {
          posts: [
            {
              where: { node: { score_LT: 10 } },
              update: { node: { title: 'z' } },
            },
          ],
        },
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },
  {
    name: 'update.nested.create+connect',
    run: (o, context) =>
      U(o).update({
        where: { id: 'u5' },
        update: {
          posts: [
            {
              create: [{ node: { id: 'nn1', title: 'q' } }],
              connect: [{ where: { node: { id: 'u6000-p0' } } }],
            },
          ],
        },
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },
  {
    name: 'update.nested.delete',
    run: (o, context) =>
      U(o).update({
        where: { id: 'u5' },
        update: { posts: [{ delete: [{ where: { node: { score_LT: 5 } } }] }] },
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },
  {
    name: 'delete.plain.byUnique',
    run: (o, context) => U(o).delete({ where: { id: 'u9999' }, context }),
  },
  {
    name: 'delete.cascade.fan100',
    run: (o, context) =>
      U(o).delete({
        where: { id: 'u5' },
        delete: { posts: [{ where: {} }] },
        context,
      } as any),
  },
  {
    name: 'deleteMany',
    run: (o, context) =>
      U(o).deleteMany({ where: { bucket: 10, age_LT: 5 }, context } as any),
  },
  {
    name: 'upsert.existing',
    run: (o, context) =>
      U(o).upsert({
        where: { id: 'u11' },
        create: { id: 'u11', email: 'u11@x.io' },
        update: { name: 'up' },
        selectionSet: '{ id name }',
        context,
      } as any),
  },
  {
    name: 'upsert.new',
    run: (o, context) =>
      U(o).upsert({
        where: { id: 'zzz' },
        create: { id: 'zzz', email: 'zzz@x.io' },
        update: { name: 'up' },
        selectionSet: '{ id name }',
        context,
      } as any),
  },
  {
    name: 'updateMany',
    run: (o, context) =>
      P(o).updateMany({
        where: { score: 7 },
        data: { title: 'seven' },
        context,
      } as any),
  },
  {
    name: 'setLabels',
    run: (o, context) =>
      U(o).setLabels({
        where: { id: 'u3' },
        addLabels: ['Vip'],
        context,
      } as any),
  },
  {
    name: 'tag.find.reverse.fan',
    run: (o, context) =>
      T(o).find({
        where: { name: 'tag5' },
        selectionSet: '{ name posts { id author { id } } }',
        context,
      }),
  },

  // ---------------- @cypher at scale ----------------
  {
    name: 'find.cypherField.all.limit10',
    run: (o, context) =>
      U(o).find({
        options: { limit: 10 },
        selectionSet: '{ id postCount }',
        context,
      }),
  },
  {
    name: 'find.cypherField.all.sortId.limit10',
    run: (o, context) =>
      U(o).find({
        options: { limit: 10, sort: [{ id: 'ASC' }] },
        selectionSet: '{ id postCount }',
        context,
      }),
  },
  {
    name: 'find.cypherField.all.sortCypher.limit10',
    run: (o, context) =>
      U(o).find({
        options: { limit: 10, sort: [{ postCount: 'DESC' }] },
        selectionSet: '{ id name postCount }',
        context,
      }),
  },
  {
    name: 'update.select.cypherField',
    run: (o, context) =>
      U(o).update({
        where: { bucket: 10 },
        update: { age: 1 },
        selectionSet: '{ pfUsers { id postCount } }',
        context,
      } as any),
  },
  {
    name: 'create.50.withConnect',
    run: (o, context) =>
      P(o).create({
        input: Array.from({ length: 50 }, (_, i) => ({
          id: `bq${i}`,
          title: 't',
          author: { connect: { where: { node: { id: `u${i}` } } } },
        })),
        selectionSet: '{ pfPosts { id } }',
        context,
      } as any),
  },
  // ---------------- policy-bound ----------------
  {
    name: 'policy.find.nested',
    ogm: 'policy',
    run: (o, context) =>
      U(o).find({
        where: { bucket: 100 },
        options: { limit: 20 },
        selectionSet: '{ id posts { id tags { name } } }',
        context,
      }),
  },
  {
    name: 'policy.find.SOME',
    ogm: 'policy',
    run: (o, context) =>
      U(o).find({
        where: { posts_SOME: { score_GT: 90 } },
        selectionSet: '{ id }',
        context,
      }),
  },
  {
    name: 'policy.update.connect',
    ogm: 'policy',
    run: (o, context) =>
      U(o).update({
        where: { id: 'u5' },
        connect: { posts: [{ where: { node: { id: 'u15-p0' } } }] },
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },
  {
    name: 'policy.update.nested.update',
    ogm: 'policy',
    run: (o, context) =>
      U(o).update({
        where: { id: 'u5' },
        update: {
          posts: [
            {
              where: { node: { score_LT: 10 } },
              update: { node: { title: 'z' } },
            },
          ],
        },
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },
  {
    name: 'policy.create.nested',
    ogm: 'policy',
    run: (o, context) =>
      U(o).create({
        input: [
          {
            id: 'pz',
            email: 'pz@x',
            tenantId: 't5',
            posts: {
              create: [{ node: { id: 'pzp', tenantId: 't5' } }],
              connect: [{ where: { node: { id: 'u15-p1' } } }],
            },
          },
        ],
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },
  {
    name: 'policy.delete.cascade',
    ogm: 'policy',
    run: (o, context) =>
      U(o).delete({
        where: { id: 'u5' },
        delete: { posts: [{ where: {} }] },
        context,
      } as any),
  },
  // ---------------- strict ----------------
  {
    name: 'strict.update.nested.ops',
    ogm: 'strict',
    run: (o, context) =>
      U(o).update({
        where: { id: 'u5' },
        update: {
          posts: [
            {
              where: { node: { score_LT: 10 } },
              update: { node: { title: 'z' } },
            },
          ],
        },
        connect: { posts: [{ where: { node: { id: 'u6000-p0' } } }] },
        selectionSet: '{ pfUsers { id } }',
        context,
      } as any),
  },

  {
    name: 'create.100.withConnect',
    run: (o, context) =>
      P(o).create({
        input: Array.from({ length: 100 }, (_, i) => ({
          id: `br${i}`,
          title: 't',
          author: { connect: { where: { node: { id: `u${i}` } } } },
        })),
        selectionSet: '{ pfPosts { id author { id } } }',
        context,
      } as any),
  },
  {
    name: 'create.20.mixed+labels',
    run: (o, context) =>
      P(o).create({
        input: Array.from({ length: 20 }, (_, i) =>
          i % 3 === 0
            ? { id: `bm${i}`, title: 't' }
            : {
                id: `bm${i}`,
                title: 't',
                tags: {
                  connect: [
                    {
                      where: { node: { name: `tag${i}` } },
                      edge: { weight: i },
                    },
                  ],
                },
                comments: { create: [{ node: { id: `bmc${i}` } }] },
              },
        ),
        labels: ['Extra'],
        selectionSet: '{ pfPosts { id tags { name } comments { id } } }',
        context,
      } as any),
  },
  {
    name: 'policy.create.30.connect',
    ogm: 'policy',
    run: (o, context) =>
      P(o).create({
        input: Array.from({ length: 30 }, (_, i) => ({
          id: `bz${i}`,
          tenantId: 't5',
          tags: { connect: [{ where: { node: { name: `tag${i}` } } }] },
        })),
        selectionSet: '{ pfPosts { id tags { name } } }',
        context,
      } as any),
  },

  {
    name: 'B.ties.sortAge.limit10.cypherSel',
    run: (o, context) =>
      U(o).find({
        options: { limit: 10, offset: 5, sort: [{ age: 'ASC' }] },
        selectionSet: '{ id age postCount }',
        context,
      }),
  },
  {
    name: 'B.ties.sortCypher.limit10.cypherSel',
    run: (o, context) =>
      U(o).find({
        where: { bucket: 10 },
        options: { limit: 10, offset: 3, sort: [{ postCount: 'DESC' }] },
        selectionSet: '{ id postCount }',
        context,
      }),
  },
  {
    name: 'B.interface.sort.limit',
    run: (o, context) =>
      o
        .interfaceModel('PfContent')
        .find({
          options: { limit: 10, sort: [{ title: 'DESC' }] },
          selectionSet: '{ id title }',
          context,
        } as any),
  },
  {
    name: 'B.policy.sortName.limit20.cypherSel',
    ogm: 'policy',
    run: (o, context) =>
      U(o).find({
        options: { limit: 20, sort: [{ name: 'DESC' }] },
        selectionSet: '{ id name postCount }',
        context,
      }),
  },
];
