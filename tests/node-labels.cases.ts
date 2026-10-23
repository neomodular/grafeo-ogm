/**
 * v2.11.0 — strict item 23 (`@node(labels: [...])` as in @neo4j/graphql):
 * a schema whose types use custom labels, and one call per label site
 * (root reads and writes, relationship targets, connect / disconnect,
 * nested create, upsert, createMany, setLabels, runtime `labels`, cascade
 * delete, interface / union members and `__typename`, policies, fulltext,
 * vector, index statements). Shared by the default-mode byte-identical
 * guard and the strict unit spec.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { permissive } from '../src/policy/types';
import {
  buildNodeFulltextStatements,
  buildUniqueConstraintStatements,
  buildVectorIndexStatements,
} from '../src/schema/index-statements';
import { recordingDriver, Recorded } from './strict-mode.writes.cases';

export const labelTypeDefs = /* GraphQL */ `
  interface Animal {
    id: ID!
    name: String
  }
  union Thing = Dog | Toy

  type Person
    @node(labels: ["Human"])
    @fulltext(indexes: [{ name: "PersonName", fields: ["name"] }])
    @vector(
      indexes: [
        {
          indexName: "PersonEmb"
          queryName: "similarPeople"
          embeddingProperty: "embedding"
        }
      ]
    ) {
    id: ID! @id @unique
    email: String @unique
    name: String
    embedding: [Float!]
    nameLower: String
      @cypher(statement: "RETURN toLower(this.name) AS v", columnName: "v")
    pets: [Animal!]! @relationship(type: "OWNS", direction: OUT)
    favorite: Dog @relationship(type: "FAV", direction: OUT)
    things: [Thing!]! @relationship(type: "HAS", direction: OUT)
    friends: [Person!]! @relationship(type: "KNOWS", direction: OUT)
  }
  type Dog implements Animal @node(labels: ["K9", "Pet"]) {
    id: ID! @id @unique
    name: String
    tenantId: String
    bark: String @cypher(statement: "RETURN 'woof' AS v", columnName: "v")
    owner: Person @relationship(type: "OWNS", direction: IN)
    toys: [Toy!]! @relationship(type: "PLAYS", direction: OUT)
  }
  type Cat implements Animal @node(labels: ["Cat", "Pet"]) {
    id: ID! @id @unique
    name: String
    owner: Person @relationship(type: "OWNS", direction: IN)
  }
  type Toy @node {
    id: ID! @id @unique
    name: String
  }
`;

export const labelPolicies = {
  Dog: [
    permissive({
      operations: ['read', 'update', 'delete', 'create'],
      when: () => ({ tenantId: 't1' }),
    }),
  ],
  Person: [permissive({ operations: ['*'], when: () => ({}) })],
  Cat: [permissive({ operations: ['*'], when: () => ({}) })],
  Toy: [permissive({ operations: ['*'], when: () => ({}) })],
};

type Run = (ogm: OGM) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = (ogm: OGM, name: string): any => ogm.model(name);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (ogm: OGM): any => ogm.withContext({});

