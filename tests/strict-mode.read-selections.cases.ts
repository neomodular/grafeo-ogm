/**
 * vNEXT — selectionSet shapes 2.x silently drops, truncates or projects
 * wrongly (strict items 31–36). `readShapes` compile each one with a
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
    friends: [RsUser!]! @relationship(type: "RS_FRIEND", direction: OUT)
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
