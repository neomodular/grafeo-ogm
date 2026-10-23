/**
 * v2.14.0 — strict item 24: list-typed `@cypher` fields. The schema and
 * the read shapes that project or filter one, shared by the default-mode
 * byte-identical guard, the strict unit spec and the live suite
 * (`tests/integration/cypher-list-field.spec.ts`). Labels are
 * `ItLf`-prefixed so the live suite can share a development database.
 *
 * - `tags`     — one row per element (`[String]`), ordered in the statement.
 * - `tagList`  — ONE row holding the whole list (aggregating, so top-level only).
 * - `firstTag` — a scalar `@cypher` field: unchanged in both modes.
 * - `words`    — one row per word of the title / body (duplicates kept),
 *                declared on both interface / union members.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import type { OGMLogger } from '../src/execution/executor';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';

export const listFieldTypeDefs = /* GraphQL */ `
  interface ItLfThing {
    id: ID!
    runId: String
  }
  union ItLfItem = ItLfPost | ItLfNote
  type ItLfWrote @relationshipProperties {
    note: String
  }
  type ItLfUser @node {
    id: ID! @unique
    runId: String
    name: String
    tags: [String]
      @cypher(
        statement: "MATCH (this)-[:ITLF_TAG]->(t:ItLfTag) RETURN t.name AS tags ORDER BY t.pos"
        columnName: "tags"
      )
    tagList: [String]
      @cypher(
        statement: "MATCH (this)-[:ITLF_TAG]->(t:ItLfTag) WITH t ORDER BY t.pos RETURN collect(t.name) AS list"
        columnName: "list"
      )
    firstTag: String
      @cypher(
        statement: "MATCH (this)-[:ITLF_TAG]->(t:ItLfTag) RETURN t.name AS firstTag ORDER BY t.pos"
        columnName: "firstTag"
      )
    posts: [ItLfPost!]!
      @relationship(type: "ITLF_WROTE", direction: OUT, properties: "ItLfWrote")
    things: [ItLfThing!]! @relationship(type: "ITLF_HAS", direction: OUT)
    items: [ItLfItem!]! @relationship(type: "ITLF_HAS", direction: OUT)
  }
  type ItLfPost implements ItLfThing @node {
    id: ID! @unique
    runId: String
    title: String
    words: [String]
      @cypher(
        statement: "UNWIND split(this.title, ' ') AS w RETURN w AS words"
        columnName: "words"
      )
  }
  type ItLfNote implements ItLfThing @node {
    id: ID! @unique
    runId: String
    body: String
    words: [String]
      @cypher(
        statement: "UNWIND split(this.body, ' ') AS w RETURN w AS words"
        columnName: "words"
      )
  }
`;

export type ListRun = (ogm: OGM, ids: ListIds) => Promise<unknown>;

/** Ids the shapes filter on (the live suite passes its run-scoped ones). */
export interface ListIds {
  runId: string;
  user: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const user = (ogm: OGM): any => ogm.model('ItLfUser');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const thing = (ogm: OGM): any => ogm.interfaceModel('ItLfThing');

/** Every read path that projects or filters a list `@cypher` field. */
export const listFieldShapes: Record<string, ListRun> = {
  'root typed select': (ogm, { user: id }) =>
    user(ogm).find({
      where: { id },
      select: { id: true, tags: true, tagList: true, firstTag: true },
    }),
  'root selectionSet (aliased)': (ogm, { user: id }) =>
    user(ogm).find({
      where: { id },
      selectionSet: '{ id tags labels: tags tagList firstTag }',
    }),
  'findUnique selectionSet': (ogm, { user: id }) =>
    user(ogm).findUnique({ where: { id }, selectionSet: '{ id tags }' }),
  'nested relationship typed select': (ogm, { user: id }) =>
    user(ogm).find({
      where: { id },
      select: { id: true, posts: { select: { id: true, words: true } } },
    }),
  'nested relationship selectionSet': (ogm, { user: id }) =>
    user(ogm).find({
      where: { id },
      selectionSet: '{ id posts { id words } }',
    }),
  'connection edges node': (ogm, { user: id }) =>
    user(ogm).find({
      where: { id },
      selectionSet:
        '{ id postsConnection { totalCount edges { properties { note } node { id words } } } }',
    }),
  'typed select connection': (ogm, { user: id }) =>
    user(ogm).find({
      where: { id },
      select: {
        id: true,
        postsConnection: {
          select: { edges: { node: { select: { id: true, words: true } } } },
        },
      },
    }),
  'InterfaceModel fragments': (ogm, { runId }) =>
    thing(ogm).find({
      where: { runId },
      selectionSet:
        '{ id ... on ItLfPost { words } ... on ItLfNote { words } }',
    }),
  'nested interface fragments': (ogm, { user: id }) =>
    user(ogm).find({
      where: { id },
      selectionSet: '{ id things { id ... on ItLfPost { words } } }',
    }),
  'nested union fragments': (ogm, { user: id }) =>
    user(ogm).find({
      where: { id },
      selectionSet:
        '{ id items { ... on ItLfPost { id words } ... on ItLfNote { id words } } }',
    }),
  'where list equality': (ogm, { runId }) =>
    user(ogm).find({
      where: { runId, tags: ['x', 'y', 'x'] },
      selectionSet: '{ id }',
    }),
  'where list _IN': (ogm, { runId }) =>
    user(ogm).find({
      where: { runId, tags_IN: [['x', 'y', 'x'], ['q']] },
      selectionSet: '{ id }',
    }),
  'where through a relationship': (ogm, { runId }) =>
    user(ogm).find({
      where: { runId, posts_SOME: { words: ['a', 'b', 'a'] } },
      selectionSet: '{ id }',
    }),
  'count with list where': (ogm, { runId }) =>
    user(ogm).count({ where: { runId, tags_NOT: ['nope'] } }),
  'sort by a scalar @cypher field, list selected': (ogm, { runId }) =>
    user(ogm).find({
      where: { runId },
      selectionSet: '{ id tags firstTag }',
      options: { sort: [{ firstTag: 'ASC' }] },
    }),
  'update response': (ogm, { user: id }) =>
    user(ogm).update({
      where: { id },
      update: { name: 'renamed' },
      selectionSet: '{ itLfUsers { id tags } }',
    }),
};

export function buildListOgm(
  driver: Driver,
  strict: boolean | undefined,
  logger?: OGMLogger,
): OGM {
  return new OGM({
    typeDefs: listFieldTypeDefs,
    driver,
    ...(strict === undefined ? {} : { strict }),
    ...(logger ? { logger } : {}),
  });
}

export const UNIT_IDS: ListIds = { runId: 'r', user: 'u1' };

/** The Cypher statements one shape compiles to (recording driver). */
export async function compileListShape(
  run: ListRun,
  strict: boolean | undefined,
  logger?: OGMLogger,
): Promise<string[]> {
  const records: Recorded[] = [];
  try {
    await run(buildListOgm(recordingDriver(records), strict, logger), UNIT_IDS);
  } catch {
    // count / findUnique / update read records the recording driver lacks.
  }
  return records.map((r) => r.cypher);
}
