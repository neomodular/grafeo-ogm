/**
 * v2.21.0 — point sub-selection on relationship properties
 * (`edges { properties { at { longitude latitude } } }`) and in the typed
 * `select` (`at: { select: { longitude: true } }`, node and edge). v2.20.0
 * added the selectionSet form for node properties only; pre-v2.21.0 these
 * were left out of the result (and warned), strict mode threw. Both modes
 * now project them, as for node properties.
 */
import { OGM } from '../src/ogm';
import { OGMError } from '../src/errors';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';

const typeDefs = /* GraphQL */ `
  type Place @node {
    id: ID! @unique
    loc: Point
    visits: [Place!]!
      @relationship(type: "VISIT", direction: OUT, properties: "Visit")
  }
  type Visit @relationshipProperties {
    at: Point
    cat: CartesianPoint
    pts: [Point!]
    note: String
  }
`;

async function compile(
  strict: boolean,
  params: Record<string, unknown>,
): Promise<{ cypher: string; warns: string[] }> {
  const records: Recorded[] = [];
  const warns: string[] = [];
  const ogm = new OGM({
    typeDefs,
    driver: recordingDriver(records),
    strict,
    logger: { warn: (m: string) => warns.push(m) } as never,
  });
  await ogm.model('Place').find(params as never);
  return { cypher: records[0].cypher, warns };
}

const AT =
  '`at`: CASE WHEN e0.`at` IS NULL THEN null ELSE { `longitude`: e0.`at`.x, `latitude`: e0.`at`.y } END';

describe('point sub-selection on relationship properties (2.21.0)', () => {
  for (const strict of [false, true])
    describe(strict ? 'strict' : 'default', () => {
      it('selectionSet: Point, CartesianPoint, list and alias', async () => {
        const { cypher, warns } = await compile(strict, {
          selectionSet:
            '{ visitsConnection { edges { properties { note at { longitude latitude } cat { x z } pts { lat: latitude } where: at { srid } } } } }',
        });
        expect(cypher).toContain(
          `properties: e0 { .\`note\`, ${AT}, \`cat\`: CASE WHEN e0.\`cat\` IS NULL THEN null ELSE { \`x\`: e0.\`cat\`.x, \`z\`: CASE WHEN e0.\`cat\`.crs ENDS WITH '-3d' THEN e0.\`cat\`.z END } END, \`pts\`: [__pt IN e0.\`pts\` | { \`lat\`: __pt.y }], \`where\`: CASE WHEN e0.\`at\` IS NULL THEN null ELSE { \`srid\`: e0.\`at\`.srid } END }`,
        );
        expect(warns).toEqual([]);
      });

      it('typed select: edge and node point fields', async () => {
        const { cypher, warns } = await compile(strict, {
          select: {
            loc: { select: { longitude: true } },
            visitsConnection: {
              select: {
                edges: {
                  properties: {
                    select: {
                      note: true,
                      at: { select: { longitude: true, latitude: true } },
                    },
                  },
                },
              },
            },
          },
        });
        expect(cypher).toContain(
          '`loc`: CASE WHEN n.`loc` IS NULL THEN null ELSE { `longitude`: n.`loc`.x } END',
        );
        expect(cypher).toContain(`properties: e0 { .\`note\`, ${AT} }`);
        expect(warns).toEqual([]);
      });
    });

  it('strict: a further `properties` key of the edges', async () => {
    const { cypher } = await compile(true, {
      selectionSet:
        '{ visitsConnection { edges { properties { note } p2: properties { at { longitude latitude } } } } }',
    });
    expect(cypher).toContain(`\`p2\`: e0 { ${AT} }`);
  });

  it('strict: a further `edges` key', async () => {
    const { cypher } = await compile(true, {
      selectionSet:
        '{ visitsConnection { edges { properties { note } } e2: edges { properties { at { longitude latitude } } } } }',
    });
    expect(cypher).toContain(`properties: e0 { ${AT} }`);
  });

  it('a sub-field the point type does not declare: left out + warns / OGMError', async () => {
    const ss = {
      selectionSet:
        '{ visitsConnection { edges { properties { note at { foo } } } } }',
    };
    const lax = await compile(false, ss);
    expect(lax.cypher).toContain('properties: e0 { .`note` }');
    expect(lax.warns.join('\n')).toMatch(
      /is a Point field, whose sub-selection takes only/,
    );
    await expect(compile(true, ss)).rejects.toThrow(OGMError);

    const sel = {
      select: {
        visitsConnection: {
          select: {
            edges: {
              properties: {
                select: { note: true, cat: { select: { longitude: true } } },
              },
            },
          },
        },
      },
    };
    const laxSel = await compile(false, sel);
    expect(laxSel.cypher).toContain('properties: e0 { .`note` }');
    expect(laxSel.warns.join('\n')).toMatch(
      /is a CartesianPoint field, whose select takes only/,
    );
    await expect(compile(true, sel)).rejects.toThrow(OGMError);
  });

  it('a point edge property projects; a scalar one with a sub-selection is still left out', async () => {
    const { cypher, warns } = await compile(false, {
      selectionSet:
        '{ visitsConnection { edges { properties { note at { longitude } } } } }',
    });
    expect(cypher).toContain(
      'properties: e0 { .`note`, `at`: CASE WHEN e0.`at` IS NULL THEN null ELSE { `longitude`: e0.`at`.x } END }',
    );
    expect(warns).toEqual([]);
    const other = await compile(false, {
      selectionSet:
        '{ visitsConnection { edges { properties { note { x } } } } }',
    });
    expect(other.cypher).toContain('properties: e0 {  }');
    expect(other.warns.join('\n')).toMatch(/is a scalar field \(String\)/);
  });
});
