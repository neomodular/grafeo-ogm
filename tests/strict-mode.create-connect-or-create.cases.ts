/**
 * vNEXT — strict item 43: `connectOrCreate` in a create field input
 * (`create()` and the relationship fields of a nested create), shared by
 * the unit spec and its byte-identical guard. Schema: `rootOpsTypeDefs`.
 */
import type { OGM } from '../src/ogm';
import type { Run } from './strict-mode.writes.cases';

const user = (ogm: OGM) => ogm.model('User');
/** Not a fresh literal, so TypeScript's excess-property check lets it through. */
const extra = <T extends object>(o: T): T => o;

/** Shapes default mode ignores (and warns about); strict mode applies them. */
export const createCocShapes: Record<string, Run> = {
  'create: connectOrCreate': (ogm) =>
    user(ogm).create({
      input: [
        extra({
          email: 'a@x',
          posts: {
            connectOrCreate: [
              {
                where: { node: { slug: 's1' } },
                onCreate: { node: { title: 't1' }, edge: { role: 'r' } },
              },
            ],
          },
        }),
      ],
    }),
  'create: connectOrCreate after create and connect, two inputs': (ogm) =>
    user(ogm).create({
      input: [
        extra({
          email: 'a@x',
          posts: {
            create: [{ node: { title: 'c' } }],
            connect: [{ where: { node: { slug: 'k' } } }],
            connectOrCreate: [
              { where: { node: { slug: 's1' } }, onCreate: { node: {} } },
            ],
          },
        }),
        extra({
          email: 'b@x',
          best: {
            connectOrCreate: {
              where: { node: { slug: 's2' } },
              onCreate: { node: { title: 'b' } },
            },
          },
        }),
      ],
    }),
  'create: connectOrCreate in a nested create, per union member': (ogm) =>
    user(ogm).create({
      input: [
        extra({
          email: 'a@x',
          posts: {
            create: [
              {
                node: {
                  title: 'p',
                  tags: {
                    connectOrCreate: [
                      {
                        where: { node: { name: 'go' } },
                        onCreate: { node: { label: 'L' } },
                      },
                    ],
                  },
                },
              },
            ],
          },
          media: {
            Tag: {
              connectOrCreate: [
                { where: { node: { name: 'go' } }, onCreate: { node: {} } },
              ],
            },
          },
        }),
      ],
    }),
  'update: connectOrCreate in a nested create of an update item': (ogm) =>
    user(ogm).update({
      where: { id: 'u1' },
      update: {
        posts: [
          {
            create: [
              {
                node: extra({
                  title: 'p',
                  tags: {
                    connectOrCreate: [
                      {
                        where: { node: { name: 'go' } },
                        onCreate: { node: {} },
                      },
                    ],
                  },
                }),
              },
            ],
          },
        ],
      },
    }),
};
