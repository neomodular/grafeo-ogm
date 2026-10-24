/**
 * vNEXT — the typed `select` takes a point sub-selection on a stored
 * `Point` / `CartesianPoint` field of a node, an interface and relationship
 * properties: `loc: { select: { longitude: true } }`, the typed form of
 * the `loc { longitude }` selectionSet sub-selection. Pre-vNEXT the select
 * types offered only `loc?: boolean`, and the runtime left the object form
 * out of the result. These cases compile the generated file and real user
 * code against it.
 */
import { emitSelectFieldTypes } from '../src/generator/type-emitters/select-fields-emitter';
import { parseSchema } from '../src/schema/parser';
import { typecheckGenerated } from './helpers/generated-typecheck';

jest.setTimeout(60_000);

const PRELUDE = `
import type { OGM } from 'grafeo-ogm';
import type { ModelMap, InterfaceModelMap } from './generated';
import * as G from './generated';
declare const ogm: OGM<ModelMap, InterfaceModelMap>;
`;

const typeDefs = /* GraphQL */ `
  interface Located {
    id: ID!
    loc: Point
  }
  type Place implements Located @node {
    id: ID! @id
    loc: Point
    locs: [Point!]
    cloc: CartesianPoint
    name: String
    visits: [Place!]!
      @relationship(type: "VISIT", direction: OUT, properties: "Visit")
  }
  type Visit @relationshipProperties {
    at: Point
    note: String
  }
`;

describe('typed select: point sub-selection (vNEXT)', () => {
  it('emits the point select fields and types the result', async () => {
    const { generated, errors } = await typecheckGenerated(
      typeDefs,
      `${PRELUDE}
const edge: G.PlaceVisitsEdgeSelectFields = { at: { select: { latitude: true } }, note: true };
const iface: G.LocatedSelectFields = { loc: { select: { crs: true } } };
const sel = {
  id: true,
  loc: { select: { longitude: true, srid: true } },
  locs: { select: { latitude: true } },
  cloc: { select: { x: true, z: true } },
  name: true,
} satisfies G.PlaceSelectFields;
// Model methods return the node type; \`SelectResult\` types the selected shape.
type Row = G.SelectResult<G.Place, typeof sel>;
async function run() {
  await ogm.model('Place').find({ select: sel });
  const r = {} as Row;
  const lon: number | undefined = r.loc?.longitude;
  const srid: number | undefined = r.loc?.srid;
  const lat: number | undefined = r.locs?.[0]?.latitude;
  const z: number | null | undefined = r.cloc?.z;
  const name: string | null | undefined = r.name;
  // @ts-expect-error latitude was not selected
  r.loc?.latitude;
  // @ts-expect-error a Point has no x in its select fields
  const bad: G.PlaceSelectFields = { loc: { select: { x: true } } };
  const whole = {} as G.SelectResult<G.Place, { loc: true }>;
  const x: number | undefined = whole.loc?.x;
  return [edge, iface, lon, srid, lat, z, name, bad, x];
}
void run;
`,
    );
    expect(errors).toEqual([]);
    expect(generated).toContain('export type PointSelectFields = {');
    expect(generated).toContain('export type CartesianPointSelectFields = {');
    expect(generated).toContain(
      'loc?: boolean | { select: PointSelectFields };',
    );
    expect(generated).toContain(
      'at?: boolean | { select: PointSelectFields };',
    );
  });

  it('schemas without stored points emit no point select types', () => {
    const out = emitSelectFieldTypes(
      parseSchema('type A @node { id: ID! @id name: String }'),
    );
    expect(out).not.toContain('PointSelectFields');
  });
});
