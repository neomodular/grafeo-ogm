/**
 * v2.19.0 — strict item 34: top-level params a Model / InterfaceModel method
 * does not read, shared by the unit spec and its byte-identical guard.
 */
import { OGM } from '../src/ogm';
import type { Run } from './strict-mode.writes.cases';

export const paramsTypeDefs = /* GraphQL */ `
  interface Animal {
    name: String
  }
  type Dog implements Animal @node {
    name: String
  }
  type Cat implements Animal @node {
    name: String
  }
  type User @node {
    id: ID! @id @unique
    name: String @unique
    posts: [Post!]! @relationship(type: "WROTE", direction: OUT)
  }
  type Post @node {
    id: ID! @id @unique
    title: String
  }
`;

export interface BadParamShape {
  run: Run;
  /** `Type.method` as the message names it. */
  call: string;
  /** The unknown keys, quoted and comma-separated. */
  keys: string;
  /** Advice the message ends with, if any. */
  hint?: string;
}

const user = (ogm: OGM) => ogm.model('User');
const animals = (ogm: OGM) => ogm.interfaceModel('Animal');
const where = { id: 'u1' };
/** Not a fresh literal, so TypeScript's excess-property check lets the unknown key through. */
const extra = <T extends object>(o: T): T => o;

const nestedOnly = (op: string) =>
  `update() has no root "${op}": put it in a relationship field of "update", e.g. ` +
  `\`update: { posts: [{ ${op}: … }] }\`.`;

export const badParamShapes: Record<string, BadParamShape> = {
  'update() with an upstream-style root "delete"': {
    call: 'User.update',
    keys: '"delete"',
    hint: nestedOnly('delete'),
    run: (ogm) =>
      user(ogm).update(
        extra({
          where,
          delete: { posts: [{ where: { node: { id: 'p1' } } }] },
        }),
      ),
  },
  'update() with a root "create"': {
    call: 'User.update',
    keys: '"create"',
    hint: nestedOnly('create'),
    run: (ogm) =>
      user(ogm).update(
        extra({
          where,
          update: { name: 'b' },
          create: { posts: [{ node: { title: 't' } }] },
        }),
      ),
  },
  'update() with "data"': {
    call: 'User.update',
    keys: '"data"',
    hint: 'update() takes "update", not "data" (that is updateMany()).',
    run: (ogm) => user(ogm).update(extra({ where, data: { name: 'b' } })),
  },
  'deleteMany() with a cascade "delete"': {
    call: 'User.deleteMany',
    keys: '"delete"',
    hint: 'deleteMany() does not cascade: use delete({ where, delete }).',
    run: (ogm) => user(ogm).deleteMany(extra({ where, delete: { posts: {} } })),
  },
  // v2.21.0 — `labels` on delete() / deleteMany() moved to strict item 39
  // (tests/strict-mode.delete-labels.spec.ts).
  'find() with a Prisma-style "orderBy" and "take"': {
    call: 'User.find',
    keys: '"orderBy", "take"',
    run: (ogm) =>
      user(ogm).find(extra({ where, orderBy: { name: 'ASC' }, take: 1 })),
  },
  'findFirst() with "sort"': {
    call: 'User.findFirst',
    keys: '"sort"',
    run: (ogm) =>
      user(ogm).findFirst(extra({ where, sort: [{ name: 'ASC' }] })),
  },
  'findUnique() with "include"': {
    call: 'User.findUnique',
    keys: '"include"',
    run: (ogm) =>
      user(ogm).findUnique(extra({ where, include: { posts: true } })),
  },
  'create() with "skipDuplicates"': {
    call: 'User.create',
    keys: '"skipDuplicates"',
    run: (ogm) =>
      user(ogm).create(
        extra({
          input: [{ name: 'a' }],
          skipDuplicates: true,
        }),
      ),
  },
  'createMany() with "select"': {
    call: 'User.createMany',
    keys: '"select"',
    run: (ogm) =>
      user(ogm).createMany(
        extra({
          data: [{ name: 'a' }],
          select: { id: true },
        }),
      ),
  },
  'updateMany() with "update" beside "data"': {
    call: 'User.updateMany',
    keys: '"update"',
    run: (ogm) =>
      user(ogm).updateMany(
        extra({
          where,
          data: { name: 'b' },
          update: { name: 'c' },
        }),
      ),
  },
  'upsert() with "connect"': {
    call: 'User.upsert',
    keys: '"connect"',
    run: (ogm) =>
      user(ogm).upsert(
        extra({
          where: { name: 'a' },
          create: { name: 'a' },
          update: {},
          connect: { posts: [{ where: { node: { id: 'p1' } } }] },
        }),
      ),
  },
  'count() with "options"': {
    call: 'User.count',
    keys: '"options"',
    run: (ogm) => user(ogm).count(extra({ where, options: { limit: 1 } })),
  },
  'aggregate() with "options"': {
    call: 'User.aggregate',
    keys: '"options"',
    run: (ogm) =>
      user(ogm).aggregate(
        extra({
          where,
          aggregate: { count: true },
          options: { limit: 1 },
        }),
      ),
  },
  'setLabels() with "labels"': {
    call: 'User.setLabels',
    keys: '"labels"',
    run: (ogm) =>
      user(ogm).setLabels(
        extra({
          where,
          addLabels: ['Vip'],
          labels: ['Old'],
        }),
      ),
  },
  'InterfaceModel find() with "select"': {
    call: 'Animal.find',
    keys: '"select"',
    run: (ogm) =>
      animals(ogm).find(
        extra({ where: { name: 'Rex' }, select: { name: true } }),
      ),
  },
  'InterfaceModel count() with "fulltext"': {
    call: 'Animal.count',
    keys: '"fulltext"',
    run: (ogm) =>
      animals(ogm).count(
        extra({ where: { name: 'Rex' }, fulltext: { x: { phrase: 'a' } } }),
      ),
  },
};

