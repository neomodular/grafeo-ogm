import neo4j, { Driver, Session } from 'neo4j-driver';
import { Executor } from '../src/execution/executor';
import { OGM } from '../src/ogm';

/**
 * v2.4.8 — `Executor.debug = true` must never change behaviour. Pre-2.4.8
 * the params were logged with a bare `JSON.stringify`, which throws
 * "Do not know how to serialize a BigInt" — so turning debug on made every
 * query with a bigint param fail.
 */

function mockDriver(): { driver: Driver; session: Session } {
  const session = {
    run: jest.fn().mockResolvedValue({
      records: [],
      summary: { counters: { updates: () => ({}) } },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as Session;
  const driver = {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
  return { driver, session };
}

const logged = (debug: jest.Mock) =>
  debug.mock.calls.map((c) => c.slice(1).join(' ')).join('\n');

describe('debug logging of params', () => {
  const params = { big: 9007199254740993n, int: neo4j.int(42), s: 'x' };

  beforeEach(() => {
    Executor.debug = true;
  });
  afterEach(() => {
    Executor.debug = false;
  });

  it('Executor.execute runs a query with bigint / Integer params', async () => {
    const { driver, session } = mockDriver();
    const debug = jest.fn();
    await expect(
      new Executor(driver, { debug }).execute('RETURN $big', params),
    ).resolves.toBeDefined();
    expect(session.run).toHaveBeenCalledWith('RETURN $big', params);
    expect(logged(debug)).toContain('9007199254740993');
    expect(logged(debug)).toContain('42');
  });

  it('a param that cannot be serialized at all still never throws', async () => {
    const { driver } = mockDriver();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      new Executor(driver, { debug: jest.fn() }).execute('RETURN 1', {
        circular,
      }),
    ).resolves.toBeDefined();
  });

  it('$queryRaw and $executeRaw run with bigint params', async () => {
    const { driver } = mockDriver();
    const debug = jest.fn();
    const ogm = new OGM({
      typeDefs: 'type A @node { id: ID! }',
      driver,
      logger: { debug },
    });
    await expect(ogm.$queryRaw('RETURN $big', params)).resolves.toEqual([]);
    await expect(ogm.$executeRaw('RETURN $big', params)).resolves.toEqual({
      recordsAffected: 0,
    });
    expect(logged(debug)).toContain('9007199254740993');
  });
});

/**
 * v2.17.0 — `Executor.debug = true` without a logger used to print nothing
 * (the README FAQ says it logs every query). It now writes to stderr; a
 * configured logger still gets every line and stderr stays untouched.
 */
describe('Executor.debug without a logger', () => {
  let write: jest.SpyInstance;
  const stderrText = () => write.mock.calls.map((c) => String(c[0])).join('');

  beforeEach(() => {
    write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    write.mockRestore();
    Executor.debug = false;
  });

  it('writes the Cypher and params of model queries to stderr', async () => {
    Executor.debug = true;
    const { driver } = mockDriver();
    await new Executor(driver).execute('RETURN $x', { x: 7 });
    expect(stderrText()).toContain('[OGM] Cypher: RETURN $x');
    expect(stderrText()).toContain('"x": 7');
    expect(stderrText()).toContain('[OGM] Records returned: 0');
  });

  it('writes $queryRaw / $executeRaw lines to stderr', async () => {
    Executor.debug = true;
    const { driver } = mockDriver();
    const ogm = new OGM({ typeDefs: 'type A @node { id: ID! }', driver });
    await ogm.$queryRaw('RETURN 1 AS q');
    await ogm.$executeRaw('RETURN 2 AS e');
    expect(stderrText()).toContain('[OGM $queryRaw] Cypher: RETURN 1 AS q');
    expect(stderrText()).toContain('[OGM $executeRaw] Cypher: RETURN 2 AS e');
  });

  it('stays silent when debug is off', async () => {
    const { driver } = mockDriver();
    await new Executor(driver).execute('RETURN 1', {});
    expect(write).not.toHaveBeenCalled();
  });

  it('a configured logger gets the lines and stderr stays untouched', async () => {
    Executor.debug = true;
    const { driver } = mockDriver();
    const debug = jest.fn();
    await new Executor(driver, { debug }).execute('RETURN 1', {});
    expect(debug).toHaveBeenCalledWith('[OGM] Cypher: %s', 'RETURN 1');
    expect(write).not.toHaveBeenCalled();
  });
});
