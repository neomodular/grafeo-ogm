/**
 * v2.7.0 — `<rel>Aggregate` compilation (Cypher shape). The live suite
 * (`tests/integration/rel-aggregate.spec.ts`) proves the results on Neo4j
 * 5.26; this pins the forms that make them valid at any depth:
 *
 * - no aggregating function (`count(`, `min(`, `avg(`, …) and no `CALL`
 *   anywhere (Neo4j 5.x rejects aggregation inside list expressions, and
 *   nested selections are pattern comprehensions);
 * - every aggregate reads the pattern filtered by the target read policy;
 * - the typed `select` compiles to the same Cypher as the selectionSet.
 */
import { OGM } from '../src/ogm';
import { policies, typeDefs } from './integration/properties/schema';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';

async function compile(
  run: (ogm: OGM) => Promise<unknown>,
  opts: { policies?: boolean; strict?: boolean } = {},
): Promise<Recorded> {
  const records: Recorded[] = [];
  const ogm = new OGM({
    typeDefs,
    driver: recordingDriver(records),
    ...(opts.strict ? { strict: true } : {}),
    ...(opts.policies
      ? { policies, policyDefaults: { auditMetadata: false } }
      : {}),
  });
  await run(
    opts.policies
      ? (ogm.withContext({ uid: 'u1', tid: 't1' }) as unknown as OGM)
      : ogm,
  );
  expect(records).toHaveLength(1);
  return records[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tag = (ogm: OGM): any => ogm.model('ItPTag');
const find = (selectionSet: string) => (ogm: OGM) =>
  tag(ogm).find({ where: { id: 't1' }, selectionSet });

const AGGREGATING = /\b(count|min|max|avg|sum|collect)\s*\(/i;

describe('<rel>Aggregate compilation (v2.7.0)', () => {
  it('uses COUNT { } and reduce folds only — no aggregating function, no CALL', async () => {
    const { cypher } = await compile(
      find(`{ id chartsAggregate { count node { rank { min max average sum } name { shortest longest } }
        edge { weight { sum } note { longest } } }
        charts { categoriesAggregate { count node { name { shortest } } } } }`),
    );
    expect(cypher).toContain(
      'chartsAggregate: { `count`: COUNT { (n)-[e0:`ITP_TAGS`]->(n0:`ItPChart`) }',
    );
    expect(cypher).toContain(
      'categoriesAggregate: { `count`: COUNT { (n0)-[e1:`ITP_IN_CAT`]->(n1:`ItPCategory`) }',
    );
    expect(cypher).toMatch(/reduce\(__a0 = /);
    expect(cypher).toMatch(/reduce\(__a1 = /);
    expect(cypher).not.toMatch(AGGREGATING);
    expect(cypher).not.toMatch(/\bCALL\b/);
  });

  it('every aggregate reads the pattern filtered by where AND the target read policy', async () => {
    const { cypher } = await compile(
      find(
        `{ chartsAggregate(where: { rank_GT: 1 }) { count node { rank { max } } edge { weight { sum } } } }`,
      ),
      { policies: true },
    );
    const filtered =
      '(n)-[e0:`ITP_TAGS`]->(n0:`ItPChart`) WHERE (n0.`rank` > $param1) AND (true AND (n0.`secret` = $param2))';
    expect(cypher).toContain(`COUNT { ${filtered} }`);
    expect(cypher).toContain(`[${filtered} | n0.\`rank\`]`);
    expect(cypher).toContain(`[${filtered} | e0.\`weight\`]`);
  });

  it('abstract targets: per-member policy clauses; strict adds the member restriction', async () => {
    const policyBound = await compile(
      find('{ resourcesAggregate { count } }'),
      {
        policies: true,
      },
    );
    expect(policyBound.cypher).toContain(
      'COUNT { (n)-[e0:`ITP_RES`]->(n0) WHERE ((n0:`ItPChart` OR n0:`ItPDrug`) AND (NOT n0:`ItPChart` OR (true AND (n0.`secret` = $param1))) AND (NOT n0:`ItPDrug` OR false)) }',
    );
    const plain = await compile(find('{ resourcesAggregate { count } }'));
    expect(plain.cypher).toContain('COUNT { (n)-[e0:`ITP_RES`]->(n0) }');
    const strict = await compile(find('{ resourcesAggregate { count } }'), {
      strict: true,
    });
    expect(strict.cypher).toContain(
      'COUNT { (n)-[e0:`ITP_RES`]->(n0) WHERE (n0:`ItPChart` OR n0:`ItPDrug`) }',
    );
  });

  it('directed: false drops the arrow', async () => {
    const { cypher } = await compile(
      find('{ chartsAggregate(directed: false) { count } }'),
    );
    expect(cypher).toContain('COUNT { (n)-[e0:`ITP_TAGS`]-(n0:`ItPChart`) }');
  });

  it('typed select compiles to the selectionSet Cypher', async () => {
    const viaSet = await compile(
      find(
        `{ id chartsAggregate(where: { rank_GT: 1 }, directed: false) { count node { rank { min sum } } edge { weight { max } } } }`,
      ),
      { policies: true },
    );
    const viaSelect = await compile(
      (ogm) =>
        tag(ogm).find({
          where: { id: 't1' },
          select: {
            id: true,
            chartsAggregate: {
              where: { rank_GT: 1 },
              directed: false,
              select: {
                count: true,
                node: {
                  select: { rank: { select: { min: true, sum: true } } },
                },
                edge: { select: { weight: { select: { max: true } } } },
              },
            },
          },
        }),
      { policies: true },
    );
    expect(viaSelect.cypher).toBe(viaSet.cypher);
    expect(viaSelect.params).toEqual(viaSet.params);
  });

  it('a field or relationship named <x>Aggregate keeps its meaning', async () => {
    // `nameAggregate` names no relationship (`name` is a scalar): it stays
    // a plain selection, as before.
    const { cypher } = await compile(find('{ id nameAggregate }'));
    expect(cypher).toBe(
      'MATCH (n:`ItPTag`)\nWHERE n.`id` = $param0\nRETURN n { .`id`, .`nameAggregate` }',
    );
  });

  it('rejects what upstream does not offer', async () => {
    const bad: Array<[string, RegExp]> = [
      [
        '{ chartsAggregate(options: { limit: 1 }) { count } }',
        /options .* not supported/,
      ],
      ['{ chartsAggregate(directed: 1) { count } }', /must be true or false/],
      ['{ charts(directed: false) { id } }', /Unsupported argument "directed"/],
      ['{ chartsAggregate { total } }', /Unknown field "total"/],
      ['{ chartsAggregate { node } }', /needs a selection of fields/],
      ['{ chartsAggregate { node { secret { min } } } }', /has no aggregates/],
      [
        '{ chartsAggregate { node { rank } } }',
        /needs a selection of aggregates/,
      ],
      [
        '{ chartsAggregate { node { rank { longest } } } }',
        /Unknown aggregate "longest"/,
      ],
      [
        '{ resourcesAggregate { edge { weight { sum } } } }',
        /no @relationshipProperties/,
      ],
      [
        '{ itemsAggregate { node { id { min } } } }',
        /union ItPItem, which has no node aggregates/,
      ],
    ];
    for (const [selectionSet, error] of bad)
      await expect(compile(find(selectionSet))).rejects.toThrow(error);
    await expect(
      compile((ogm) =>
        tag(ogm).find({
          select: { chartsAggregate: { select: { nodes: true } } },
        }),
      ),
    ).rejects.toThrow(/Unknown key "nodes"/);
  });
});
