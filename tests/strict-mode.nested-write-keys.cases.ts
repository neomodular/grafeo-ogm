/**
 * v2.10.0 — strict item 22: the nested write input shapes with keys the
 * compiler does not read, shared by the unit spec and the byte-identical
 * guard. Connect / disconnect items are item 1 (strict-mode.writes.cases).
 */
import { OGM } from '../src/ogm';
import type { Run } from './strict-mode.writes.cases';

export const nestedKeyTypeDefs = /* GraphQL */ `
  type Wrote @relationshipProperties {
    role: String
  }
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
    name: String
    posts: [Post!]!
      @relationship(type: "WROTE", direction: OUT, properties: "Wrote")
    media: [Media!]! @relationship(type: "OWNS", direction: OUT)
    animals: [Animal!]! @relationship(type: "KEEPS", direction: OUT)
  }
  type Post @node {
    id: ID! @id @unique
    title: String
    tags: [Tag!]! @relationship(type: "TAGGED", direction: OUT)
  }
  type Tag @node {
    id: ID! @id @unique
    name: String
  }
  union Media = Post | Tag
`;

const user = (ogm: OGM) => ogm.model('User');
const where = { id: 'u1' };

/**
 * Each bad shape with the unknown key(s), the field it is reported on and
 * the shape name used in the messages.
 */
export interface BadNestedShape {
  run: Run;
  keys: string;
  field: string;
  what: string;
  allowed: string;
}

const ITEM = '"where", "update", "connect", "disconnect", "create", "delete"';
const FIELD_INPUT = '"create", "connect"';
const WRAPPER = '"node", "edge"';
const UPDATE_ITEM = 'a nested update item';
const CREATE_INPUT = 'the nested create input';
const CREATE_ITEM = 'a nested create item';
const UPDATE_BODY = 'the "update" of a nested update item';

export const badNestedShapes: Record<string, BadNestedShape> = {
  'update item: "wher" next to update (renames every post)': {
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          posts: [
            {
              wher: { node: { title: 'a' } },
              update: { node: { title: 'X' } },
            },
          ],
        },
      }),
    keys: '"wher"',
    field: 'posts',
    what: UPDATE_ITEM,
    allowed: ITEM,
  },
  'update item: "updat" (update dropped)': {
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          posts: [
            { where: { node: { id: 'p1' } }, updat: { node: { title: 'X' } } },
          ],
        },
      }),
    keys: '"updat"',
    field: 'posts',
    what: UPDATE_ITEM,
    allowed: ITEM,
  },
  'update item: single object, two unknown keys': {
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          posts: {
            wher: { node: { title: 'a' } },
            creat: [{ node: { title: 'n' } }],
            update: { node: { title: 'X' } },
          },
        },
      }),
    keys: '"wher", "creat"',
    field: 'posts',
    what: UPDATE_ITEM,
    allowed: ITEM,
  },
  'update item: per union member': {
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          media: {
            Post: [
              {
                wher: { node: { title: 'a' } },
                update: { node: { title: 'X' } },
              },
            ],
          },
        },
      }),
    keys: '"wher"',
    field: 'media',
    what: UPDATE_ITEM,
    allowed: ITEM,
  },
  'update item: flat interface input': {
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          animals: [
            { wher: { node: { name: 'a' } }, update: { node: { name: 'X' } } },
          ],
        },
      }),
    keys: '"wher"',
    field: 'animals',
    what: UPDATE_ITEM,
    allowed: ITEM,
  },
  'update item: two levels down': {
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          posts: [
            {
              where: { node: { id: 'p1' } },
              update: {
                node: {
                  tags: [
                    {
                      wher: { node: { name: 'a' } },
                      update: { node: { name: 'X' } },
                    },
                  ],
                },
              },
            },
          ],
        },
      }),
    keys: '"wher"',
    field: 'tags',
    what: UPDATE_ITEM,
    allowed: ITEM,
  },
  'update body: node field beside edge (dropped)': {
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          posts: [
            {
              where: { node: { id: 'p1' } },
              update: { edge: { role: 'r' }, title: 'NEW' },
            },
          ],
        },
      }),
    keys: '"title"',
    field: 'posts',
    what: UPDATE_BODY,
    allowed: WRAPPER,
  },
  'update body: "egde" beside node': {
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          posts: [
            {
              where: { node: { id: 'p1' } },
              update: { node: { title: 'x' }, egde: { role: 'r' } },
            },
          ],
        },
      }),
    keys: '"egde"',
    field: 'posts',
    what: UPDATE_BODY,
    allowed: WRAPPER,
  },
  'create item (in update): "egde" beside node': {
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          posts: [{ create: [{ node: { title: 't' }, egde: { role: 'r' } }] }],
        },
      }),
    keys: '"egde"',
    field: 'posts',
    what: CREATE_ITEM,
    allowed: WRAPPER,
  },
  'create item (in create): "egde" beside node': {
    run: (ogm) =>
      user(ogm).create({
        input: [
          {
            name: 'a',
            posts: { create: [{ node: { title: 't' }, egde: { role: 'r' } }] },
          },
        ],
      }),
    keys: '"egde"',
    field: 'posts',
    what: CREATE_ITEM,
    allowed: WRAPPER,
  },
  'create item: per union member': {
    run: (ogm) =>
      user(ogm).create({
        input: [
          {
            name: 'a',
            media: {
              Tag: { create: [{ node: { name: 't' }, egde: { role: 'r' } }] },
            },
          },
        ],
      }),
    keys: '"egde"',
    field: 'media',
    what: CREATE_ITEM,
    allowed: WRAPPER,
  },
  'create field input: "creat" in create()': {
    run: (ogm) =>
      user(ogm).create({
        input: [{ name: 'a', posts: { creat: [{ node: { title: 't' } }] } }],
      }),
    keys: '"creat"',
    field: 'posts',
    what: CREATE_INPUT,
    allowed: FIELD_INPUT,
  },
  'create field input: inside a nested create node': {
    run: (ogm) =>
      user(ogm).update({
        where,
        update: {
          posts: [
            {
              create: [
                {
                  node: {
                    title: 't',
                    tags: { creat: [{ node: { name: 'n' } }] },
                  },
                },
              ],
            },
          ],
        },
      }),
    keys: '"creat"',
    field: 'tags',
    what: CREATE_INPUT,
    allowed: FIELD_INPUT,
  },
  'create field input: per union member': {
    run: (ogm) =>
      user(ogm).create({
        input: [
          {
            name: 'a',
            media: { Post: { creat: [{ node: { title: 't' } }] } },
          },
        ],
      }),
    keys: '"creat"',
    field: 'media',
    what: CREATE_INPUT,
    allowed: FIELD_INPUT,
  },
};

