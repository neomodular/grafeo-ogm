/**
 * v2.6.3 — selected field names are checked against the schema (#23).
 * Shapes shared by the unit spec: unknown fields (default mode warns and
 * keeps the v2.6.2 Cypher; strict throws) and known fields of every kind
 * (never warn, never throw).
 */
import type { OGM } from '../src/ogm';

export const selectionFieldTypeDefs = /* GraphQL */ `
  type Owns @relationshipProperties {
    since: String
  }
  type User @node {
    id: ID! @id
    name: String
    plans: [Plan!]!
      @relationship(type: "OWNS", direction: OUT, properties: "Owns")
  }
  interface Named {
    name: String
  }
  type Plan implements Named @node {
    id: ID! @id
    name: String
    internetConnection: String
    score: Int @cypher(statement: "RETURN 1 AS s", columnName: "s")
    owners: [User!]!
      @relationship(type: "OWNS", direction: IN, properties: "Owns")
    tags: [Tag!]! @relationship(type: "TAGGED", direction: OUT)
  }
  type Tag implements Named @node {
    id: ID! @id
    name: String
    color: String
  }
  union Thing = Plan | Tag
  type Box @node {
    id: ID! @id
    items: [Thing!]! @relationship(type: "HOLDS", direction: OUT)
    named: [Named!]! @relationship(type: "NAMES", direction: OUT)
  }
`;

export interface UnknownCase {
  label: string;
  run: (ogm: OGM) => Promise<unknown>;
  /** Text the warning and the strict error both contain. */
  names: string;
  /** Extra text both contain (the `<rel>Aggregate` hint). */
  hint?: string;
  /** v2.6.2 Cypher of the statement, hard-coded from main (7733fde). */
  expected: string;
}

const AGGREGATE_HINT =
  '"ownersAggregate" fields are not supported: select "ownersConnection { totalCount }" for a count, or use Model.aggregate() on the related type.';

