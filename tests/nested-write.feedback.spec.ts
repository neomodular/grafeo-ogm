/**
 * v2.7.1 — finding F2: a nested `connect` / `create` on a field that an
 * ENCLOSING nested update item iterates (chart -> categories -> charts ->
 * categories). Every row of the enclosing nested update also sees the links
 * and nodes the statement's earlier rows added (as in @neo4j/graphql 5.x),
 * so the work can grow geometrically (5 charts -> 7,345 nodes). Snapshot
 * semantics are a documented limitation in both modes; the Cypher is
 * unchanged (`nested-write.byte-identical.spec.ts`) and default mode warns
 * once per shape.
 */
import {
  compileShape,
  shapes,
  type Run,
} from './nested-write.byte-identical.shapes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = any;

const f2 = (warnings: string[]) =>
  warnings.filter((w) => w.includes('inside a nested update that iterates'));

async function warningsOf(run: Run, strict = false): Promise<string[]> {
  const warnings: string[] = [];
  await compileShape(run, strict ? 'strict' : 'plain', false, warnings);
  return f2(warnings);
}

const F2 =
  shapes[
    'updateMany: connect / create on a field an enclosing update iterates (F2)'
  ].run;

describe('nested connect / create on a field an enclosing update iterates (v2.7.1, finding F2)', () => {
  it('warns in default mode, naming the field', async () => {
    expect(await warningsOf(F2)).toEqual([
      '[OGM] updateMany on ItPChart has a nested connect / create on "ItPChart.categories" inside a nested ' +
        'update that iterates "ItPChart.categories" itself. Each row of that nested update also sees the links ' +
        'and nodes the earlier rows of the statement added, so the work can grow geometrically with the ' +
        'matched rows, and the result depends on row order. Split the write into separate calls, or narrow ' +
        'the nested "where".',
    ]);
  });

  it('warns for update and for a create alone', async () => {
    const run: Run = (ogm) =>
      (ogm.model('ItPTag') as AnyModel).update({
        where: { id: 't1' },
        update: {
          charts: [
            {
              update: {
                node: {
                  tags: [
                    {
                      update: {
                        node: {
                          charts: [{ create: [{ node: { id: 'x' } }] }],
                        },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      });
    expect(await warningsOf(run)).toEqual([
      expect.stringContaining(
        'update on ItPTag has a nested connect / create on "ItPTag.charts"',
      ),
    ]);
  });

  it('does not warn when no enclosing update iterates the field', async () => {
    const runs: Run[] = [
      // connect + update in the same item: the connect is not nested in the
      // iteration.
      (ogm) =>
        (ogm.model('ItPChart') as AnyModel).updateMany({
          where: { runId: 'r' },
          data: {
            categories: [
              {
                connect: [{ where: { node: { id: 'k1' } } }],
                update: { node: { name: 'q' } },
              },
            ],
          },
        }),
      // a nested create on another field.
      (ogm) =>
        (ogm.model('ItPChart') as AnyModel).updateMany({
          where: { runId: 'r' },
          data: {
            categories: [
              {
                update: {
                  node: {
                    charts: [{ create: [{ node: { id: 'x', runId: 'r' } }] }],
                  },
                },
              },
            ],
          },
        }),
      // sibling update and create items (finding F9).
      shapes['updateMany: sibling update and create items (F9)'].run,
    ];
    for (const run of runs) expect(await warningsOf(run)).toEqual([]);
  });

  it('strict mode does not warn and compiles the same Cypher', async () => {
    expect(await warningsOf(F2, true)).toEqual([]);
    const [plain] = await compileShape(F2, 'plain');
    const [strict] = await compileShape(F2, 'strict');
    expect(strict.cypher).toBe(plain.cypher);
  });
});
