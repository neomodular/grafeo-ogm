/**
 * v2.9.0 — strict mode reads a `<rel>Connection` under a union parent
 * through each member's own relationship. With `strict` off (or unset)
 * every shape compiles to the v2.8.0 Cypher, byte for byte (hard-coded
 * below, captured from v2.8.0 main, d6bf906) — including the shapes whose
 * members differ, which only warn.
 */
import { OGM } from '../src/ogm';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';
import {
  fixedShapes,
  policies,
  Run,
  typeDefs,
  unchangedSecuredShapes,
  unchangedShapes,
} from './union-connection.cases';

/** v2.8.0 Cypher for each shape. */
const V280: Record<string, string> = {
  'non-union parent: typed select':
    'MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { post: head([(n)-[:`UC_POST`]->(n0:`UcPost`) | n0 { tagsConnection: { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | { node: n1 { .`name` }, properties: e1 { .`weight` } }], totalCount: size([(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | 1]) } }]) }',
  'non-union parent: selectionSet with where':
    'MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { post: head([(n)-[:`UC_POST`]->(n0:`UcPost`) | n0 { tagsConnection: { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) WHERE n1.`name` = $param1 | { node: n1 { .`name` }, properties: e1 { .`weight` } }], totalCount: size([(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) WHERE n1.`name` = $param1 | 1]) } }]) }',
  'shared pattern: typed select':
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { same: [(n)-[:`UC_SAME`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcAudio']]), tagsConnection: { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | { node: n1 { .`name` }, properties: e1 { .`weight` } }], totalCount: size([(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | 1]) } }] }",
  'shared pattern: typed select with where':
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { same: [(n)-[:`UC_SAME`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcAudio']]), tagsConnection: { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) WHERE n1.`name` STARTS WITH $param1 | { node: n1 { .`name` } }] } }] }",
  'shared pattern: fragments':
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { same: [(n)-[:`UC_SAME`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcAudio']]), tagsConnection: { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | { node: n1 { .`name` } }], totalCount: size([(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | 1]) } }] }",
  'single member: typed select':
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { one: [(n)-[:`UC_ONE`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcVideo']]), tagsConnection: { edges: [(n0)<-[e1:`UC_LABELED`]-(n1:`UcTag`) | { node: n1 { .`name` }, properties: e1 { .`weight` } }], totalCount: size([(n0)<-[e1:`UC_LABELED`]-(n1:`UcTag`) | 1]) } }] }",
  'single member: fragment':
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { one: [(n)-[:`UC_ONE`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcVideo']]), tagsConnection: { edges: [(n0)<-[e1:`UC_LABELED`]-(n1:`UcTag`) | { node: n1 { .`name` } }], totalCount: size([(n0)<-[e1:`UC_LABELED`]-(n1:`UcTag`) | 1]) } }] }",
  'only the first member declares it: typed select':
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { part: [(n)-[:`UC_PART`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcNote']]), tagsConnection: { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | { node: n1 { .`name` }, properties: e1 { .`weight` } }], totalCount: size([(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | 1]) } }] }",
  'only the first member declares it: fragment':
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { part: [(n)-[:`UC_PART`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcNote']]), tagsConnection: { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | { node: n1 { .`name` } }], totalCount: size([(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | 1]) }, .`body` }] }",
  'differing member a sort cannot compile for: fragments':
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { targets: [(n)-[:`UC_TARGETS`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcClip']]), tagsConnection: { edges: [x IN apoc.coll.sortMulti([(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | { node: n1 { .`name` }, __sk0: n1.`name` }], ['^__sk0']) | { node: x.node }] } }] }",
  'secured shared pattern: typed select':
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { same: [(n)-[:`UC_SAME`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcAudio']]), tagsConnection: { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) WHERE (true AND (n1.`secret` = $param1)) | { node: n1 { .`name` }, properties: e1 { .`weight` } }], totalCount: size([(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) WHERE (true AND (n1.`secret` = $param1)) | 1]) } }] }",
  'secured single member: typed select':
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { one: [(n)-[:`UC_ONE`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcVideo']]), tagsConnection: { edges: [(n0)<-[e1:`UC_LABELED`]-(n1:`UcTag`) WHERE (true AND (n1.`secret` = $param1)) | { node: n1 { .`name` }, properties: e1 { .`weight` } }], totalCount: size([(n0)<-[e1:`UC_LABELED`]-(n1:`UcTag`) WHERE (true AND (n1.`secret` = $param1)) | 1]) } }] }",
  mixedSelect:
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { mixed: [(n)-[:`UC_MIXED`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcVideo', 'UcAudio']]), tagsConnection: { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | { node: n1 { .`name` }, properties: e1 { .`weight` } }], totalCount: size([(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | 1]) } }] }",
  mixedWhere:
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { mixed: [(n)-[:`UC_MIXED`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcVideo', 'UcAudio']]), tagsConnection: { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) WHERE n1.`name` STARTS WITH $param1 | { node: n1 { .`name` } }] } }] }",
  mixedFragments:
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { mixed: [(n)-[:`UC_MIXED`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcVideo', 'UcAudio']]), tagsConnection: { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | { node: n1 { .`name` } }], totalCount: size([(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | 1]) } }] }",
  targetsWhere:
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { targets: [(n)-[:`UC_TARGETS`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcClip']]), tagsConnection: { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) WHERE n1.`name` STARTS WITH $param1 | { node: n1 { .`name` } }] } }] }",
};

/** Shapes with a member whose relationship differs from the first one's. */
const differing = new Set([
  ...Object.keys(fixedShapes),
  'differing member a sort cannot compile for: fragments',
]);

async function compile(
  run: Run,
  strict: boolean | undefined,
  secured: boolean,
) {
  const records: Recorded[] = [];
  const logger = { debug: jest.fn(), warn: jest.fn() };
  const ogm = new OGM({
    typeDefs,
    driver: recordingDriver(records),
    logger,
    ...(strict === undefined ? {} : { strict }),
    ...(secured ? { policies, policyDefaults: { auditMetadata: false } } : {}),
  });
  await run(secured ? (ogm.withContext({}) as unknown as OGM) : ogm);
  return { records, logger };
}

describe('connection under a union parent: default-mode Cypher is byte-identical to v2.8.0 (v2.9.0)', () => {
  const cases: Array<[string, Run, boolean]> = [
    ...Object.entries({ ...unchangedShapes, ...fixedShapes }).map(
      ([n, r]): [string, Run, boolean] => [n, r, false],
    ),
    ...Object.entries(unchangedSecuredShapes).map(
      ([n, r]): [string, Run, boolean] => [n, r, true],
    ),
  ];

  it('covers every shape', () => {
    expect(Object.keys(V280).sort()).toEqual(cases.map(([n]) => n).sort());
  });

  it.each(cases)('%s', async (name, run, secured) => {
    const unset = await compile(run, undefined, secured);
    const off = await compile(run, false, secured);
    expect(off.records).toEqual(unset.records);
    expect(unset.records).toHaveLength(1);
    expect(unset.records[0].cypher).toBe(V280[name]);
    // Other warnings (an edge property a member does not have) are not
    // this item's.
    const unionWarnings = unset.logger.warn.mock.calls.filter(([m]) =>
      String(m).includes('is read in 2.x through the relationship'),
    );
    expect(unionWarnings).toHaveLength(differing.has(name) ? 1 : 0);
  });
});