export const legitParamShapes: Record<string, Run> = {
  'every method with its own params': async (ogm) => {
    const u = user(ogm);
    await u.find({
      where,
      selectionSet: '{ id }',
      labels: ['Vip'],
      options: { limit: 1 },
      context: {},
    });
    await u.findFirst({ where, select: { id: true }, options: { offset: 1 } });
    await u.findUnique({ where });
    await u.create({ input: [{ name: 'a' }], labels: ['Vip'] });
    await u.update({ where, update: { name: 'b' }, select: { id: true } });
    // No `update` body here: strict item 19 reorders it against `disconnect`.
    await u.update({
      where,
      connect: { posts: [{ where: { node: { id: 'p1' } } }] },
      disconnect: { posts: [{ where: { node: { id: 'p2' } } }] },
    });
    await u.delete({ where, delete: { posts: {} } });
    await u.deleteMany({ where });
    await u.createMany({ data: [{ name: 'a' }], skipDuplicates: true });
    await u.updateMany({ where, data: { name: 'b' }, labels: ['Vip'] });
    await u.upsert({
      where: { name: 'a' },
      create: { name: 'a' },
      update: { name: 'b' },
    });
    await u.count({ where, labels: ['Vip'] });
    await u.aggregate({ where, aggregate: { count: true } });
    await u.setLabels({ where, addLabels: ['Vip'], removeLabels: ['Old'] });
    await animals(ogm).find({ where: { name: 'Rex' }, options: { limit: 1 } });
    await animals(ogm).count({ where: { name: 'Rex' } });
  },
  'an unknown param set to undefined': async (ogm) => {
    await user(ogm).update(
      extra({ where, update: { name: 'b' }, delete: undefined }),
    );
    await user(ogm).deleteMany(extra({ where, delete: undefined }));
  },
};
