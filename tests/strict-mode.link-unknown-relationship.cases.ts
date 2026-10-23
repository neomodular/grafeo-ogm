/**
 * vNEXT — strict item 28: connect / disconnect maps keyed by a name that is
 * not a relationship of the type, shared by the unit spec and its
 * byte-identical guard.
 */
import { OGM } from '../src/ogm';
import type { Run } from './strict-mode.writes.cases';

export const linkTypeDefs = /* GraphQL */ `
  interface Animal {
    name: String
    toys: [Toy!]! @declareRelationship
  }
  type Dog implements Animal @node {
    name: String
    toys: [Toy!]! @relationship(type: "PLAYS", direction: OUT)
  }
  type Toy @node {
    id: ID! @id @unique
    name: String
  }
  type User @node {
    id: ID! @id @unique
    name: String
    posts: [Post!]! @relationship(type: "WROTE", direction: OUT)
    animals: [Animal!]! @relationship(type: "KEEPS", direction: OUT)
  }
  type Post @node {
    id: ID! @id @unique
    title: String
    author: [User!]! @relationship(type: "WROTE", direction: IN)
    tags: [Tag!]! @relationship(type: "TAGGED", direction: OUT)
  }
  type Tag @node {
    id: ID! @id @unique
    name: String
  }
`;

export interface BadLinkShape {
  run: Run;
  kind: 'connect' | 'disconnect';
  type: string;
  field: string;
}

const user = (ogm: OGM) => ogm.model('User');
const where = { id: 'u1' };
const post = { where: { node: { id: 'p1' } } };
const tag = { where: { node: { id: 't1' } } };

export const badLinkShapes: Record<string, BadLinkShape> = {
  'root connect: "post" for "posts"': {
    kind: 'connect',
    type: 'User',
    field: 'post',
    run: (ogm) => user(ogm).update({ where, connect: { post: [post] } }),
  },
  'root connect: a scalar field': {
    kind: 'connect',
    type: 'User',
    field: 'name',
    run: (ogm) => user(ogm).update({ where, connect: { name: [post] } }),
  },
  'root connect: unknown next to a known one': {
    kind: 'connect',
    type: 'User',
    field: 'post',
    run: (ogm) =>
      user(ogm).update({ where, connect: { posts: [post], post: [post] } }),
  },
  'root disconnect: "post" for "posts"': {
    kind: 'disconnect',
    type: 'User',
    field: 'post',
    run: (ogm) => user(ogm).update({ where, disconnect: { post: [post] } }),
  },
  'root disconnect: null value': {
    kind: 'disconnect',
    type: 'User',
    field: 'post',
    run: (ogm) => user(ogm).update({ where, disconnect: { post: null } }),
  },
  'connect inside a root connect item': {
    kind: 'connect',
    type: 'Post',
    field: 'tag',
    run: (ogm) =>
      user(ogm).update({
        where,
        connect: { posts: [{ ...post, connect: { tag: [tag] } }] },
      }),
  },
  'disconnect inside a root disconnect item': {
    kind: 'disconnect',
    type: 'Post',
    field: 'tag',
    run: (ogm) =>
      user(ogm).update({
        where,
        disconnect: { posts: [{ ...post, disconnect: { tag: [tag] } }] },
      }),
  },
  'connect inside a nested update connect item': {
    kind: 'connect',
    type: 'Post',
    field: 'tag',
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          posts: [{ connect: [{ ...post, connect: { tag: [tag] } }] }],
        },
      }),
  },
  'disconnect inside a nested update disconnect item': {
    kind: 'disconnect',
    type: 'Post',
    field: 'tag',
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          posts: [{ disconnect: [{ ...post, disconnect: { tag: [tag] } }] }],
        },
      }),
  },
  'connect inside a create() connect item': {
    kind: 'connect',
    type: 'Post',
    field: 'tag',
    run: (ogm) =>
      user(ogm).create({
        input: [
          {
            name: 'A',
            posts: { connect: [{ ...post, connect: { tag: [tag] } }] },
          },
        ],
      }),
  },
};

export const legitLinkShapes: Record<string, Run> = {
  'root connect and disconnect on known relationships': (ogm) =>
    user(ogm).update({
      where,
      connect: { posts: [post] },
      disconnect: { posts: [{ where: { node: { id: 'p2' } } }] },
    }),
  'an unknown key set to undefined': (ogm) =>
    user(ogm).update({
      where,
      connect: { posts: [post], post: undefined },
      disconnect: { post: undefined },
    }),
  'nested connect on a known relationship': (ogm) =>
    user(ogm).update({
      where,
      connect: { posts: [{ ...post, connect: { tags: [tag] } }] },
    }),
  'nested connect through a union / interface member': (ogm) =>
    user(ogm).update({
      where,
      connect: {
        animals: {
          Dog: [
            {
              where: { node: { name: 'Rex' } },
              connect: { toys: [{ where: { node: { id: 'y1' } } }] },
            },
          ],
        },
      },
    }),
  'nested connect / disconnect on known relationships in update and create':
    async (ogm) => {
      await user(ogm).update({
        where,
        update: {
          posts: [
            {
              connect: [{ ...post, connect: { tags: [tag] } }],
              disconnect: [{ ...post, disconnect: { tags: [tag] } }],
            },
          ],
        },
      });
      await user(ogm).create({
        input: [
          {
            name: 'A',
            posts: { connect: [{ ...post, connect: { tags: [tag] } }] },
          },
        ],
      });
    },
};
