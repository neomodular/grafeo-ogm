/**
 * v2.20.0 — selectionSet shapes 2.x silently drops, truncates or projects
 * wrongly (strict items 35–36). `readShapes` compile each one with a
 * recording driver; default-mode Cypher must stay byte-identical to
 * v2.15.0 (golden: `fixtures/strict-mode.read-selections.default.golden.json`,
 * captured from 6572bdc with these shapes).
 */
import { OGM } from '../src/ogm';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';

export const readTypeDefs = /* GraphQL */ `
  type RsUser @node {
    id: ID! @unique
    name: String
    loc: Point
    cloc: CartesianPoint
    locs: [Point!]
    friends: [RsUser!]! @relationship(type: "RS_FRIEND", direction: OUT)
    pets: [RsPet!]! @relationship(type: "RS_HAS_PET", direction: OUT)
    items: [RsItem!]! @relationship(type: "RS_HAS_ITEM", direction: OUT)
    bestPet: RsPet
      @cypher(
        statement: "MATCH (this)-[:RS_HAS_PET]->(p) RETURN p LIMIT 1"
        columnName: "p"
      )
    petList: [RsPet!]
      @cypher(
        statement: "MATCH (this)-[:RS_HAS_PET]->(p) RETURN p"
        columnName: "p"
      )
  }
  type RsPet @node {
    id: ID! @unique
    name: String
  }
  union RsItem = RsPost | RsDoc | RsNote
  type RsPost @node {
    id: ID! @unique
    title: String
    label: String
      @cypher(statement: "RETURN 'p:' + this.title AS v", columnName: "v")
  }
  type RsDoc @node {
    id: ID! @unique
    body: String
    label: String
      @cypher(statement: "RETURN 'd:' + this.body AS v", columnName: "v")
  }
  type RsNote @node {
    id: ID! @unique
    label: String
      @cypher(statement: "RETURN 'p:' + this.title AS v", columnName: "v")
  }
`;

export type ReadRun = (ogm: OGM) => Promise<unknown>;

const nested = (levels: number) => {
  let sel = '{ name }';
  for (let i = 0; i < levels; i++) sel = `{ name friends ${sel} }`;
  return sel;
};

export const readShapes: Record<string, ReadRun> = {
  'depth: 5 levels (within maxDepth)': (ogm) =>
    ogm.model('RsUser').find({ selectionSet: nested(5) }),
  'depth: 6 levels (beyond maxDepth)': (ogm) =>
    ogm.model('RsUser').find({ selectionSet: nested(6) }),
  'depth: 6 levels via connection': (ogm) =>
    ogm.model('RsUser').find({
      selectionSet: `{ name friends { friends { friends { friends { friends { friendsConnection { totalCount edges { node { name } } } } } } } } }`,
    }),
  'point: unknown sub-field': (ogm) =>
    ogm.model('RsUser').find({ selectionSet: '{ name loc { longitude x } }' }),
  'fragment: spread + definition': (ogm) =>
    ogm.model('RsUser').find({
      selectionSet:
        '{ name ...U pets { ...P } } fragment U on RsUser { id } fragment P on RsPet { name }',
    }),
  'fragment: spread without a definition': (ogm) =>
    ogm.model('RsUser').find({ selectionSet: '{ name ...U }' }),
  'fragment: query keyword document': (ogm) =>
    ogm.model('RsUser').find({
      selectionSet: 'query { ...U } fragment U on RsUser { name }',
    }),
  'fragment: spread in connection edges': (ogm) =>
    ogm.model('RsUser').find({
      selectionSet:
        '{ petsConnection { edges { ...E node { name } } } } fragment E on RsUserPetsRelationship { cursor }',
    }),
  'cypher node field: root sub-selection': (ogm) =>
    ogm.model('RsUser').find({
      selectionSet: '{ name bestPet { name } petList { id } }',
    }),
  'cypher node field: nested sub-selection': (ogm) =>
    ogm.model('RsUser').find({
      selectionSet: '{ friends { bestPet { name } } }',
    }),
  'union cypher: member fragments, statements differ': (ogm) =>
    ogm.model('RsUser').find({
      selectionSet:
        '{ items { ... on RsPost { label } ... on RsDoc { label } } }',
    }),
  'union cypher: connection member fragments': (ogm) =>
    ogm.model('RsUser').find({
      selectionSet:
        '{ itemsConnection { edges { node { ... on RsPost { label } ... on RsDoc { label } } } } }',
    }),
  'union cypher: member fragments, same statement': (ogm) =>
    ogm.model('RsUser').find({
      selectionSet:
        '{ items { ... on RsPost { label } ... on RsNote { label } } }',
    }),
};

/** Compile `run` and return its statements. */
export async function compileReadShape(
  run: ReadRun,
  strict: boolean | undefined,
  warns: string[] = [],
): Promise<string[]> {
  const records: Recorded[] = [];
  const ogm = new OGM({
    typeDefs: readTypeDefs,
    driver: recordingDriver(records),
    ...(strict === undefined ? {} : { strict }),
    logger: { warn: (m: string) => warns.push(m), debug: () => undefined },
  });
  await run(ogm);
  return records.map((r) => r.cypher);
}
