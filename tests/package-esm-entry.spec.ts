/**
 * v2.9.1 — the published ES module entry points must load in native Node ESM
 * and type-check for a TypeScript `module: nodenext` consumer.
 *
 * Pre-2.9.1 `exports["."].import` pointed at dist/esm, whose files import
 * siblings without extensions (`export { OGM } from './ogm'`), so
 * `import { OGM } from 'grafeo-ogm'` in a `.mjs` file or a `"type": "module"`
 * app threw ERR_MODULE_NOT_FOUND (also for `grafeo-ogm/testing`), and the
 * `nodenext` consumer silently got `any` for every export.
 *
 * The suite runs the real `pnpm run build`, then installs the package into a
 * throwaway `"type": "module"` consumer (node_modules/grafeo-ogm symlinked to
 * the repo root, so resolution goes through package.json `exports` exactly as
 * for an npm install) and runs Node and `tsc` there.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

interface Report {
  main: string[];
  testing: string[];
  cjsMain: string[];
  cjsTesting: string[];
  esmBuildMain: string[];
  esmBuildTesting: string[];
  sameOGMErrorAsCjs: boolean;
  sameExecutorAsCjs: boolean;
  sameCypherAssertAcrossEntries: boolean;
  instanceofAcrossBuilds: boolean;
}

const CONSUMER_MJS = `
import * as main from 'grafeo-ogm';
import * as testing from 'grafeo-ogm/testing';
import { OGM, OGMError, Executor } from 'grafeo-ogm';
import { CypherAssert } from 'grafeo-ogm/testing';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const cjsMain = require('grafeo-ogm');
const cjsTesting = require('grafeo-ogm/testing');

// The tree-shakeable ESM build (bundlers, \`module\` field) must itself be
// loadable by a strict ESM resolver — every relative specifier resolvable.
const dist = join(process.env.GRAFEO_ROOT, 'dist', 'esm');
const esmBuildMain = await import(pathToFileURL(join(dist, 'index.js')).href);
const esmBuildTesting = await import(
  pathToFileURL(join(dist, 'testing', 'index.js')).href
);

if (typeof OGM !== 'function') throw new Error('OGM is not a class');

const keys = (m) => Object.keys(m).filter((k) => k !== 'default').sort();
process.stdout.write(
  JSON.stringify({
    main: keys(main),
    testing: keys(testing),
    cjsMain: keys(cjsMain),
    cjsTesting: keys(cjsTesting),
    esmBuildMain: keys(esmBuildMain),
    esmBuildTesting: keys(esmBuildTesting),
    sameOGMErrorAsCjs: OGMError === cjsMain.OGMError,
    sameExecutorAsCjs: Executor === cjsMain.Executor,
    sameCypherAssertAcrossEntries:
      CypherAssert === main.CypherAssert &&
      CypherAssert === cjsTesting.CypherAssert,
    instanceofAcrossBuilds: new cjsMain.OGMError('x') instanceof OGMError,
  }),
);
`;

// ESM consumer (\`"type": "module"\` package → consumer.ts is ESM under
// nodenext) and a CJS consumer (.cts) — both must see real types. The
// \`@ts-expect-error\` lines fail ("unused directive") if an import resolves
// to \`any\`, which is what an unresolvable declaration file degrades to.
const CONSUMER_TS = `
import { OGM, OGMError, Executor } from 'grafeo-ogm';
import { CypherAssert } from 'grafeo-ogm/testing';

type Config = ConstructorParameters<typeof OGM>[0];
export const typeDefs: Config['typeDefs'] = 'type A @node { id: ID! }';
export const err: Error = new OGMError('x');
export const debug: boolean = Executor.debug;

// @ts-expect-error — OGM must not be \`any\`
OGM.__notAStaticMember;
// @ts-expect-error — CypherAssert must not be \`any\`
CypherAssert.__notAStaticMember;
// @ts-expect-error — OGMError takes a string message
new OGMError(42);
`;

function run(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GRAFEO_ROOT: ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `${cmd} ${args.join(' ')} failed:\n${err.stdout ?? ''}\n${err.stderr ?? err.message}`,
    );
  }
}

describe('published ES module entry points (v2.9.1)', () => {
  let consumer: string;

  beforeAll(() => {
    run('pnpm', ['run', 'build'], ROOT);

    consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-esm-consumer-'));
    fs.writeFileSync(
      path.join(consumer, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
    );
    fs.mkdirSync(path.join(consumer, 'node_modules'));
    fs.symlinkSync(
      ROOT,
      path.join(consumer, 'node_modules', 'grafeo-ogm'),
      'junction',
    );
    fs.writeFileSync(path.join(consumer, 'consumer.mjs'), CONSUMER_MJS);
    fs.writeFileSync(path.join(consumer, 'consumer.ts'), CONSUMER_TS);
    fs.writeFileSync(path.join(consumer, 'consumer.cts'), CONSUMER_TS);
    fs.writeFileSync(
      path.join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'ES2022',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files: ['consumer.ts', 'consumer.cts'],
      }),
    );
  }, 180_000);

  afterAll(() => {
    if (consumer) fs.rmSync(consumer, { recursive: true, force: true });
  });

  it('imports grafeo-ogm and grafeo-ogm/testing from native Node ESM with the same exports as require()', () => {
    const report = JSON.parse(
      run(process.execPath, ['consumer.mjs'], consumer),
    ) as Report;

    expect(report.main).toEqual(
      expect.arrayContaining(['OGM', 'OGMError', 'Model', 'CypherAssert']),
    );
    expect(report.testing).toEqual([
      'CypherAssert',
      'Neo4jRecordFactory',
      'SelectionSetFactory',
    ]);

    // Every export is available from both entry points, both builds.
    expect(report.main).toEqual(report.cjsMain);
    expect(report.testing).toEqual(report.cjsTesting);
    expect(report.esmBuildMain).toEqual(report.cjsMain);
    expect(report.esmBuildTesting).toEqual(report.cjsTesting);

    // Node loads one copy: no dual-package hazard between import and require.
    expect(report.sameOGMErrorAsCjs).toBe(true);
    expect(report.sameExecutorAsCjs).toBe(true);
    expect(report.sameCypherAssertAcrossEntries).toBe(true);
    expect(report.instanceofAcrossBuilds).toBe(true);
  });

  it('type-checks for a TypeScript module: nodenext consumer (ESM and CJS)', () => {
    expect(() =>
      run(process.execPath, [TSC, '-p', 'tsconfig.json'], consumer),
    ).not.toThrow();
  });
});
