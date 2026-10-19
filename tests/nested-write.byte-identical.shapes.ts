/**
 * v2.7.1 — nested-write shapes whose default-mode Cypher must stay
 * byte-identical to v2.7.0 (see `nested-write.byte-identical.spec.ts`):
 * nested deletes reached through a cycle (F1), `connect` / `create` on a
 * field an enclosing nested update iterates (F2), and sibling update /
 * create items (F9). Each shape runs policy-free and policy-bound (the
 * property-suite fixture policies).
 */
import { OGM } from '../src/ogm';
import { policies, typeDefs } from './integration/properties/schema';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';

export type Run = (ogm: OGM) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = (ogm: OGM, name: string): any => ogm.model(name);

/** A self-relationship, for the nested-delete-of-a-neighbour shapes. */
export const selfTypeDefs = /* GraphQL */ `
  type BiPerson @node {
    id: ID! @unique
    name: String
    friends: [BiPerson!]! @relationship(type: "BI_FRIEND", direction: OUT)
  }
`;

const cycle = { tags: [{ update: { node: { charts: [{ delete: [{}] }] } } }] };

export const shapes: Record<string, { run: Run; self?: boolean }> = {
  'update: nested delete through a cycle (chart -> tags -> charts)': {
    run: (ogm) =>
      m(ogm, 'ItPChart').update({
        where: { id: 'c1' },
        update: cycle,
        selectionSet: '{ itPCharts { id name tags { id } } }',
      }),
  },
  'updateMany: nested delete through a cycle, count only': {
    run: (ogm) =>
      m(ogm, 'ItPChart').updateMany({
        where: { id_IN: ['c1', 'c4'] },
        data: {
          name: 'z',
          tags: [
            {
              where: { node: { id: 't2' } },
              update: { node: { charts: [{ delete: [{}] }] } },
            },
          ],
        },
      }),
  },
  'updateMany: cycle delete, then a create from the root': {
    run: (ogm) =>
      m(ogm, 'ItPChart').updateMany({
        where: { id: 'c1' },
        data: {
          ...cycle,
          categories: [{ create: [{ node: { id: 'kx', runId: 'r' } }] }],
        },
      }),
  },
  'update: two roots, one deletes the other through the cycle': {
    run: (ogm) =>
      m(ogm, 'ItPChart').update({
        where: { id_IN: ['c1', 'c2'] },
        update: {
          name: 'z',
          tags: [
            {
              where: { node: { id: 't1' } },
              update: {
                node: {
                  charts: [{ delete: [{ where: { node: { id: 'c2' } } }] }],
                },
              },
            },
          ],
        },
        selectionSet: '{ itPCharts { id name } }',
      }),
  },
  'update: nested delete reaches an intermediate node': {
    run: (ogm) =>
      m(ogm, 'ItPTag').update({
        where: { id: 't1' },
        update: {
          name: 'renamed',
          charts: [
            {
              where: { node: { id: 'c1' } },
              update: {
                node: {
                  tags: [
                    {
                      update: {
                        node: {
                          charts: [
                            { delete: [{ where: { node: { id: 'c1' } } }] },
                          ],
                        },
                      },
                    },
                  ],
                  categories: [
                    { create: [{ node: { id: 'kx', runId: 'r' } }] },
                  ],
                },
              },
            },
          ],
        },
        selectionSet: '{ itPTags { id name charts { id } } }',
      }),
  },
  'update: union member update with a cycle delete': {
    run: (ogm) =>
      m(ogm, 'ItPTag').update({
        where: { id: 't1' },
        update: {
          items: {
            ItPChart: [
              { update: { node: { name: 'q', tags: [{ delete: [{}] }] } } },
            ],
          },
        },
        selectionSet: '{ itPTags { id } }',
      }),
  },
  'update: interface member body with a cycle delete': {
    run: (ogm) =>
      m(ogm, 'ItPTag').update({
        where: { id: 't1' },
        update: {
          resources: [
            {
              update: {
                node: { ItPChart: { name: 'q', tags: [{ delete: [{}] }] } },
              },
            },
          ],
        },
        selectionSet: '{ itPTags { id } }',
      }),
  },
  'update: nested delete of a type that is no ancestor': {
    run: (ogm) =>
      m(ogm, 'ItPChart').update({
        where: { id: 'c1' },
        update: {
          tags: [{ update: { node: { vaults: [{ delete: [{}] }] } } }],
        },
        selectionSet: '{ itPCharts { id } }',
      }),
  },
  'update: self-relationship nested delete': {
    self: true,
    run: (ogm) =>
      m(ogm, 'BiPerson').update({
        where: { id: 'p1' },
        update: { name: 'z', friends: [{ delete: [{}] }] },
        selectionSet: '{ biPeople { id name friends { id } } }',
      }),
  },
  'updateMany: self-relationship friends of friends delete': {
    self: true,
    run: (ogm) =>
      m(ogm, 'BiPerson').updateMany({
        where: { name: 'a' },
        data: {
          friends: [
            {
              update: {
                node: { friends: [{ delete: [{ where: { node: {} } }] }] },
              },
            },
          ],
        },
      }),
  },
  'updateMany: connect / create on a field an enclosing update iterates (F2)': {
    run: (ogm) =>
      m(ogm, 'ItPChart').updateMany({
        where: { runId: 'r' },
        data: {
          categories: [
            {
              update: {
                node: {
                  charts: [
                    {
                      update: {
                        node: {
                          categories: [
                            {
                              connect: [{ where: { node: { runId: 'r' } } }],
                              create: [{ node: { id: 'x', runId: 'r' } }],
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      }),
  },
  'updateMany: sibling update and create items (F9)': {
    run: (ogm) =>
      m(ogm, 'ItPChart').updateMany({
        where: { runId: 'r' },
        data: {
          tags: [
            {
              update: {
                node: {
                  resources: [
                    { update: { node: { name: 'a' } } },
                    {
                      create: [
                        {
                          node: {
                            ItPChart: { id: 'n3', runId: 'r', tenantId: 't1' },
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        },
      }),
  },
};

export type Mode = 'plain' | 'policies';
export const MODES: readonly Mode[] = ['plain', 'policies'];

/** Compile `run` through a recording driver; the statements it sent. */
export async function compileShape(
  run: Run,
  mode: Mode | 'strict',
  self = false,
  warnings: string[] = [],
): Promise<Recorded[]> {
  const records: Recorded[] = [];
  const ogm = new OGM({
    typeDefs: self ? selfTypeDefs : typeDefs,
    driver: recordingDriver(records),
    logger: { debug: () => {}, warn: (msg: string) => warnings.push(msg) },
    ...(mode === 'strict' ? { strict: true } : {}),
    ...(mode === 'policies' && !self
      ? { policies, policyDefaults: { auditMetadata: false } }
      : {}),
  });
  const bound =
    mode === 'policies' && !self
      ? (ogm.withContext({
          uid: 'u1',
          tid: 't1',
          canCreateChart: true,
        }) as unknown as OGM)
      : ogm;
  try {
    await run(bound);
  } catch (err) {
    // updateMany reads a `count` record the recording driver does not
    // return; the statement was already recorded.
    if (records.length === 0) throw err;
  }
  return records;
}
