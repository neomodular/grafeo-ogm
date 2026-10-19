import { Driver, Session, Transaction } from 'neo4j-driver';
import { Executor, OGMLogger } from '../src/execution/executor';
import { OGM } from '../src/ogm';
import { permissive } from '../src/policy/types';

/**
 * v2.4.8 — transaction audit metadata.
 *
 * neo4j-driver 5.x transactions have no `setMetaData` method: metadata is
 * only accepted when the transaction BEGINS (`beginTransaction({ metadata })`,
 * `executeRead/Write(fn, { metadata })`) or on an auto-commit
 * `session.run(q, p, { metadata })`. Pre-2.4.8 the executor looked for
 * `tx.setMetaData`, found nothing, and returned silently — every audit field
 * for a call inside a caller transaction was dropped with no signal.
 */

const schema = `
type Book @node {
  id: ID! @id @unique
  title: String!
  ownerId: String
}
`;

/** Shaped like a real driver-5 Transaction: no `setMetaData`. */
function mockTx(): Transaction {
  return {
    run: jest.fn().mockResolvedValue({ records: [] }),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  } as unknown as Transaction;
}

function mockLogger(): OGMLogger & { warn: jest.Mock; debug: jest.Mock } {
  return { debug: jest.fn(), warn: jest.fn() };
}

function mockDriver(tx: Transaction): {
  driver: Driver;
  session: Session;
} {
  const session = {
    run: jest.fn().mockResolvedValue({ records: [] }),
    beginTransaction: jest.fn().mockReturnValue(tx),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as Session;
  const driver = {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
  return { driver, session };
}

describe('Executor — metadata on a caller-supplied transaction', () => {
  it('warns once per call instead of silently dropping the metadata', async () => {
    const tx = mockTx();
    const logger = mockLogger();
    const { driver } = mockDriver(tx);

    await new Executor(driver, logger).execute(
      'RETURN 1',
      { a: 1 },
      { transaction: tx, metadata: { modelType: 'Book', operation: 'read' } },
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/metadata/i);
    // The query itself is unchanged.
    expect(tx.run).toHaveBeenCalledWith('RETURN 1', { a: 1 });
  });

  // v2.5.3 — pre-2.5.3 every call in the transaction warned again, and the
  // advice (pass metadata at begin) did not silence it.
  it('warns once per transaction, not once per call', async () => {
    const tx = mockTx();
    const other = mockTx();
    const logger = mockLogger();
    const { driver } = mockDriver(tx);
    const executor = new Executor(driver, logger);
    const metadata = { modelType: 'Book', operation: 'read' };

    await executor.execute('RETURN 1', {}, { transaction: tx, metadata });
    await executor.execute('RETURN 2', {}, { transaction: tx, metadata });
    await executor.execute('RETURN 3', {}, { executionContext: tx, metadata });
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await executor.execute('RETURN 4', {}, { transaction: other, metadata });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0][0]).toMatch(
      /metadata not attached.*per-call policy audit.*once per transaction/is,
    );
  });

  it('does not warn when there is no metadata to attach', async () => {
    const tx = mockTx();
    const logger = mockLogger();
    const { driver } = mockDriver(tx);

    await new Executor(driver, logger).execute(
      'RETURN 1',
      {},
      { transaction: tx },
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still uses a transaction-level setMetaData when one exists', async () => {
    const setMetaData = jest.fn();
    const tx = { ...mockTx(), setMetaData } as unknown as Transaction;
    const logger = mockLogger();
    const { driver } = mockDriver(tx);

    await new Executor(driver, logger).execute(
      'RETURN 1',
      {},
      { executionContext: tx, metadata: { a: 1 } },
    );

    expect(setMetaData).toHaveBeenCalledWith({ a: 1 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a policy-bound model call inside $transaction warns about the dropped audit', async () => {
    const tx = mockTx();
    const logger = mockLogger();
    const { driver } = mockDriver(tx);
    const ogm = new OGM({
      typeDefs: schema,
      driver,
      logger,
      policies: {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({ ownerId: 'u' }),
            name: 'p1',
          }),
        ],
      },
    });

    await ogm.$transaction(async (ctx) =>
      ogm.withContext({ uid: 'a' }).model('Book').find({ context: ctx }),
    );

    expect(
      logger.warn.mock.calls.filter((c) => /metadata/i.test(String(c[0]))),
    ).toHaveLength(1);
  });
});

describe('$transaction — metadata at begin time', () => {
  it('passes { metadata } to beginTransaction', async () => {
    const tx = mockTx();
    const { driver, session } = mockDriver(tx);
    const ogm = new OGM({ typeDefs: schema, driver });

    await ogm.$transaction(async () => 1, { metadata: { job: 'nightly' } });

    expect(session.beginTransaction).toHaveBeenCalledWith({
      metadata: { job: 'nightly' },
    });
  });

  it('passes { metadata } in the array form too', async () => {
    const tx = mockTx();
    const { driver, session } = mockDriver(tx);
    const ogm = new OGM({ typeDefs: schema, driver });

    await ogm.$transaction([async () => 1], { metadata: { job: 'x' } });

    expect(session.beginTransaction).toHaveBeenCalledWith({
      metadata: { job: 'x' },
    });
  });

  it('keeps the no-arg beginTransaction() call when no metadata is given', async () => {
    const tx = mockTx();
    const { driver, session } = mockDriver(tx);
    const ogm = new OGM({ typeDefs: schema, driver });

    await ogm.$transaction(async () => 1);

    expect(session.beginTransaction).toHaveBeenCalledWith();
  });
});
