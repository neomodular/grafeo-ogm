/**
 * v2.11.0 — strict item 23 must not change default-mode Cypher for types
 * with `@node(labels: [...])`. Every label site of `node-labels.cases.ts`
 * (reads, writes, nested ops, interface / union members, policies,
 * fulltext, vector, index statements) compiles byte-identically to v2.9.0
 * with `strict` unset and with `strict: false`. The golden file was
 * captured by running the same shapes on v2.9.0 (76e32ce).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildLabelOgm,
  labelShapes,
  labelStatements,
  runLabelShape,
} from './node-labels.cases';

const golden = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'node-labels.default.golden.json'),
    'utf-8',
  ),
) as Record<string, string[]>;

describe('@node(labels) — default mode is byte-identical to v2.9.0', () => {
  it('covers every golden shape', () => {
    expect(Object.keys(golden).sort()).toEqual(
      [...Object.keys(labelShapes), 'index statements'].sort(),
    );
  });

  for (const [name, run] of Object.entries(labelShapes)) {
    it(`${name} (strict unset)`, async () => {
      expect(await runLabelShape(run, undefined)).toEqual(golden[name]);
    });
    it(`${name} (strict: false)`, async () => {
      expect(await runLabelShape(run, false)).toEqual(golden[name]);
    });
  }

  it('index / constraint statements', () => {
    expect(labelStatements(buildLabelOgm([], undefined))).toEqual(
      golden['index statements'],
    );
    expect(labelStatements(buildLabelOgm([], false))).toEqual(
      golden['index statements'],
    );
  });
});
