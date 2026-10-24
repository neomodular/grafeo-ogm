/**
 * v2.22.0 — strict item 43: the @neo4j/graphql 5.x relationship ops of
 * `update()` that strict mode applies — a nested `connectOrCreate` in an
 * update item, and a root `create` / `connectOrCreate` / `delete` —
 * shared by the unit spec and its byte-identical guard.
 */
import type { OGM } from '../src/ogm';
import type { Run } from './strict-mode.writes.cases';

export const rootOpsTypeDefs = /* GraphQL */ `
  type Wrote @relationshipProperties {
    role: String
    since: Int @default(value: 1)
  }
  type User @node {
    id: ID! @id @unique
    email: String! @unique
    name: String
    posts: [Post!]!
      @relationship(type: "WROTE", direction: OUT, properties: "Wrote")
    media: [Media!]! @relationship(type: "HAS_MEDIA", direction: OUT)
    animals: [Animal!]! @relationship(type: "OWNS", direction: OUT)
    best: Post @relationship(type: "BEST", direction: OUT)
  }
  type Post @node {
    id: ID! @id @unique
    slug: String @unique
    title: String
    views: Int @default(value: 0)
    tags: [Tag!]! @relationship(type: "TAGGED", direction: OUT)
  }
  type Tag @node {
    name: String! @unique
    label: String
  }
  union Media = Post | Tag
  interface Animal {
    name: String
  }
  type Dog implements Animal @node {
    name: String @unique
  }
`;

const user = (ogm: OGM) => ogm.model('User');
const where = { id: 'u1' };
/** Not a fresh literal, so TypeScript's excess-property check lets it through. */
const extra = <T extends object>(o: T): T => o;

/** Shapes default mode ignores (and warns about); strict mode applies them. */
export const rootOpShapes: Record<string, Run> = {
  'nested connectOrCreate': (ogm) =>
    user(ogm).update(
      extra({
        where,
        update: {
          name: 'n',
          posts: [
            {
              connectOrCreate: [
                {
                  where: { node: { slug: 's1' } },
                  onCreate: { node: { title: 't1' }, edge: { role: 'r' } },
                },
              ],
            },
          ],
        },
      }),
    ),
  'root create': (ogm) =>
    user(ogm).update(
      extra({
        where,
        update: { name: 'n' },
        create: { posts: [{ node: { title: 't1' }, edge: { role: 'r' } }] },
      }),
    ),
  'root connectOrCreate': (ogm) =>
    user(ogm).update(
      extra({
        where,
        connectOrCreate: {
          posts: [
            {
              where: { node: { slug: 's1' } },
              onCreate: { node: { title: 't1' } },
            },
          ],
        },
      }),
    ),
  'root delete': (ogm) =>
    user(ogm).update(
      extra({
        where,
        delete: { posts: [{ where: { node: { slug: 's1' } } }] },
      }),
    ),
  'updateMany: nested connectOrCreate': (ogm) =>
    user(ogm).updateMany(
      extra({
        where,
        data: {
          posts: [
            {
              connectOrCreate: [
                {
                  where: { node: { slug: 's1' } },
                  onCreate: { node: {} },
                },
              ],
            },
          ],
        },
      }),
    ),
};
