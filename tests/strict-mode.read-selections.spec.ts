/**
 * vNEXT — strict items 31–36: selectionSet shapes 2.x silently drops,
 * truncates or projects wrongly. Default-mode Cypher is byte-identical to
 * v2.15.0 (golden captured from 6572bdc); strict mode corrects or rejects
 * the shape. Live behaviour: `integration/strict-mode.read-selections.spec.ts`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  compileReadShape,
  readShapes,
} from './strict-mode.read-selections.cases';

const golden = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      'fixtures',
      'strict-mode.read-selections.default.golden.json',
    ),
    'utf-8',
  ),
) as Record<string, string[]>;

describe('read selection shapes — default mode is byte-identical to v2.15.0', () => {
  it('covers every golden shape', () => {
    expect(Object.keys(golden).sort()).toEqual(Object.keys(readShapes).sort());
  });

  for (const [name, run] of Object.entries(readShapes)) {
    it(`${name} (strict unset)`, async () => {
      expect(await compileReadShape(run, undefined)).toEqual(golden[name]);
    });
    it(`${name} (strict: false)`, async () => {
      expect(await compileReadShape(run, false)).toEqual(golden[name]);
    });
  }
});

describe('strict item 33 — a selection deeper than maxDepth', () => {
  it('default warns once per OGM', async () => {
    const warns: string[] = [];
    await compileReadShape(
      readShapes['depth: 6 levels (beyond maxDepth)'],
      undefined,
      warns,
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(
      /Selection "friends" is nested deeper than the maximum selection depth \(5\); 2\.x leaves it out/,
    );
  });

  it('default does not warn within maxDepth', async () => {
    const warns: string[] = [];
    await compileReadShape(
      readShapes['depth: 5 levels (within maxDepth)'],
      undefined,
      warns,
    );
    expect(warns).toEqual([]);
  });

  it('strict throws for a relationship and a connection beyond maxDepth', async () => {
    await expect(
      compileReadShape(readShapes['depth: 6 levels (beyond maxDepth)'], true),
    ).rejects.toThrow(/"friends" is nested deeper than the maximum/);
    await expect(
      compileReadShape(readShapes['depth: 6 levels via connection'], true),
    ).rejects.toThrow(/"friendsConnection" is nested deeper than the maximum/);
  });

  it('strict compiles a selection within maxDepth like default mode', async () => {
    const run = readShapes['depth: 5 levels (within maxDepth)'];
    expect(await compileReadShape(run, true)).toEqual(
      golden['depth: 5 levels (within maxDepth)'],
    );
  });
});
