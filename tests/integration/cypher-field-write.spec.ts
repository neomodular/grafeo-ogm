/**
 * Live suite — `@cypher` fields given as write input (v2.19.0, strict item
 * 29).
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
 *
 * Default mode keeps the 2.x behaviour: the value is stored as a property
 * that the field never reads (reads still return the computed value), and
 * one warning is logged. `strict: true` throws `OGMError` and writes
 * nothing.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGMError } from '../../src/errors';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItCfwNode @node {
    id: ID! @id
    runId: String
    name: String @unique
    n: Int
    double: Int @cypher(statement: "RETURN this.n * 2 AS d", columnName: "d")
  }
`;

type Row = Record<string, unknown>;

describeLive('@cypher fields in write inputs — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let driver: Driver;

  async function run(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Row[]> {
    const session = driver.session();
    try {
      const res = await session.run(cypher, { runId, ...params });
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  function makeOgm(strict?: boolean) {
    const warnings: string[] = [];
    const ogm = new OGM({
      typeDefs,
      driver,
      logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
      ...(strict === undefined ? {} : { strict }),
    });
    return { nodes: ogm.model('ItCfwNode'), warnings };
  }

  /** The raw stored `double` property of each node named `name*`. */
  async function stored(prefix: string): Promise<Row[]> {
    return run(
      `MATCH (n:ItCfwNode) WHERE n.runId = $runId AND n.name STARTS WITH $prefix
       RETURN n.name AS name, n.double AS stored ORDER BY name`,
      { prefix },
    );
  }

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    await driver.verifyConnectivity();
  });

  afterAll(async () => {
    await run('MATCH (n:ItCfwNode {runId: $runId}) DETACH DELETE n');
    await driver.close();
  });

  const cypherWarnings = (w: string[]) =>
    w.filter((m) => m.includes('is a @cypher field'));

  it('default: create / update / createMany / upsert store a phantom property and warn once', async () => {
    const p = `${runId}-d-`;
    const { nodes, warnings } = makeOgm();
    await nodes.create({ input: [{ runId, name: `${p}c`, n: 1, double: 99 }] });
    await nodes.update({ where: { name: `${p}c` }, update: { double: 98 } });
    await nodes.createMany({
      data: [{ runId, name: `${p}m`, n: 1, double: 97 }],
    });
    await nodes.upsert({
      where: { name: `${p}u` },
      create: { runId, name: `${p}u`, n: 1, double: 96 },
      update: {},
    });
    expect(await stored(p)).toEqual([
      { name: `${p}c`, stored: 98 },
      { name: `${p}m`, stored: 97 },
      { name: `${p}u`, stored: 96 },
    ]);
    // Reads return the computed value, never the stored one.
    const read = await nodes.find({
      where: { name: `${p}c` },
      selectionSet: '{ double }',
    });
    expect(read).toEqual([{ double: 2 }]);
    expect(cypherWarnings(warnings)).toHaveLength(1);
  });

  it.each([
    [
      'create',
      (m: ReturnType<typeof makeOgm>['nodes'], p: string) =>
        m.create({ input: [{ runId, name: `${p}c`, double: 1 }] }),
    ],
    [
      'createMany',
      (m: ReturnType<typeof makeOgm>['nodes'], p: string) =>
        m.createMany({ data: [{ runId, name: `${p}m`, double: 1 }] }),
    ],
    [
      'upsert',
      (m: ReturnType<typeof makeOgm>['nodes'], p: string) =>
        m.upsert({
          where: { name: `${p}u` },
          create: { runId, name: `${p}u`, double: 1 },
          update: {},
        }),
    ],
  ])(
    'strict: %s with a @cypher field throws and writes nothing',
    async (op, fn) => {
      const p = `${runId}-s-${op}-`;
      const { nodes, warnings } = makeOgm(true);
      await expect(fn(nodes, p)).rejects.toThrow(OGMError);
      expect(await stored(p)).toEqual([]);
      expect(warnings).toEqual([]);
    },
  );

  it('strict: update with a @cypher field throws and leaves the node unchanged', async () => {
    const p = `${runId}-su-`;
    const { nodes } = makeOgm(true);
    await nodes.create({ input: [{ runId, name: `${p}x`, n: 1 }] });
    await expect(
      nodes.update({ where: { name: `${p}x` }, update: { n: 5, double: 1 } }),
    ).rejects.toThrow(
      'Field "double" in the update input of ItCfwNode is a @cypher field',
    );
    const rows = await run(
      'MATCH (n:ItCfwNode {name: $name}) RETURN n.n AS n, n.double AS d',
      { name: `${p}x` },
    );
    expect(rows).toEqual([{ n: 1, d: null }]);
  });
});
