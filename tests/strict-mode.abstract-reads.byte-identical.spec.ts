/**
 * v2.6.2 — strict mode must not change default-mode read Cypher for
 * interface / union relationship fields (property-suite finding F8). For
 * every read path that reaches an abstract target — nested selection,
 * connection edges and `totalCount`, relationship and connection filters,
 * null filters, count and aggregate — the Cypher and params compiled with
 * `strict` unset and with `strict: false` are identical, and the Cypher is
 * byte-identical to v2.6.0 (hard-coded below, captured from v2.6.0 main).
 */
import { OGM } from '../src/ogm';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';
import { allowAllPolicies, typeDefs } from './integration/properties/schema';

type Run = (ogm: OGM) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tag = (ogm: OGM): any => ogm.model('ItPTag');
const where =
  (w: Record<string, unknown>): Run =>
  (ogm) =>
    tag(ogm).find({ where: { runId: 'r', ...w }, selectionSet: '{ id }' });

const abstractReadShapes: Record<string, Run> = {
  'typed select: list, connection edges and totalCount': (ogm) =>
    tag(ogm).find({
      where: { id: 't1' },
      select: {
        id: true,
        resources: { select: { id: true }, where: { name: 'a' } },
        resourcesConnection: {
          select: {
            totalCount: true,
            edges: { node: { select: { id: true } } },
          },
        },
      },
    }),
  'selectionSet: list with where, connection with where': (ogm) =>
    tag(ogm).find({
      where: { id: 't1' },
      selectionSet: `{ id resources(where: { name: "a" }) { id __typename }
        resourcesConnection(where: { node: { name: "a" } }) { totalCount edges { node { id } } } }`,
    }),
  'selectionSet: union list': (ogm) =>
    tag(ogm).find({
      where: { id: 't1' },
      selectionSet: `{ id items { __typename ... on ItPChart { id } ... on ItPDoc { name } } }`,
    }),
  resources_SOME: where({ resources_SOME: { id: 'v1' } }),
  'resources (bare)': where({ resources: { id: 'v1' } }),
  resources_NONE: where({ resources_NONE: { id: 'v1' } }),
  resources_NOT: where({ resources_NOT: { id: 'v1' } }),
  resources_ALL: where({ resources_ALL: { name: 'b' } }),
  resources_SINGLE: where({ resources_SINGLE: { name: 'a' } }),
  resourcesConnection: where({ resourcesConnection: { node: { id: 'v1' } } }),
  resourcesConnection_NONE: where({
    resourcesConnection_NONE: { node: { name: 'a' } },
  }),
  resourcesConnection_ALL: where({
    resourcesConnection_ALL: { node: { name: 'a' } },
  }),
  resourcesConnection_SINGLE: where({
    resourcesConnection_SINGLE: { node: { name: 'a' } },
  }),
  'resources: null': where({ resources: null }),
  'resources_NOT: null': where({ resources_NOT: null }),
  items_SOME: where({ items_SOME: { ItPChart: { name: 'a' } } }),
  count: (ogm) =>
    tag(ogm).count({ where: { runId: 'r', resources_SOME: { id: 'v1' } } }),
  aggregate: (ogm) =>
    tag(ogm).aggregate({
      where: { runId: 'r', resourcesConnection: { node: { id: 'v2' } } },
      aggregate: { count: true },
    }),
  'allow-all policies: list and filter': (ogm) =>
    tag(ogm.withContext({}) as unknown as OGM).find({
      where: { runId: 'r', resources_SOME: { id: 'v1' } },
      selectionSet: '{ id resources { id } }',
    }),
};

