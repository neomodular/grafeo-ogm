/**
 * Property 6 — write / read round-trip for every scalar kind.
 *
 * Random values for Int (beyond 2^31), BigInt (string / number / bigint
 * input), Float, Boolean, String (quotes, escapes, unicode), ID, DateTime
 * (offsets and zone ids), Date, LocalDateTime, Time, LocalTime, Duration,
 * Point, CartesianPoint, and a list of each, are written through `create`
 * and then `update`, and must read back through `find` exactly as Neo4j
 * itself builds them from the same input (`RETURN datetime($v)`, …,
 * converted by the documented read mapping). A `where` on the same values
 * — equality on every field at once, `_IN` on every scalar field, and the
 * list operators on list fields — must match the node.
 *
 * Opt-in on NEO4J_URI; every node carries this run's `runId` and every
 * case runs in a rolled-back transaction.
 */
import fc from 'fast-check';
import neo4j, { type Driver, type Transaction } from 'neo4j-driver';
import { ResultMapper } from '../../../src/execution/result-mapper';
import { OGM } from '../../../src/ogm';
import { stableJson } from './exec';
import {
  checkProperty,
  cleanup,
  describeLive,
  inRollback,
  makeDriver,
  newRunId,
  OutcomeStats,
} from './harness';
import {
  elementField,
  expectedExpr,
  isListField,
  scalarValues,
} from './scalars';
import { typeDefs } from './schema';

jest.setTimeout(300_000);

type Rec = Record<string, unknown>;

/** Bind Int / BigInt values as Longs, as the OGM is documented to store them. */
function bindExpected(field: string, value: unknown): unknown {
  const el = elementField(field);
  if (el !== 'i' && el !== 'bi') return value;
  const toInt = (v: unknown) => neo4j.int(String(v));
  return isListField(field) ? (value as unknown[]).map(toInt) : toInt(value);
}

/** What Neo4j stores for these inputs, in the OGM's documented read shape. */
async function expectedRow(tx: Transaction, values: Rec): Promise<Rec> {
  const fields = Object.keys(values);
  if (fields.length === 0) return {};
  const params: Rec = {};
  const proj = fields.map((f, i) => {
    params[`p${i}`] = bindExpected(f, values[f]);
    return `${f}: ${expectedExpr(f, `$p${i}`)}`;
  });
  const res = await tx.run(`RETURN { ${proj.join(', ')} } AS row`, params);
  return ResultMapper.convertNeo4jTypes(res.records[0].get('row')) as Rec;
}

/**
 * The stored property TYPES must match too (a datetime stored as a String,
 * or an Int as a Float, can read back looking equal): `valueType()` of the
 * stored property vs of Neo4j's own construction.
 */
async function typeMismatches(
  tx: Transaction,
  id: string,
  values: Rec,
): Promise<string[]> {
  const fields = Object.keys(values);
  if (fields.length === 0) return [];
  const params: Rec = { id };
  const stored = fields.map((f) => `${f}: valueType(n.\`${f}\`)`);
  const built = fields.map((f, i) => {
    params[`p${i}`] = bindExpected(f, values[f]);
    return `${f}: valueType(${expectedExpr(f, `$p${i}`)})`;
  });
  const res = await tx.run(
    `MATCH (n:ItPScalars {id: $id}) RETURN { ${stored.join(', ')} } AS stored, { ${built.join(', ')} } AS built`,
    params,
  );
  const s = res.records[0].get('stored') as Rec;
  const b = res.records[0].get('built') as Rec;
  return fields
    .filter((f) => s[f] !== b[f])
    .map((f) => `${f}: stored as ${String(s[f])}, expected ${String(b[f])}`);
}

describeLive('Property 6 — scalar write / read round-trip (live Neo4j)', () => {
  const runId = newRunId();
  let driver: Driver;
  let ogm: OGM;
  const stats = new OutcomeStats('round-trip');

  beforeAll(async () => {
    driver = makeDriver();
    await driver.verifyConnectivity();
    ogm = new OGM({ typeDefs, driver });
  });

  afterAll(async () => {
    stats.report();
    if (driver) {
      await cleanup(driver, runId);
      await driver.close();
    }
  });

  const Scalars = () => ogm.model('ItPScalars');

  it('every scalar kind written by create / update reads back equal and matches its own where', async () => {
    let n = 0;
    await checkProperty(
      'round-trip',
      fc.record({ created: scalarValues(), updated: scalarValues() }),
      async ({ created, updated }) => {
        const id = `${runId}-s${++n}`;
        await inRollback(driver, async (tx) => {
          const context = { transaction: tx };
          await Scalars().create({
            input: [{ id, runId, ...created }],
            context,
          });
          if (Object.keys(updated).length > 0)
            await Scalars().update({ where: { id }, update: updated, context });
          const values = { ...created, ...updated };
          const expected = await expectedRow(tx, values);

          const [row] = (await Scalars().find({
            where: { id },
            context,
          })) as Rec[];
          for (const [f, v] of Object.entries(expected))
            if (stableJson(row[f]) !== stableJson(v))
              throw new Error(
                `${f}: wrote ${stableJson(values[f])}, read ${stableJson(row[f])}, Neo4j stores ${stableJson(v)}`,
              );
          const wrongTypes = await typeMismatches(tx, id, values);
          if (wrongTypes.length > 0)
            throw new Error(
              `stored property types differ:\n  ${wrongTypes.join('\n  ')}`,
            );
          stats.add(`round-trip ${Object.keys(values).length} fields`);

          const fields = Object.keys(values);
          if (fields.length === 0) return;
          const matches = async (where: Rec) =>
            (await Scalars().count({ where: { id, ...where }, context })) === 1;

          // Equality on every written field at once; on failure, name it.
          if (!(await matches(values)))
            for (const f of fields)
              if (!(await matches({ [f]: values[f] })))
                throw new Error(
                  `where { ${f}: ${stableJson(values[f])} } does not match the node that stores it`,
                );

          // `_IN`: scalar fields take a list of candidates, list fields a
          // list of lists (Boolean has no `_IN`).
          const inWhere: Rec = {};
          for (const f of fields)
            if (f !== 'b' && f !== 'bs') inWhere[`${f}_IN`] = [values[f]];
          if (Object.keys(inWhere).length > 0 && !(await matches(inWhere)))
            for (const [k, v] of Object.entries(inWhere))
              if (!(await matches({ [k]: v })))
                throw new Error(
                  `where { ${k}: ${stableJson(v)} } does not match the node that stores it`,
                );
        });
      },
      100,
    );
  });
});
