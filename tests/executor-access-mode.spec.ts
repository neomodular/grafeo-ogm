import { Driver, Session, Transaction } from 'neo4j-driver';
import { Executor } from '../src/execution/executor';

function mockSession(): Session {
  return {
    run: jest.fn().mockResolvedValue({ records: [] }),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as Session;
}

function mockDriver(session: Session): Driver {
  return {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
}

describe('Executor — access mode (explain read-only guarantee)', () => {
  it('opens the auto-commit session in READ mode when requested', async () => {
    const session = mockSession();
    const driver = mockDriver(session);
    await new Executor(driver).execute('RETURN 1', {}, undefined, {
      accessMode: 'READ',
    });
    expect(driver.session).toHaveBeenCalledTimes(1);
    expect(driver.session).toHaveBeenCalledWith({ defaultAccessMode: 'READ' });
    expect(session.close).toHaveBeenCalled();
  });

  it('keeps the metadata path working in READ mode', async () => {
    const session = mockSession();
    const driver = mockDriver(session);
    await new Executor(driver).execute(
      'RETURN 1',
      { a: 1 },
      { metadata: { explain: true } },
      { accessMode: 'READ' },
    );
    expect(driver.session).toHaveBeenCalledWith({ defaultAccessMode: 'READ' });
    expect(session.run).toHaveBeenCalledWith(
      'RETURN 1',
      { a: 1 },
      { metadata: { explain: true } },
    );
  });

  it('leaves the default path unchanged (no-arg session())', async () => {
    const session = mockSession();
    const driver = mockDriver(session);
    await new Executor(driver).execute('RETURN 1', {});
    expect(driver.session).toHaveBeenCalledWith();
  });

  it('runs on a caller-supplied session unchanged, opening none', async () => {
    const own = mockSession();
    const driver = mockDriver(mockSession());
    await new Executor(driver).execute(
      'RETURN 1',
      {},
      { session: own },
      { accessMode: 'READ' },
    );
    expect(driver.session).not.toHaveBeenCalled();
    expect(own.run).toHaveBeenCalledWith('RETURN 1', {});
  });

  it('runs on a caller-supplied transaction unchanged, opening none', async () => {
    const tx = {
      run: jest.fn().mockResolvedValue({ records: [] }),
    } as unknown as Transaction;
    const driver = mockDriver(mockSession());
    await new Executor(driver).execute(
      'RETURN 1',
      {},
      { transaction: tx },
      { accessMode: 'READ' },
    );
    expect(driver.session).not.toHaveBeenCalled();
    expect(tx.run).toHaveBeenCalledWith('RETURN 1', {});
  });
});
