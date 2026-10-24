/**
 * v2.6.0 — the write-path input shapes strict mode changes, shared by the
 * byte-identical guard and the strict unit spec.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';

export const writeTypeDefs = /* GraphQL */ `
  type Wrote @relationshipProperties {
    role: String
  }
  type User @node {
    id: ID! @id @unique
    email: String! @unique
    name: String
    pets: [Pet!]! @relationship(type: "HAS", direction: OUT)
    toys: [Toy!]! @relationship(type: "HAS", direction: OUT)
    posts: [Post!]!
      @relationship(type: "WROTE", direction: OUT, properties: "Wrote")
  }
  type Pet @node {
    id: ID! @id @unique
    name: String
  }
  type Toy @node {
    id: ID! @id @unique
    name: String
  }
  type Post @node {
    id: ID! @id @unique
    title: String
  }
`;

export interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

export function recordingDriver(records: Recorded[]): Driver {
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      records.push({ cypher, params });
      return Promise.resolve({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 0,
              nodesDeleted: 0,
              relationshipsCreated: 0,
              relationshipsDeleted: 0,
              propertiesSet: 0,
            }),
          },
        },
      });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { session: jest.fn().mockReturnValue(session) } as unknown as Driver;
}

export type Run = (ogm: OGM) => Promise<unknown>;

const user = (ogm: OGM) => ogm.model('User');
const where = { id: 'u1' };

/** Bad shapes: v2.5.3 compiles them, strict mode changes them. */
export const badWriteShapes: Record<string, Run> = {
  'connect: unknown item key (array, UNWIND path)': (ogm) =>
    user(ogm).update({
      where,
      connect: { pets: [{ wehre: { node: { id: 'p1' } } }] },
    }),
  'connect: unknown item key (single object)': (ogm) =>
    user(ogm).update({
      where,
      connect: { pets: { wehre: { node: { id: 'p1' } } } },
    }),
  'connect: unknown item key (nested in update)': (ogm) =>
    user(ogm).update({
      where,
      update: { pets: [{ connect: [{ wehre: { node: { id: 'p1' } } }] }] },
    }),
  'connect: unknown item key (nested in create)': (ogm) =>
    user(ogm).create({
      input: [
        {
          email: 'a@x',
          pets: { connect: [{ wehre: { node: { id: 'p1' } } }] },
        },
      ],
    }),
  'disconnect: unknown item key': (ogm) =>
    user(ogm).update({
      where,
      disconnect: { pets: [{ wehre: { node: { id: 'p1' } } }] },
    }),
  'disconnect: unknown item key (nested in update)': (ogm) =>
    user(ogm).update({
      where,
      update: { pets: [{ disconnect: [{ wehre: { node: { id: 'p1' } } }] }] },
    }),
  'edge: unknown key on connect (UNWIND path)': (ogm) =>
    user(ogm).update({
      where,
      connect: {
        posts: [{ where: { node: { id: 'p1' } }, edge: { rolee: 'x' } }],
      },
    }),
  'edge: unknown key on connect (single object)': (ogm) =>
    user(ogm).update({
      where,
      connect: {
        posts: { where: { node: { id: 'p1' } }, edge: { rolee: 'x' } },
      },
    }),
  'edge: unknown key on nested create (in create)': (ogm) =>
    user(ogm).create({
      input: [
        {
          email: 'a@x',
          posts: { create: [{ node: { title: 't' }, edge: { rolee: 'x' } }] },
        },
      ],
    }),
  'edge: unknown key on nested create (in update)': (ogm) =>
    user(ogm).update({
      where,
      update: {
        posts: [{ create: [{ node: { title: 't' }, edge: { rolee: 'x' } }] }],
      },
    }),
  'edge: unknown key on nested update': (ogm) =>
    user(ogm).update({
      where,
      update: {
        posts: [
          {
            where: { node: { id: 'p1' } },
            update: { edge: { rolee: 'x' } },
          },
        ],
      },
    }),
  'upsert: two unique keys in where': (ogm) =>
    user(ogm).upsert({
      where: { id: 'u1', email: 'a@x' },
      create: { name: 'A' },
      update: { name: 'B' },
    }),
  'labels: upsert': (ogm) =>
    user(ogm).upsert({
      where: { email: 'a@x' },
      create: { name: 'A' },
      update: { name: 'B' },
      labels: ['Vip'],
    }),
  'labels: createMany skipDuplicates': (ogm) =>
    user(ogm).createMany({
      data: [{ email: 'a@x' }],
      skipDuplicates: true,
      labels: ['Vip'],
    }),
  'blanket disconnect on a shared relationship type': (ogm) =>
    user(ogm).update({ where, disconnect: { pets: {} } }),
  'blanket disconnect on a shared relationship type (nested in update)': (
    ogm,
  ) => user(ogm).update({ where, update: { pets: [{ disconnect: [{}] }] } }),
  // v2.18.0 — strict item 31.
  'disconnect: null item in an array': (ogm) =>
    user(ogm).update({
      where,
      disconnect: { posts: [{ where: { node: { id: 'p1' } } }, null] },
    }),
  'disconnect: undefined item in an array': (ogm) =>
    user(ogm).update({
      where,
      disconnect: { posts: [undefined] },
    }),
  // v2.21.0 — strict item 41: a disconnect item that is not an object. The
  // value-level casts are the point: the generated types reject them.
  'disconnect: string item in an array': (ogm) =>
    user(ogm).update({
      where,
      disconnect: { posts: [{ where: { node: { id: 'p1' } } }, 'p2' as never] },
    }),
  'disconnect: boolean spec': (ogm) =>
    user(ogm).update({ where, disconnect: { posts: true as never } }),
  'disconnect: array item (nested in update)': (ogm) =>
    user(ogm).update({
      where,
      update: { posts: [{ disconnect: [['p1'] as never] }] },
    }),
};

/** Legitimate shapes: never warn, compile the same in both modes. */
export const legitWriteShapes: Record<string, Run> = {
  'connect-all [{}]': (ogm) =>
    user(ogm).update({ where, connect: { pets: [{}] } }),
  'connect with where + edge + overwrite': (ogm) =>
    user(ogm).update({
      where,
      connect: {
        posts: [
          {
            where: { node: { id: 'p1' } },
            edge: { role: 'r' },
            overwrite: true,
          },
        ],
      },
    }),
  'disconnect null': (ogm) =>
    user(ogm).update({ where, disconnect: { posts: null } }),
  'disconnect {} (unshared type)': (ogm) =>
    user(ogm).update({ where, disconnect: { posts: {} } }),
  'disconnect with where': (ogm) =>
    user(ogm).update({
      where,
      disconnect: { pets: [{ where: { node: { id: 'p1' } } }] },
    }),
  'upsert: one unique key': (ogm) =>
    user(ogm).upsert({
      where: { email: 'a@x' },
      create: { name: 'A' },
      update: { name: 'B' },
    }),
  'createMany with labels, no skipDuplicates': (ogm) =>
    user(ogm).createMany({ data: [{ email: 'a@x' }], labels: ['Vip'] }),
  'create with labels': (ogm) =>
    user(ogm).create({ input: [{ email: 'a@x' }], labels: ['Vip'] }),
};
