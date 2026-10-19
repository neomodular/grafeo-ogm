/**
 * v2.7.0 — read / mutation-response shapes WITHOUT `<rel>Aggregate`, whose
 * Cypher must stay byte-identical to v2.6.3 (see
 * `rel-aggregate.byte-identical.spec.ts`). Each shape runs policy-free,
 * policy-bound (the property-suite fixture policies) and under strict mode.
 */
import { OGM } from '../src/ogm';
import { policies, typeDefs } from './integration/properties/schema';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';

export type Run = (ogm: OGM) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = (ogm: OGM, name: string): any => ogm.model(name);

export const shapes: Record<string, Run> = {
  'selectionSet: scalars, nested where/options, connection, union, interface': (
    ogm,
  ) =>
    m(ogm, 'ItPTag').find({
      where: { id: 't1' },
      selectionSet: `{ id name
          charts(where: { name: "a" }, options: { limit: 2, offset: 1 }) { id rank categories { id name } }
          chartsConnection(where: { node: { rank_GT: 0 }, edge: { weight_GTE: 1 } }) { totalCount edges { node { id } properties { weight note } } }
          resources { id ... on ItPChart { secret } }
          items { __typename ... on ItPChart { id name } ... on ItPDoc { id approvedAt } }
          vaults { id } }`,
    }),
  'selectionSet: depth-3 nesting and aliases': (ogm) =>
    m(ogm, 'ItPCategory').find({
      where: { name: 'a' },
      selectionSet: `{ id c: charts { id t: tags { id resources { id } } } }`,
    }),
  'typed select: relationship, connection, union': (ogm) =>
    m(ogm, 'ItPTag').find({
      where: { name: 'a' },
      select: {
        id: true,
        charts: { select: { id: true, name: true }, where: { rank_GT: 1 } },
        chartsConnection: {
          select: {
            totalCount: true,
            edges: { node: { select: { id: true } }, properties: true },
          },
        },
        items: true,
        resources: { select: { id: true, name: true } },
      },
    }),
  'findFirst / count / aggregate': async (ogm) => {
    await m(ogm, 'ItPTag').findFirst({
      where: { charts_SOME: { name: 'a' } },
      selectionSet: '{ id charts { id } }',
    });
    await m(ogm, 'ItPTag').count({ where: { name: 'a' } });
    await m(ogm, 'ItPTag').aggregate({
      where: { name: 'a' },
      aggregate: { count: true, rank: true },
    });
  },
  'InterfaceModel: find with fragments': (ogm) =>
    ogm.interfaceModel('ItPResource').find({
      where: { name: 'a' },
      selectionSet: `{ id name ... on ItPChart { tags { id } categoriesConnection { totalCount } } }`,
    }),
  'mutation responses: create / update selectionSet': async (ogm) => {
    await m(ogm, 'ItPCategory').create({
      input: [{ id: 'k9', name: 'z' }],
      selectionSet: '{ itPCategories { id charts { id name } } }',
    });
    await m(ogm, 'ItPTag').update({
      where: { id: 't1' },
      update: { name: 'q' },
      selectionSet:
        '{ itPTags { id chartsConnection { totalCount edges { node { id } } } } }',
    });
  },
};

export type Mode = 'plain' | 'policies' | 'strict';
export const MODES: readonly Mode[] = ['plain', 'policies', 'strict'];

/** Compile `run` through a recording driver; the statements it sent. */
export async function compileShape(run: Run, mode: Mode): Promise<Recorded[]> {
  const records: Recorded[] = [];
  const ogm = new OGM({
    typeDefs,
    driver: recordingDriver(records),
    ...(mode === 'strict' ? { strict: true } : {}),
    ...(mode === 'policies'
      ? { policies, policyDefaults: { auditMetadata: false } }
      : {}),
  });
  const bound =
    mode === 'policies'
      ? (ogm.withContext({ uid: 'u1', tid: 't1' }) as unknown as OGM)
      : ogm;
  try {
    await run(bound);
  } catch {
    // count / aggregate / mutations read records the recording driver
    // does not return; the statements were already recorded.
  }
  return records;
}
