/**
 * Live transaction-metadata suite (v2.4.8).
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node it creates carries
 * this run's `runId` (label `LaMetaBook`) and is removed in `afterAll`.
 *
 * The server's own view of the transaction metadata is read back with
 * `CALL tx.getMetaData()` from a `@cypher` field, so each assertion proves
 * what actually reached Neo4j — not what the driver was handed.
 *
 * neo4j-driver 5.x has no `Transaction.setMetaData`; pre-2.4.8 the
 * executor silently skipped metadata for calls inside a transaction, and
 * `$transaction` offered no way to attach any.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type LaMetaBook @node {
    id: ID! @id
    runId: String
    serverModelType: String
      @cypher(
        statement: "CALL tx.getMetaData() YIELD metadata RETURN metadata.modelType AS m"
        columnName: "m"
      )
    serverJob: String
      @cypher(
        statement: "CALL tx.getMetaData() YIELD metadata RETURN metadata.job AS j"
        columnName: "j"
      )
  }
`;

type Row = Record<string, unknown>;

describeLive('transaction metadata — live Neo4j', () => {
  const runId = `la-${randomUUID()}`;
  let driver: Driver;
  const warn = jest.fn();
  const logger = { debug: () => {}, warn };
  let ogm: OGM;

  async function run(cypher: string): Promise<void> {
    const session = driver.session();
    try {
      await session.run(cypher, { runId });
    } finally {
      await session.close();
    }
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
    ogm = new OGM({
      typeDefs,
      driver,
      logger,
      policies: {
        LaMetaBook: [
          permissive({
            operations: ['read'],
            when: () => ({ runId }),
            name: 'la-run-scope',
          }),
        ],
      },
    });
    await run('CREATE (:LaMetaBook {id: randomUUID(), runId: $runId})');
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n:LaMetaBook {runId: $runId}) DETACH DELETE n');
      await driver.close();
    }
  });

  beforeEach(() => warn.mockClear());

  const select = { serverModelType: true, serverJob: true };

  it('auto-commit: policy audit metadata reaches the server', async () => {
    const rows = (await ogm
      .withContext({ uid: 'a' })
      .model('LaMetaBook')
      .find({ select })) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0].serverModelType).toBe('LaMetaBook');
    expect(warn).not.toHaveBeenCalled();
  });

  it('$transaction(fn, { metadata }) attaches it when the tx begins', async () => {
    const rows = (await ogm.$transaction(
      async (ctx) =>
        ogm
          .model('LaMetaBook')
          .find({ where: { runId }, select, context: ctx }),
      { metadata: { job: 'la-nightly' } },
    )) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0].serverJob).toBe('la-nightly');
  });

  it('inside a transaction, per-call audit metadata cannot attach — it warns instead of no-oping', async () => {
    const rows = (await ogm.$transaction(async (ctx) =>
      ogm
        .withContext({ uid: 'a' })
        .model('LaMetaBook')
        .find({ select, context: ctx }),
    )) as Row[];
    expect(rows).toHaveLength(1);
    // The server never saw the per-call audit (the driver has no API for it)…
    expect(rows[0].serverModelType).toBeNull();
    // …and the OGM now says so.
    expect(
      warn.mock.calls.filter((c) => /metadata not attached/.test(String(c[0]))),
    ).toHaveLength(1);
  });
});