export const UNKNOWN_CASES: UnknownCase[] = [
  {
    label: 'root scalar typo',
    run: (ogm) => ogm.model('Plan').find({ selectionSet: '{ id nmae }' }),
    names: 'Unknown field "nmae" in selectionSet on type "Plan".',
    expected: 'MATCH (n:`Plan`)\nRETURN n { .`id`, .`nmae` }',
  },
  {
    label: 'root <rel>Aggregate',
    run: (ogm) =>
      ogm
        .model('Plan')
        .find({ selectionSet: '{ id ownersAggregate { count } }' }),
    names: 'Unknown field "ownersAggregate" in selectionSet on type "Plan".',
    hint: AGGREGATE_HINT,
    expected: 'MATCH (n:`Plan`)\nRETURN n { .`id` }',
  },
  {
    label: 'unknown field with a sub-selection',
    run: (ogm) =>
      ogm.model('Plan').find({ selectionSet: '{ id ownerz { id } }' }),
    names: 'Unknown field "ownerz" in selectionSet on type "Plan".',
    expected: 'MATCH (n:`Plan`)\nRETURN n { .`id` }',
  },
  {
    label: 'nested relationship selection',
    run: (ogm) =>
      ogm.model('Plan').find({ selectionSet: '{ id owners { id nmae } }' }),
    names: 'Unknown field "nmae" in selectionSet on type "User".',
    expected:
      'MATCH (n:`Plan`)\nRETURN n { .`id`, owners: [(n)<-[:`OWNS`]-(n0:`User`) | n0 { .`id`, .`nmae` }] }',
  },
  {
    label: 'connection node selection',
    run: (ogm) =>
      ogm.model('Plan').find({
        selectionSet: '{ ownersConnection { edges { node { id nmae } } } }',
      }),
    names: 'Unknown field "nmae" in selectionSet on type "User".',
    expected:
      'MATCH (n:`Plan`)\nRETURN n { ownersConnection: { edges: [(n)<-[e0:`OWNS`]-(n0:`User`) | { node: n0 { .`id`, .`nmae` } }] } }',
  },
  {
    label: 'connection edge properties',
    run: (ogm) =>
      ogm.model('Plan').find({
        selectionSet:
          '{ ownersConnection { edges { properties { since sinse } } } }',
      }),
    names:
      'Unknown field "sinse" in selectionSet on relationship properties type "Owns".',
    expected:
      'MATCH (n:`Plan`)\nRETURN n { ownersConnection: { edges: [(n)<-[e0:`OWNS`]-(n0:`User`) | { properties: e0 { .`since`, .`sinse` } }] } }',
  },
  {
    label: 'edge properties of a relationship without @relationshipProperties',
    run: (ogm) =>
      ogm.model('Plan').find({
        selectionSet: '{ tagsConnection { edges { properties { since } } } }',
      }),
    names:
      'Unknown field "since" in selectionSet on the "tags" relationship of type "Plan" (no @relationshipProperties).',
    expected:
      'MATCH (n:`Plan`)\nRETURN n { tagsConnection: { edges: [(n)-[e0:`TAGGED`]->(n0:`Tag`) | { properties: e0 { .`since` } }] } }',
  },
  {
    label: 'union member fragment',
    run: (ogm) =>
      ogm
        .model('Box')
        .find({ selectionSet: '{ id items { ... on Tag { id colour } } }' }),
    names: 'Unknown field "colour" in selectionSet on type "Tag".',
    expected:
      "MATCH (n:`Box`)\nRETURN n { .`id`, items: [(n)-[:`HOLDS`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['Plan', 'Tag']]), .`id`, .`colour` }] }",
  },
  {
    label: 'union field no member declares',
    run: (ogm) =>
      ogm.model('Box').find({ selectionSet: '{ id items { id nmae } }' }),
    names: 'Unknown field "nmae" in selectionSet on type "Thing".',
    expected:
      "MATCH (n:`Box`)\nRETURN n { .`id`, items: [(n)-[:`HOLDS`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['Plan', 'Tag']]), .`id`, .`nmae` }] }",
  },
  {
    label: 'interface-level field not on the interface',
    run: (ogm) =>
      ogm.model('Box').find({ selectionSet: '{ id named { name color } }' }),
    names: 'Unknown field "color" in selectionSet on type "Named".',
    expected:
      "MATCH (n:`Box`)\nRETURN n { .`id`, named: [(n)-[:`NAMES`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['Plan', 'Tag']]), .`name`, .`color` }] }",
  },
  {
    label: 'interface fragment on an implementer',
    run: (ogm) =>
      ogm.model('Box').find({
        selectionSet: '{ id named { name ... on Plan { id colour } } }',
      }),
    names: 'Unknown field "colour" in selectionSet on type "Plan".',
    expected:
      "MATCH (n:`Box`)\nRETURN n { .`id`, named: [(n)-[:`NAMES`]->(n0) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['Plan', 'Tag']]), .`name`, .`id`, .`colour` }] }",
  },
  {
    label: 'InterfaceModel root field',
    run: (ogm) =>
      ogm.interfaceModel('Named').find({ selectionSet: '{ name nmae }' }),
    names: 'Unknown field "nmae" in selectionSet on type "Named".',
    expected:
      "MATCH (n:(`Plan`|`Tag`))\nWITH n, CASE WHEN n:`Plan` THEN 'Plan' WHEN n:`Tag` THEN 'Tag' END AS __typename\nRETURN n { __typename: head([__label IN labels(n) WHERE __label IN ['Plan', 'Tag']]), .`name`, .`nmae` , __typename: __typename }",
  },
  {
    label: 'InterfaceModel fragment',
    run: (ogm) =>
      ogm
        .interfaceModel('Named')
        .find({ selectionSet: '{ name ... on Tag { colour } }' }),
    names: 'Unknown field "colour" in selectionSet on type "Tag".',
    expected:
      "MATCH (n:(`Plan`|`Tag`))\nWITH n, CASE WHEN n:`Plan` THEN 'Plan' WHEN n:`Tag` THEN 'Tag' END AS __typename\nRETURN n { __typename: head([__label IN labels(n) WHERE __label IN ['Plan', 'Tag']]), .`name`, .`colour` , __typename: __typename }",
  },
  {
    label: 'findFirst',
    run: (ogm) => ogm.model('Plan').findFirst({ selectionSet: '{ id nmae }' }),
    names: 'Unknown field "nmae" in selectionSet on type "Plan".',
    expected:
      'MATCH (n:`Plan`)\nWITH *\nLIMIT $options_limit\nRETURN n { .`id`, .`nmae` }',
  },
  {
    label: 'create response selectionSet',
    run: (ogm) =>
      ogm.model('Plan').create({
        input: [{ name: 'p' }],
        selectionSet: '{ plans { id nmae } }',
      }),
    names: 'Unknown field "nmae" in selectionSet on type "Plan".',
    expected:
      'CREATE (n:`Plan` { `id`: randomUUID(), `name`: $create0_name })\nRETURN n { .`id`, .`nmae` }',
  },
  {
    label: 'update response selectionSet with info',
    run: (ogm) =>
      ogm.model('Plan').update({
        where: { id: 'x' },
        update: { name: 'q' },
        selectionSet:
          '{ info { nodesCreated } plans { id ownersAggregate { count } } }',
      }),
    names: 'Unknown field "ownersAggregate" in selectionSet on type "Plan".',
    hint: AGGREGATE_HINT,
    expected:
      'MATCH (n:`Plan`)\nWHERE n.`id` = $param0\nSET n.`name` = $update_name\nRETURN n { .`id` }',
  },
  {
    label: 'upsert selectionSet',
    run: (ogm) =>
      ogm.model('Plan').upsert({
        where: { id: 'x' },
        create: { name: 'p' },
        update: { name: 'q' },
        selectionSet: '{ id nmae }',
      }),
    names: 'Unknown field "nmae" in selectionSet on type "Plan".',
    expected:
      'MERGE (n:`Plan` { `id`: $merge_id })\nON CREATE SET n.`name` = $onCreate_name\nON MATCH SET n.`name` = $onMatch_name\nRETURN n { .`id`, .`nmae` }',
  },
  {
    label: 'typed select: unknown key: true',
    run: (ogm) => ogm.model('Plan').find({ select: { id: true, nmae: true } }),
    names: 'Unknown field "nmae" in select on type "Plan".',
    expected: 'MATCH (n:`Plan`)\nRETURN n { .`id`, .`nmae` }',
  },
  {
    label: 'typed select: <rel>Aggregate',
    run: (ogm) =>
      ogm
        .model('Plan')
        .find({ select: { id: true, ownersAggregate: { count: true } } }),
    names: 'Unknown field "ownersAggregate" in select on type "Plan".',
    hint: AGGREGATE_HINT,
    expected: 'MATCH (n:`Plan`)\nRETURN n { .`id` }',
  },
  {
    label: 'typed select: nested relationship',
    run: (ogm) =>
      ogm.model('Plan').find({
        select: { id: true, owners: { select: { id: true, nmae: true } } },
      }),
    names: 'Unknown field "nmae" in select on type "User".',
    expected:
      'MATCH (n:`Plan`)\nRETURN n { .`id`, owners: [(n)<-[:`OWNS`]-(n0:`User`) | n0 { .`id`, .`nmae` }] }',
  },
  {
    label: 'typed select: edge properties',
    run: (ogm) =>
      ogm.model('Plan').find({
        select: {
          ownersConnection: {
            select: {
              edges: { properties: { select: { since: true, sinse: true } } },
            },
          },
        },
      }),
    names:
      'Unknown field "sinse" in select on relationship properties type "Owns".',
    expected:
      'MATCH (n:`Plan`)\nRETURN n { ownersConnection: { edges: [(n)<-[e0:`OWNS`]-(n0:`User`) | { properties: e0 { .`since`, .`sinse` } }] } }',
  },
];

