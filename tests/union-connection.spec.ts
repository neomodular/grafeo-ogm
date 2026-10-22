/**
 * v2.9.0 — strict: a `<rel>Connection` selected under a union parent. The
 * union's merged definition carries the first member's relationship, so
 * every member's connection used `UcPost.tags` (`-[:UC_TAGGED]->`). Under
 * `strict: true` a member whose relationship differs gets its own `CASE`
 * branch; the first member's connection stays in `ELSE`. 2.x keeps the
 * v2.8.0 Cypher and warns (`union-connection.byte-identical.spec.ts`).
 */
import { OGM } from '../src/ogm';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';
import {
  fixedShapes,
  policies,
  Run,
  typeDefs,
  unchangedShapes,
} from './union-connection.cases';

/** Strict Cypher of the shapes with a differing member. */
const STRICT: Record<keyof typeof fixedShapes, string> = {
  mixedSelect:
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { mixed: [(n)-[:`UC_MIXED`]->(n0) WHERE (n0:`UcPost` OR n0:`UcVideo` OR n0:`UcAudio`) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcVideo', 'UcAudio']]), tagsConnection: CASE WHEN n0:`UcVideo` AND NOT n0:`UcPost` AND NOT n0:`UcAudio` THEN { edges: [(n0)<-[e1:`UC_LABELED`]-(n1:`UcTag`) | { node: n1 { .`name` }, properties: e1 { .`weight` } }], totalCount: size([(n0)<-[e1:`UC_LABELED`]-(n1:`UcTag`) | 1]) } ELSE { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | { node: n1 { .`name` }, properties: e1 { .`weight` } }], totalCount: size([(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | 1]) } END }] }",
  mixedWhere:
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { mixed: [(n)-[:`UC_MIXED`]->(n0) WHERE (n0:`UcPost` OR n0:`UcVideo` OR n0:`UcAudio`) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcVideo', 'UcAudio']]), tagsConnection: CASE WHEN n0:`UcVideo` AND NOT n0:`UcPost` AND NOT n0:`UcAudio` THEN { edges: [(n0)<-[e1:`UC_LABELED`]-(n1:`UcTag`) WHERE n1.`name` STARTS WITH $param2 | { node: n1 { .`name` } }] } ELSE { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) WHERE n1.`name` STARTS WITH $param1 | { node: n1 { .`name` } }] } END }] }",
  mixedFragments:
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { mixed: [(n)-[:`UC_MIXED`]->(n0) WHERE (n0:`UcPost` OR n0:`UcVideo` OR n0:`UcAudio`) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcVideo', 'UcAudio']]), tagsConnection: CASE WHEN n0:`UcVideo` AND NOT n0:`UcPost` AND NOT n0:`UcAudio` THEN { edges: [(n0)<-[e1:`UC_LABELED`]-(n1:`UcTag`) | { node: n1 { .`name` } }], totalCount: size([(n0)<-[e1:`UC_LABELED`]-(n1:`UcTag`) | 1]) } ELSE { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | { node: n1 { .`name` } }], totalCount: size([(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) | 1]) } END }] }",
  targetsWhere:
    "MATCH (n:`UcFeed`)\nWHERE n.`id` = $param0\nRETURN n { targets: [(n)-[:`UC_TARGETS`]->(n0) WHERE (n0:`UcPost` OR n0:`UcClip`) | n0 { __typename: head([__label IN labels(n0) WHERE __label IN ['UcPost', 'UcClip']]), tagsConnection: CASE WHEN n0:`UcClip` AND NOT n0:`UcPost` THEN { edges: [(n0)-[e1:`UC_BADGED`]->(n1:`UcBadge`) WHERE n1.`name` STARTS WITH $param2 | { node: n1 { .`name` } }] } ELSE { edges: [(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) WHERE n1.`name` STARTS WITH $param1 | { node: n1 { .`name` } }] } END }] }",
};

async function compile(
  run: Run,
  opts: { strict?: boolean; secured?: boolean } = {},
) {
  const records: Recorded[] = [];
  const logger = { debug: jest.fn(), warn: jest.fn() };
  const ogm = new OGM({
    typeDefs,
    driver: recordingDriver(records),
    logger,
    ...(opts.strict === undefined ? {} : { strict: opts.strict }),
    ...(opts.secured
      ? { policies, policyDefaults: { auditMetadata: false } }
      : {}),
  });
  await run(opts.secured ? (ogm.withContext({}) as unknown as OGM) : ogm);
  return { records, logger };
}

describe('strict: connection under a union parent (v2.9.0)', () => {
  it.each(Object.keys(STRICT) as Array<keyof typeof fixedShapes>)(
    '%s reads each differing member through its own relationship',
    async (name) => {
      const { records, logger } = await compile(fixedShapes[name], {
        strict: true,
      });
      expect(records).toHaveLength(1);
      expect(records[0].cypher).toBe(STRICT[name]);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it('keeps the first-member connection in ELSE and guards multi-label nodes', async () => {
    const { records } = await compile(fixedShapes.mixedSelect, {
      strict: true,
    });
    const cypher = records[0].cypher;
    // Only UcVideo differs; a node also labelled UcPost / UcAudio (which
    // share UcPost's relationship) keeps the first member's connection.
    expect(cypher).toContain(
      'tagsConnection: CASE WHEN n0:`UcVideo` AND NOT n0:`UcPost` AND NOT n0:`UcAudio` THEN ',
    );
    expect(cypher).toMatch(
      /ELSE \{ edges: \[\(n0\)-\[e1:`UC_TAGGED`\]->\(n1:`UcTag`\) .* END \}\] \}$/,
    );
  });

  it("applies the target's read policy in every branch", async () => {
    const { records } = await compile(fixedShapes.mixedSelect, {
      strict: true,
      secured: true,
    });
    const cypher = records[0].cypher;
    expect(cypher).toContain(
      '[(n0)<-[e1:`UC_LABELED`]-(n1:`UcTag`) WHERE (true AND (n1.`secret` = $param2)) |',
    );
    expect(cypher).toContain(
      '[(n0)-[e1:`UC_TAGGED`]->(n1:`UcTag`) WHERE (true AND (n1.`secret` = $param1)) |',
    );
    expect(records[0].params).toMatchObject({ param1: false, param2: false });
  });

  it('throws when an argument does not fit a member’s own relationship', async () => {
    // UcClip's target (UcBadge) has no `name` to sort on.
    const run =
      unchangedShapes['differing member a sort cannot compile for: fragments'];
    await expect(compile(run, { strict: true })).rejects.toThrow(/name/);
  });
});

describe('default mode: connection under a union parent (v2.9.0)', () => {
  it('warns once per union field that a member is read through the first member’s relationship', async () => {
    const records: Recorded[] = [];
    const logger = { debug: jest.fn(), warn: jest.fn() };
    const ogm = new OGM({ typeDefs, driver: recordingDriver(records), logger });
    await fixedShapes.mixedSelect(ogm);
    await fixedShapes.mixedFragments(ogm);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toBe(
      '[OGM] "tagsConnection", selected under the union "UcMixed", is read in 2.x through the relationship ' +
        'of its first member "UcPost" for every member, so the edges of "UcVideo" are wrong or missing. ' +
        'Enable `strict: true` (default in 3.0) to read each member through its own relationship.',
    );
    expect(records[0].cypher).not.toContain('CASE');
  });
});
