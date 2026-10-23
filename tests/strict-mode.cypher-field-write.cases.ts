/**
 * v2.19.0 — strict item 33: `@cypher` fields given as write input, shared by
 * the unit spec and its byte-identical guard.
 */
import { OGM } from '../src/ogm';
import type { Run } from './strict-mode.writes.cases';

export const cypherWriteTypeDefs = /* GraphQL */ `
  type User @node {
    id: ID! @id @unique
    name: String @unique
    n: Int
    double: Int @cypher(statement: "RETURN this.n * 2 AS d", columnName: "d")
    posts: [Post!]! @relationship(type: "WROTE", direction: OUT)
  }
  type Post @node {
    id: ID! @id @unique
    title: String
    score: Int @cypher(statement: "RETURN 1 AS s", columnName: "s")
  }
`;

export interface BadCypherWriteShape {
  run: Run;
  type: string;
  field: string;
  input: 'create' | 'update' | 'createMany' | 'nested update';
}

const user = (ogm: OGM) => ogm.model('User');
const where = { id: 'u1' };

export const badCypherWriteShapes: Record<string, BadCypherWriteShape> = {
  'create()': {
    type: 'User',
    field: 'double',
    input: 'create',
    run: (ogm) => user(ogm).create({ input: [{ name: 'a', double: 1 }] }),
  },
  'update()': {
    type: 'User',
    field: 'double',
    input: 'update',
    run: (ogm) => user(ogm).update({ where, update: { name: 'b', double: 2 } }),
  },
  'update() with null': {
    type: 'User',
    field: 'double',
    input: 'update',
    run: (ogm) => user(ogm).update({ where, update: { double: null } }),
  },
  'updateMany()': {
    type: 'User',
    field: 'double',
    input: 'update',
    run: (ogm) => user(ogm).updateMany({ where, data: { double: 3 } }),
  },
  'createMany()': {
    type: 'User',
    field: 'double',
    input: 'createMany',
    run: (ogm) => user(ogm).createMany({ data: [{ name: 'a', double: 4 }] }),
  },
  'upsert() create': {
    type: 'User',
    field: 'double',
    input: 'create',
    run: (ogm) =>
      user(ogm).upsert({
        where: { name: 'a' },
        create: { name: 'a', double: 5 },
        update: { n: 1 },
      }),
  },
  'upsert() update': {
    type: 'User',
    field: 'double',
    input: 'update',
    run: (ogm) =>
      user(ogm).upsert({
        where: { name: 'a' },
        create: { name: 'a' },
        update: { double: 6 },
      }),
  },
  'nested create in create()': {
    type: 'Post',
    field: 'score',
    input: 'create',
    run: (ogm) =>
      user(ogm).create({
        input: [
          {
            name: 'a',
            posts: { create: [{ node: { title: 't', score: 7 } }] },
          },
        ],
      }),
  },
  'nested create in update()': {
    type: 'Post',
    field: 'score',
    input: 'create',
    run: (ogm) =>
      user(ogm).update({
        where,
        update: { posts: [{ create: [{ node: { title: 't', score: 8 } }] }] },
      }),
  },
  'nested update': {
    type: 'Post',
    field: 'score',
    input: 'nested update',
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          posts: [
            { where: { node: { id: 'p1' } }, update: { node: { score: 9 } } },
          ],
        },
      }),
  },
};

export const legitCypherWriteShapes: Record<string, Run> = {
  'create and update stored fields, @cypher field selected': async (ogm) => {
    await user(ogm).create({
      input: [{ name: 'a', n: 1 }],
      selectionSet: '{ users { id double } }',
    });
    await user(ogm).update({
      where,
      update: { n: 2, posts: [{ create: [{ node: { title: 't' } }] }] },
      selectionSet: '{ users { id double } }',
    });
  },
  'a @cypher field set to undefined': (ogm) =>
    user(ogm).update({ where, update: { n: 2, double: undefined } }),
};