/** v2.6.0 Cypher for each shape (statements joined by `\n;;\n`). */
const V260: Record<string, string> = {
  'typed select: list, connection edges and totalCount':
    "MATCH (n:`ItPTag`)\nWHERE n.`id` = $param0\nRETURN n { .`id`, resources: [(n)-[:`ITP_RES`]->(n0) WHERE n0.`name` = $param1 | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['ItPChart', 'ItPDrug']]), .`id` }], resourcesConnection: { edges: [(n)-[e0:`ITP_RES`]->(n0) | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['ItPChart', 'ItPDrug']]), .`id` } }], totalCount: size([(n)-[e0:`ITP_RES`]->(n0) | 1]) } }",
  'selectionSet: list with where, connection with where':
    "MATCH (n:`ItPTag`)\nWHERE n.`id` = $param0\nRETURN n { .`id`, resources: [(n)-[:`ITP_RES`]->(n0) WHERE n0.`name` = $param1 | n0 { .`id`, __typename: head([__label IN labels(n0) WHERE __label IN ['ItPChart', 'ItPDrug']]) }], resourcesConnection: { edges: [(n)-[e0:`ITP_RES`]->(n0) WHERE n0.`name` = $param2 | { node: n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['ItPChart', 'ItPDrug']]), .`id` } }], totalCount: size([(n)-[e0:`ITP_RES`]->(n0) WHERE n0.`name` = $param2 | 1]) } }",
  'selectionSet: union list':
    "MATCH (n:`ItPTag`)\nWHERE n.`id` = $param0\nRETURN n { .`id`, items: [(n)-[:`ITP_ITEM`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['ItPChart', 'ItPDoc']]), .`id`, .`name` }] }",
  resources_SOME:
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND EXISTS { MATCH (n)-[:`ITP_RES`]->(r1) WHERE r1.`id` = $param2 }\nRETURN n { .`id` }',
  'resources (bare)':
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND EXISTS { MATCH (n)-[:`ITP_RES`]->(r1) WHERE r1.`id` = $param2 }\nRETURN n { .`id` }',
  resources_NONE:
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND NOT EXISTS { MATCH (n)-[:`ITP_RES`]->(r1) WHERE r1.`id` = $param2 }\nRETURN n { .`id` }',
  resources_NOT:
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND NOT EXISTS { MATCH (n)-[:`ITP_RES`]->(r1) WHERE r1.`id` = $param2 }\nRETURN n { .`id` }',
  resources_ALL:
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND NOT EXISTS { MATCH (n)-[:`ITP_RES`]->(r1) WHERE NOT (r1.`name` = $param2) }\nRETURN n { .`id` }',
  resources_SINGLE:
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND size([(n)-[:`ITP_RES`]->(r1) WHERE r1.`name` = $param2 | r1]) = 1\nRETURN n { .`id` }',
  resourcesConnection:
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND EXISTS { MATCH (n)-[e1:`ITP_RES`]->(r1) WHERE r1.`id` = $param2 }\nRETURN n { .`id` }',
  resourcesConnection_NONE:
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND NOT EXISTS { MATCH (n)-[e1:`ITP_RES`]->(r1) WHERE r1.`name` = $param2 }\nRETURN n { .`id` }',
  resourcesConnection_ALL:
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND NOT EXISTS { MATCH (n)-[e1:`ITP_RES`]->(r1) WHERE NOT (r1.`name` = $param2) }\nRETURN n { .`id` }',
  resourcesConnection_SINGLE:
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND size([(n)-[e1:`ITP_RES`]->(r1) WHERE r1.`name` = $param2 | 1]) = 1\nRETURN n { .`id` }',
  'resources: null':
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND NOT EXISTS { MATCH (n)-[:`ITP_RES`]->(r1) }\nRETURN n { .`id` }',
  'resources_NOT: null':
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND EXISTS { MATCH (n)-[:`ITP_RES`]->(r1) }\nRETURN n { .`id` }',
  items_SOME:
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND EXISTS { MATCH (n)-[:`ITP_ITEM`]->(r1:`ItPChart`) WHERE r1.`name` = $param2 }\nRETURN n { .`id` }',
  count:
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND EXISTS { MATCH (n)-[:`ITP_RES`]->(r1) WHERE r1.`id` = $param2 }\nRETURN count(n) AS count',
  aggregate:
    'MATCH (n:`ItPTag`)\nWHERE n.`runId` = $param0 AND EXISTS { MATCH (n)-[e1:`ITP_RES`]->(r1) WHERE r1.`id` = $param2 }\nRETURN count(n) AS count',
  'allow-all policies: list and filter':
    "MATCH (n:`ItPTag`)\nWHERE (n.`runId` = $param0 AND EXISTS { MATCH (n)-[:`ITP_RES`]->(r1) WHERE (r1.`id` = $param2) AND ((r1:`ItPChart` OR r1:`ItPDrug`) AND (NOT r1:`ItPChart` OR true) AND (NOT r1:`ItPDrug` OR true)) }) AND true\nRETURN n { .`id`, resources: [(n)-[:`ITP_RES`]->(n0) WHERE ((n0:`ItPChart` OR n0:`ItPDrug`) AND (NOT n0:`ItPChart` OR true) AND (NOT n0:`ItPDrug` OR true)) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['ItPChart', 'ItPDrug']]), .`id` }] }",
};

async function compile(
  run: Run,
  strict: boolean | undefined,
  policies: boolean,
): Promise<Recorded[]> {
  const records: Recorded[] = [];
  const ogm = new OGM({
    typeDefs,
    driver: recordingDriver(records),
    ...(strict === undefined ? {} : { strict }),
    ...(policies
      ? { policies: allowAllPolicies, policyDefaults: { auditMetadata: false } }
      : {}),
  });
  try {
    await run(ogm);
  } catch {
    // count / aggregate read a record the recording driver does not return.
  }
  return records;
}

describe('strict mode off: abstract-target read Cypher is byte-identical to v2.6.0 (v2.6.2)', () => {
  const cases = Object.entries(abstractReadShapes);
  const policies = (name: string) => name.startsWith('allow-all');

  it('covers every shape', () => {
    expect(Object.keys(V260).sort()).toEqual(cases.map(([n]) => n).sort());
  });

  it.each(cases)('%s', async (name, run) => {
    const unset = await compile(run, undefined, policies(name));
    const off = await compile(run, false, policies(name));
    expect(off).toEqual(unset);
    expect(unset.length).toBeGreaterThan(0);
    expect(unset.map((r) => r.cypher).join('\n;;\n')).toBe(V260[name]);
  });
});
