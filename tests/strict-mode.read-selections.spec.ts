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

describe('Point / CartesianPoint sub-selection (both modes, additive)', () => {
  for (const strict of [undefined, true]) {
    it(`strict: ${strict} — projects the upstream fields, no warning`, async () => {
      const warns: string[] = [];
      const [cypher] = await compileReadShape(
        (ogm) =>
          ogm.model('RsUser').find({
            selectionSet:
              '{ loc { longitude latitude height } cloc { x z crs } locs { lng: longitude } }',
          }),
        strict,
        warns,
      );
      expect(cypher).toContain(
        "`loc`: CASE WHEN n.`loc` IS NULL THEN null ELSE { `longitude`: n.`loc`.x, `latitude`: n.`loc`.y, `height`: CASE WHEN n.`loc`.crs ENDS WITH '-3d' THEN n.`loc`.z END } END",
      );
      expect(cypher).toContain(
        "`cloc`: CASE WHEN n.`cloc` IS NULL THEN null ELSE { `x`: n.`cloc`.x, `z`: CASE WHEN n.`cloc`.crs ENDS WITH '-3d' THEN n.`cloc`.z END, `crs`: n.`cloc`.crs } END",
      );
      expect(cypher).toContain(
        '`locs`: [__pt IN n.`locs` | { `lng`: __pt.x }]',
      );
      expect(warns).toEqual([]);
    });
  }

  it('a CartesianPoint field does not take Point field names', async () => {
    await expect(
      compileReadShape(
        (ogm) =>
          ogm.model('RsUser').find({ selectionSet: '{ cloc { longitude } }' }),
        true,
      ),
    ).rejects.toThrow(
      /"cloc" in selectionSet on type "RsUser" is a CartesianPoint field, whose sub-selection takes only "x", "y", "z", "crs", "srid", "__typename" \(not "longitude"\)/,
    );
  });

  it('an unknown sub-field warns in default mode', async () => {
    const warns: string[] = [];
    await compileReadShape(
      readShapes['point: unknown sub-field'],
      undefined,
      warns,
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('(not "x")');
  });
});

describe('strict item 32 — named fragment spreads', () => {
  it('default warns once per fragment name', async () => {
    const warns: string[] = [];
    await compileReadShape(
      readShapes['fragment: spread + definition'],
      undefined,
      warns,
    );
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain('"...U" on a node');
    expect(warns[1]).toContain('"...P" on a node');
  });

  it('default warns for a document the parser cannot read as one', async () => {
    const warns: string[] = [];
    await compileReadShape(
      readShapes['fragment: query keyword document'],
      undefined,
      warns,
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('not read as a document');
  });

  it('strict expands spreads like the equivalent inline fields', async () => {
    const [expanded] = await compileReadShape(
      readShapes['fragment: spread + definition'],
      true,
    );
    const [inline] = await compileReadShape(
      (ogm) =>
        ogm.model('RsUser').find({
          selectionSet:
            '{ name ... on RsUser { id } pets { ... on RsPet { name } } }',
        }),
      true,
    );
    expect(expanded).toEqual(inline);
    expect(expanded).toContain('.`id`');
    const [doc] = await compileReadShape(
      readShapes['fragment: query keyword document'],
      true,
    );
    expect(doc).toContain('RETURN n { .`name` }');
  });

  it('strict throws for an unknown, cyclic, duplicate or connection-level spread', async () => {
    await expect(
      compileReadShape(
        readShapes['fragment: spread without a definition'],
        true,
      ),
    ).rejects.toThrow(/Unknown fragment "U"/);
    await expect(
      compileReadShape(
        (ogm) =>
          ogm.model('RsUser').find({
            selectionSet:
              '{ ...A } fragment A on RsUser { name ...B } fragment B on RsUser { ...A }',
          }),
        true,
      ),
    ).rejects.toThrow(
      /Fragment "A" in selectionSet spreads itself \(A -> B -> A\)/,
    );
    await expect(
      compileReadShape(
        (ogm) =>
          ogm.model('RsUser').find({
            selectionSet:
              '{ ...A } fragment A on RsUser { name } fragment A on RsUser { id }',
          }),
        true,
      ),
    ).rejects.toThrow(/defined twice/);
    await expect(
      compileReadShape(
        readShapes['fragment: spread in connection edges'],
        true,
      ),
    ).rejects.toThrow(/"\.\.\.E" in "petsConnection\.edges" is not supported/);
  });
});