export interface KnownCase {
  label: string;
  run: (ogm: OGM) => Promise<unknown>;
}

export const KNOWN_CASES: KnownCase[] = [
  {
    label:
      'properties, @cypher, relationships, connections, __typename, aliases',
    run: (ogm) =>
      ogm.model('Plan').find({
        selectionSet: `{
          __typename id name internetConnection score
          alias: name
          owners { id name plans { id } }
          tags(options: { limit: 2 }) { id color }
          ownersConnection(where: { node: { name: "a" } }) {
            totalCount
            edges { node { id __typename } properties { since __typename } }
          }
          tagsConnection { totalCount }
        }`,
      }),
  },
  {
    label: 'connection aliases and repeated edges',
    run: (ogm) =>
      ogm.model('Plan').find({
        selectionSet: `{
          c: ownersConnection {
            n: totalCount
            a: edges { x: node { id } p: properties { since } }
          }
        }`,
      }),
  },
  {
    label: 'union fields and member fragments',
    run: (ogm) =>
      ogm.model('Box').find({
        selectionSet: `{
          id
          items {
            __typename id name
            ... on Plan { score owners { id } ownersConnection { totalCount } }
            ... on Tag { color }
          }
        }`,
      }),
  },
  {
    label: 'interface fields and implementer fragments',
    run: (ogm) =>
      ogm.model('Box').find({
        selectionSet: `{
          named {
            __typename name
            ... on Named { name }
            ... on Plan { id score tags { id } }
            ... on Tag { id color }
          }
        }`,
      }),
  },
  {
    label: 'same key from fragments on different types',
    run: (ogm) =>
      ogm.model('Box').find({
        selectionSet:
          '{ items { ... on Plan { x: name } ... on Tag { x: color } } }',
      }),
  },
  {
    label: 'root fragment on the type itself and on its interface',
    run: (ogm) =>
      ogm.model('Plan').find({
        selectionSet: '{ ... on Plan { id score } ... on Named { name } }',
      }),
  },
  {
    label: 'InterfaceModel with fragments',
    run: (ogm) =>
      ogm.interfaceModel('Named').find({
        selectionSet:
          '{ __typename name ... on Plan { id score owners { id } } ... on Tag { color } }',
      }),
  },
  {
    label: 'create response: plural key',
    run: (ogm) =>
      ogm.model('Plan').create({
        input: [{ name: 'p' }],
        selectionSet: '{ plans { id name } }',
      }),
  },
  {
    label: 'create response: info and plural key',
    run: (ogm) =>
      ogm.model('Plan').create({
        input: [{ name: 'p' }],
        selectionSet: '{ info { nodesCreated } plans { id } }',
      }),
  },
  {
    label: 'create response: info only',
    run: (ogm) =>
      ogm.model('Plan').create({
        input: [{ name: 'p' }],
        selectionSet: '{ info { nodesCreated relationshipsCreated } }',
      }),
  },
  {
    label: 'update response: bare node fields',
    run: (ogm) =>
      ogm.model('Plan').update({
        where: { id: 'x' },
        update: { name: 'q' },
        selectionSet: '{ id name owners { id } }',
      }),
  },
  {
    label: 'typed select: every kind',
    run: (ogm) =>
      ogm.model('Plan').find({
        select: {
          __typename: true,
          id: true,
          score: true,
          internetConnection: true,
          tags: true,
          owners: { select: { id: true, plans: { select: { name: true } } } },
          ownersConnection: {
            select: {
              totalCount: true,
              edges: {
                node: { select: { id: true } },
                properties: { select: { since: true } },
              },
            },
          },
        },
      }),
  },
];
