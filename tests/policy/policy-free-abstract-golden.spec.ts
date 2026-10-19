/**
 * v2.5.4 guard — a policy-FREE OGM must keep emitting exactly the Cypher
 * v2.5.3 (main) emitted for abstract (interface / union) reads and writes.
 * The 2.5.4 security fix changes only policy-bound Cypher (the member
 * conjunction and the fragment `@cypher` guard). The expected strings below
 * were captured from v2.5.3 and are hard-coded on purpose: do not
 * regenerate them from the current compiler.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { typeDefs } from '../fixtures/nls-enforcement.fixture';

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

const GOLDEN: Record<string, Recorded> = {
  'interface relationship selection + traversal filter': {
    cypher:
      "MATCH (n:`ItTag`)\nWHERE n.`id` = $param0 AND EXISTS { MATCH (n)-[:`IT_TAGS_RES`]->(r1) WHERE r1.`id` = $param2 }\nRETURN n { .`id`, resources: [(n)-[:`IT_TAGS_RES`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['ItChart', 'ItDrug']]), .`id`, .`tenantId` }] }",
    params: { param0: 't', param2: 'r' },
  },
  'union relationship selection + per-member filter': {
    cypher:
      "MATCH (n:`ItTag`)\nWHERE EXISTS { MATCH (n)-[:`IT_TAGS_ITEM`]->(r0:`ItDoc`) WHERE r0.`id` = $param1 }\nRETURN n { .`id`, items: [(n)-[:`IT_TAGS_ITEM`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['ItChart', 'ItDoc']]), .`id`, .`secret`, .`approvedAt` }] }",
    params: { param1: 'd' },
  },
  'interface fragment @cypher through a relationship': {
    cypher:
      "MATCH (n:`ItFragHolder`)\nRETURN n { .`id`, res: [(n)-[:`IT_HOLDS`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['ItFragA', 'ItFragB']]), .`id`, `shout`: CASE WHEN n0:`ItFragA` THEN head(COLLECT { WITH n0 AS this\n  RETURN this.title + '!' AS s\n}) END, `whisper`: CASE WHEN n0:`ItFragB` THEN head(COLLECT { WITH n0 AS this\n  RETURN 'b-' + this.id AS s\n}) END, .`secret` }] }",
    params: {},
  },
  'InterfaceModel.find with labels': {
    cypher:
      "MATCH (n:(`ItChart`|`ItDrug`)&`ItDrug`)\nWHERE n.`tenantId` = $param0\nWITH n, CASE WHEN n:`ItChart` THEN 'ItChart' WHEN n:`ItDrug` THEN 'ItDrug' END AS __typename\nRETURN n { __typename: head([__label IN labels(n) WHERE __label IN ['ItChart', 'ItDrug']]), .`id`, .`tenantId` , __typename: __typename }",
    params: { param0: 't1' },
  },
  'InterfaceModel.find with fragment @cypher': {
    cypher:
      "MATCH (n:(`ItFragA`|`ItFragB`))\nWITH n, CASE WHEN n:`ItFragA` THEN 'ItFragA' WHEN n:`ItFragB` THEN 'ItFragB' END AS __typename\nCALL {\n  WITH n\n  WITH n WHERE n:`ItFragA`\n  CALL {\n    WITH n\n    WITH n AS this\n    RETURN this.title + '!' AS s\n  }\n  RETURN head(collect(`s`)) AS __sel_n_ItFragA_shout\n}\nWITH n, __typename, __sel_n_ItFragA_shout\nCALL {\n  WITH n\n  WITH n WHERE n:`ItFragB`\n  CALL {\n    WITH n\n    WITH n AS this\n    RETURN 'b-' + this.id AS s\n  }\n  RETURN head(collect(`s`)) AS __sel_n_ItFragB_whisper\n}\nWITH n, __typename, __sel_n_ItFragA_shout, __sel_n_ItFragB_whisper\nRETURN n { __typename: head([__label IN labels(n) WHERE __label IN ['ItFragA', 'ItFragB']]), .`id`, `shout`: CASE WHEN n:`ItFragA` THEN __sel_n_ItFragA_shout END, `whisper`: CASE WHEN n:`ItFragB` THEN __sel_n_ItFragB_whisper END , __typename: __typename }",
    params: {},
  },
  'interface connect + union per-member disconnect': {
    cypher:
      "MATCH (n:`ItTag`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nOPTIONAL MATCH (n)-[r_items_ItDoc_0:`IT_TAGS_ITEM`]->(target_items_ItDoc_0:`ItDoc`)\nWHERE target_items_ItDoc_0.`id` = $param1\nDELETE r_items_ItDoc_0\nRETURN count(*) AS _r_items_ItDoc_0\n}\nWITH n\nCALL {\nWITH n\nMATCH (target_resources_0)\nWHERE (target_resources_0:`ItChart`:`ItResource` OR target_resources_0:`ItDrug`:`ItResource`) AND target_resources_0.`id` = $param2\nMERGE (n)-[:`IT_TAGS_RES`]->(target_resources_0)\nRETURN count(*) AS _ccn_resources_0\n}\nRETURN n { __typename: 'ItTag', .`id`, .`runId` }",
    params: { param0: 't', param1: 'd', param2: 'c' },
  },
};

function setup() {
  const recorded: Recorded[] = [];
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      recorded.push({ cypher, params });
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
  const driver = {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
  return { ogm: new OGM({ typeDefs, driver }), recorded };
}

const CASES: Record<string, (ogm: OGM) => Promise<unknown>> = {
  'interface relationship selection + traversal filter': (ogm) =>
    ogm.model('ItTag').find({
      where: { id: 't', resources_SOME: { id: 'r' } },
      selectionSet: '{ id resources { id tenantId } }',
    }),
  'union relationship selection + per-member filter': (ogm) =>
    ogm.model('ItTag').find({
      where: { items_SOME: { ItDoc: { id: 'd' } } },
      selectionSet:
        '{ id items { ... on ItChart { id secret } ... on ItDoc { id approvedAt } } }',
    }),
  'interface fragment @cypher through a relationship': (ogm) =>
    ogm.model('ItFragHolder').find({
      selectionSet:
        '{ id res { id ... on ItFragA { shout } ... on ItFragB { whisper secret } } }',
    }),
  'InterfaceModel.find with labels': (ogm) =>
    ogm.interfaceModel('ItResource').find({
      where: { tenantId: 't1' },
      labels: ['ItDrug'],
    }),
  'InterfaceModel.find with fragment @cypher': (ogm) =>
    ogm.interfaceModel('ItFrag').find({
      selectionSet:
        '{ id ... on ItFragA { shout } ... on ItFragB { whisper } }',
    }),
  'interface connect + union per-member disconnect': (ogm) =>
    ogm.model('ItTag').update({
      where: { id: 't' },
      connect: { resources: [{ where: { node: { id: 'c' } } }] },
      disconnect: { items: { ItDoc: [{ where: { node: { id: 'd' } } }] } },
    }),
};

describe('policy-free abstract Cypher is unchanged from v2.5.3', () => {
  it.each(Object.keys(CASES))('%s', async (name) => {
    const { ogm, recorded } = setup();
    await CASES[name](ogm);
    expect(recorded).toEqual([GOLDEN[name]]);
  });
});