export const labelShapes: Record<string, Run> = {
  'find (default selection)': (ogm) =>
    m(ogm, 'Person').find({ where: { id: 'p1' } }),
  'find with runtime labels': (ogm) =>
    m(ogm, 'Person').find({ where: { id: 'p1' }, labels: ['Vip'] }),
  'find: concrete, interface, union and connection selections': (ogm) =>
    m(ogm, 'Person').find({
      where: { id: 'p1' },
      selectionSet: `{ id nameLower favorite { id bark } friends { id }
        pets { __typename id name ... on Dog { bark } }
        things { __typename ... on Dog { id } ... on Toy { name } }
        friendsConnection { totalCount edges { node { id } } }
        petsConnection { totalCount edges { node { id } } }
        friendsAggregate { count } }`,
    }),
  'find: typed select': (ogm) =>
    m(ogm, 'Dog').find({
      select: { id: true, owner: { select: { id: true } }, toys: true },
    }),
  'where: quantifiers, abstract and union filters': (ogm) =>
    m(ogm, 'Person').find({
      where: {
        favorite: { id: 'd1' },
        friends_SOME: { id: 'p2' },
        pets_NONE: { name: 'x' },
        things_SOME: { Dog: { id: 'd1' } },
        friendsConnection_ALL: { node: { name: 'a' } },
      },
      selectionSet: '{ id }',
    }),
  findFirst: (ogm) => m(ogm, 'Dog').findFirst({ where: { name: 'a' } }),
  count: (ogm) => m(ogm, 'Dog').count({ where: { name: 'a' } }),
  aggregate: (ogm) =>
    m(ogm, 'Dog').aggregate({
      where: { name: 'a' },
      aggregate: { count: true },
    }),
  'fulltext find': (ogm) =>
    m(ogm, 'Person').find({
      fulltext: { PersonName: { phrase: 'ann' } },
      selectionSet: '{ id }',
    }),
  'fulltext NOT': (ogm) =>
    m(ogm, 'Person').find({
      fulltext: { NOT: { PersonName: { phrase: 'ann' } } },
      selectionSet: '{ id }',
    }),
  searchByVector: (ogm) =>
    m(ogm, 'Person').searchByVector({
      indexName: 'PersonEmb',
      vector: [0.1, 0.2],
      k: 3,
      selectionSet: '{ id }',
    }),
  create: (ogm) =>
    m(ogm, 'Dog').create({
      input: [
        {
          name: 'Rex',
          owner: { connect: { where: { node: { id: 'p1' } } } },
          toys: { create: [{ node: { name: 'ball' } }] },
        },
      ],
      selectionSet: '{ id }',
    }),
  'create with labels': (ogm) =>
    m(ogm, 'Person').create({
      input: [
        { name: 'Ann', pets: { create: [{ node: { Cat: { name: 'Tom' } } }] } },
      ],
      labels: ['Vip'],
      selectionSet: '{ id }',
    }),
  createMany: (ogm) =>
    m(ogm, 'Dog').createMany({ data: [{ name: 'a' }, { name: 'b' }] }),
  'createMany skipDuplicates': (ogm) =>
    m(ogm, 'Dog').createMany({
      data: [{ id: 'd1', name: 'a' }],
      skipDuplicates: true,
    }),
  'update: set, connect, disconnect, nested update / delete': (ogm) =>
    m(ogm, 'Person').update({
      where: { id: 'p1' },
      update: {
        name: 'B',
        friends: [{ update: { node: { name: 'c' } } }],
        favorite: { disconnect: { where: { node: { id: 'd0' } } } },
      },
      connect: {
        favorite: { where: { node: { id: 'd1' } } },
        pets: [{ where: { node: { id: 'c1' } } }],
      },
      disconnect: { friends: [{ where: { node: { id: 'p3' } } }] },
      selectionSet: '{ id }',
    }),
  updateMany: (ogm) =>
    m(ogm, 'Dog').updateMany({ where: { name: 'a' }, data: { name: 'b' } }),
  'delete with cascade': (ogm) =>
    m(ogm, 'Person').delete({
      where: { id: 'p1' },
      delete: { favorite: { where: { node: { id: 'd1' } } } },
    }),
  deleteMany: (ogm) => m(ogm, 'Dog').deleteMany({ where: { name: 'a' } }),
  upsert: (ogm) =>
    m(ogm, 'Dog').upsert({
      where: { id: 'd1' },
      create: { name: 'a' },
      update: { name: 'b' },
      selectionSet: '{ id }',
    }),
  setLabels: (ogm) =>
    m(ogm, 'Dog').setLabels({
      where: { id: 'd1' },
      addLabels: ['Good'],
      removeLabels: ['Bad'],
    }),
  'interface find': (ogm) =>
    ogm.interfaceModel('Animal').find({
      where: { name: 'a' },
      selectionSet: '{ __typename id ... on Dog { bark } }',
    }),
  'interface count with labels': (ogm) =>
    ogm.interfaceModel('Animal').count({ labels: ['Vip'] }),
  'policies: find, update and delete': async (ogm) => {
    await m(ctx(ogm), 'Person').find({
      where: { pets_SOME: { name: 'x' } },
      selectionSet: '{ id favorite { id } pets { id } }',
    });
    await m(ctx(ogm), 'Dog').update({
      where: { id: 'd1' },
      update: { name: 'b' },
      selectionSet: '{ id }',
    });
    await m(ctx(ogm), 'Person').update({
      where: { id: 'p1' },
      connect: { favorite: { where: { node: { id: 'd1' } } } },
      selectionSet: '{ id }',
    });
    await m(ctx(ogm), 'Dog').delete({ where: { id: 'd1' } });
    await ctx(ogm).interfaceModel('Animal').find({ selectionSet: '{ id }' });
  },
};

export function buildLabelOgm(
  records: Recorded[],
  strict: boolean | undefined,
  warn: (...args: unknown[]) => void = () => {},
): OGM {
  return new OGM({
    typeDefs: labelTypeDefs,
    driver: recordingDriver(records) as Driver,
    logger: { debug: () => {}, warn },
    policies: labelPolicies,
    ...(strict === undefined ? {} : { strict }),
  });
}

/** Run one shape; a thrown error is recorded as `ERROR: <message>`. */
export async function runLabelShape(
  run: Run,
  strict: boolean | undefined,
): Promise<string[]> {
  const records: Recorded[] = [];
  const ogm = buildLabelOgm(records, strict);
  try {
    await run(ogm);
  } catch (error) {
    records.push({
      cypher: `ERROR: ${(error as Error).message}`,
      params: {},
    });
  }
  return records.map((r) => r.cypher);
}

/** The index / constraint statements for this schema (db push, assertIndexesAndConstraints). */
export function labelStatements(ogm: OGM): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = (ogm as any).schema;
  return [
    ...buildNodeFulltextStatements(schema),
    ...buildUniqueConstraintStatements(schema),
    ...buildVectorIndexStatements(schema, { PersonEmb: { dimensions: 2 } })
      .ready,
  ].map((s) => s.cypher);
}