/** Legitimate shapes: never warn, compile the same in both modes. */
export const legitNestedShapes: Record<string, Run> = {
  'update items using every item key': (ogm) =>
    user(ogm).update({
      where,
      update: {
        posts: [
          {
            where: { node: { id: 'p1' } },
            update: { node: { title: 'x' }, edge: { role: 'r' } },
            disconnect: [{ where: { node: { id: 'p2' } } }],
            delete: [{ where: { node: { id: 'p3' } } }],
          },
          {
            connect: [{ where: { node: { id: 'p4' } }, edge: { role: 'c' } }],
            create: [{ node: { title: 'n' }, edge: { role: 'n' } }],
          },
        ],
      },
    }),
  'flat update body and flat create item (no wrapper)': (ogm) =>
    user(ogm).update({
      where,
      update: {
        posts: [
          { where: { node: { id: 'p1' } }, update: { title: 'x' } },
          { create: [{ title: 'n' }] },
        ],
      },
    }),
  'update body with edge only, node null': (ogm) =>
    user(ogm).update({
      where,
      update: {
        posts: [
          {
            where: { node: { id: 'p1' } },
            update: { node: null, edge: { role: 'r' } },
          },
        ],
      },
    }),
  'an unknown key set to undefined': (ogm) =>
    user(ogm).update({
      where,
      update: {
        posts: [
          {
            where: { node: { id: 'p1' } },
            update: { node: { title: 'x' }, extra: undefined },
            extra: undefined,
          },
        ],
      },
    }),
  'create() with create + connect': (ogm) =>
    user(ogm).create({
      input: [
        {
          name: 'a',
          posts: {
            create: [
              {
                node: {
                  title: 't',
                  tags: { create: [{ node: { name: 'g' } }] },
                },
                edge: { role: 'r' },
              },
            ],
            connect: [{ where: { node: { id: 'p1' } } }],
          },
        },
      ],
    }),
  'union per member, create and update': (ogm) =>
    user(ogm).update({
      where,
      update: {
        media: {
          Post: [
            { where: { node: { id: 'p1' } }, update: { node: { title: 'x' } } },
          ],
          Tag: [{ create: [{ node: { name: 't' } }] }],
        },
      },
    }),
  'flat interface update and create': (ogm) =>
    user(ogm).update({
      where,
      update: {
        animals: [
          { where: { node: { name: 'a' } }, update: { node: { name: 'b' } } },
          { create: [{ node: { Dog: { name: 'd' } } }] },
        ],
      },
    }),
};
