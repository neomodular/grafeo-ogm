/**
 * v2.27.0 — `compile()` on a compile-only OGM returns exactly the statements a
 * real OGM sends. Every shared write / read / params case of the strict-mode
 * suites runs twice — on a real OGM over a recording driver, and on a
 * compile-only OGM whose models are wrapped in `compile()` — in default and
 * strict mode: same Cypher, same params, same rejection.
 */
import { OGM } from '../src/ogm';
import { compile, CompiledQuery, createCompileOnlyOgm } from '../src/testing';
import { readShapes, readTypeDefs } from './strict-mode.read-selections.cases';
import {
  badParamShapes,
  legitParamShapes,
  paramsTypeDefs,
} from './strict-mode.unknown-params.cases';
import {
  badWriteShapes,
  legitWriteShapes,
  Recorded,
  recordingDriver,
  Run,
  writeTypeDefs,
} from './strict-mode.writes.cases';

type Outcome =
  | { ok: true; statements: Recorded[] }
  | { ok: false; error: string };

const quiet = { debug: () => undefined, warn: () => undefined };

async function viaRecordingDriver(
  typeDefs: string,
  run: Run,
  strict: boolean,
): Promise<Outcome> {
  const records: Recorded[] = [];
  const ogm = new OGM({
    typeDefs,
    driver: recordingDriver(records),
    strict,
    logger: quiet,
  });
  try {
    await run(ogm);
    return { ok: true, statements: records };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function viaCompile(
  typeDefs: string,
  run: Run,
  strict: boolean,
): Promise<Outcome> {
  const ogm = createCompileOnlyOgm({ typeDefs, strict, logger: quiet });
  const compiled: CompiledQuery[] = [];
  const collect = (model: object) => {
    const c = compile(model) as Record<
      string,
      (p?: unknown) => Promise<CompiledQuery>
    >;
    return new Proxy(c, {
      get: (target, key: string) => async (p?: unknown) => {
        compiled.push(await target[key](p));
        return undefined;
      },
    });
  };
  const facade = {
    model: (name: string) => collect(ogm.model(name)),
    interfaceModel: (name: string) => collect(ogm.interfaceModel(name)),
  } as unknown as OGM;
  try {
    await run(facade);
    return {
      ok: true,
      statements: compiled.map(({ cypher, params }) => ({ cypher, params })),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

const suites: Array<[string, string, Record<string, Run>]> = [
  ['write shapes', writeTypeDefs, { ...badWriteShapes, ...legitWriteShapes }],
  ['read selections', readTypeDefs, readShapes],
  [
    'params',
    paramsTypeDefs,
    {
      ...legitParamShapes,
      ...Object.fromEntries(
        Object.entries(badParamShapes).map(([k, v]) => [k, v.run]),
      ),
    },
  ],
];

describe.each(suites)(
  'compile() parity with a recording driver: %s',
  (_s, typeDefs, shapes) => {
    const names = Object.keys(shapes);
    it('has cases', () => expect(names.length).toBeGreaterThan(0));
    describe.each([false, true])('strict: %s', (strict) => {
      it.each(names)('%s', async (name) => {
        const expected = await viaRecordingDriver(
          typeDefs,
          shapes[name],
          strict,
        );
        const actual = await viaCompile(typeDefs, shapes[name], strict);
        expect(actual).toEqual(expected);
      });
    });
  },
);
