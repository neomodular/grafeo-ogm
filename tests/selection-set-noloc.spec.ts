/**
 * vNEXT — a DocumentNode `selectionSet` without location info
 * (`parse(…, { noLocation: true })`, graphql-codegen `documentMode:
 * documentNode`, a JSON-serialized AST) used to become `"[object Object]"`
 * and throw a parse error. It is now printed. A DocumentNode WITH `loc`
 * still uses its source body, so its Cypher is unchanged.
 */
import { parse } from 'graphql';
import { OGM } from '../src/ogm';
import { recordingDriver } from './strict-mode.writes.cases';

const typeDefs = /* GraphQL */ `
  interface Named {
    name: String
  }
  type Pet implements Named @node {
    id: ID!
    name: String
  }
  type User implements Named @node {
    id: ID!
    name: String
    age: Int
    pets: [Pet!]! @relationship(type: "HAS_PET", direction: OUT)
  }
`;

const SEL = '{ name age pets(where: { name: "Rex" }) { name } }';

async function compile(
  run: (ogm: OGM) => Promise<unknown>,
  strict?: boolean,
): Promise<string[]> {
  const records: { cypher: string; params: Record<string, unknown> }[] = [];
  const ogm = new OGM({ typeDefs, driver: recordingDriver(records), strict });
  await run(ogm);
  return records.map((r) => r.cypher);
}

describe('selectionSet DocumentNode without loc', () => {
  for (const strict of [undefined, true]) {
    describe(`strict: ${strict}`, () => {
      it('Model.find: noLocation / JSON AST compile like the loc-carrying document', async () => {
        const withLoc = await compile(
          (ogm) => ogm.model('User').find({ selectionSet: parse(SEL) }),
          strict,
        );
        const noLoc = await compile(
          (ogm) =>
            ogm
              .model('User')
              .find({ selectionSet: parse(SEL, { noLocation: true }) }),
          strict,
        );
        const json = await compile(
          (ogm) =>
            ogm.model('User').find({
              selectionSet: JSON.parse(
                JSON.stringify(parse(SEL, { noLocation: true })),
              ),
            }),
          strict,
        );
        expect(noLoc).toEqual(withLoc);
        expect(json).toEqual(withLoc);
        expect(withLoc[0]).toContain('`HAS_PET`');
      });

      it('Model selectionSet setter accepts a document without loc', async () => {
        const out = await compile(async (ogm) => {
          const m = ogm.model('User');
          m.selectionSet = parse('{ name age }', { noLocation: true });
          return m.find();
        }, strict);
        expect(out[0]).toContain('.`age`');
      });

      it('InterfaceModel.find accepts a document without loc', async () => {
        const withLoc = await compile(
          (ogm) =>
            ogm
              .interfaceModel('Named')
              .find({ selectionSet: parse('{ name }') }),
          strict,
        );
        const noLoc = await compile(
          (ogm) =>
            ogm
              .interfaceModel('Named')
              .find({ selectionSet: parse('{ name }', { noLocation: true }) }),
          strict,
        );
        expect(noLoc).toEqual(withLoc);
      });
    });
  }

  it('a non-document object still fails with the parse error', async () => {
    await expect(
      compile((ogm) => ogm.model('User').find({ selectionSet: {} as never })),
    ).rejects.toThrow(/Failed to parse selectionSet/);
  });
});
