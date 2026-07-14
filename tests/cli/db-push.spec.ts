import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Driver } from 'neo4j-driver';
import { runDbPush } from '../../src/cli/commands/db-push';
import type { LiveSchema } from '../../src/cli/push-planner';
import type { CliIO } from '../../src/cli/types';

const SCHEMA = `
type Book @fulltext(indexes: [{ name: "BookSearch", fields: ["title"] }]) {
  id: ID! @id @unique
  title: String!
}
type Author {
  id: ID! @id @unique
  name: String!
}
`;

const ALL_IN_SYNC: LiveSchema = {
  constraints: [
    { name: 'Book_id_unique', type: 'UNIQUENESS' },
    { name: 'Author_id_unique', type: 'UNIQUENESS' },
  ],
  indexes: [{ name: 'BookSearch', type: 'FULLTEXT' }],
};

function record(obj: Record<string, string>) {
  return { get: (key: string) => obj[key] };
}

interface MockDriver {
  driver: Driver;
  runs: string[];
  isClosed(): boolean;
}

function makeDriver(live: LiveSchema): MockDriver {
  const runs: string[] = [];
  let closed = false;
  const session = {
    run: jest.fn(async (cypher: string) => {
      runs.push(cypher);
      if (cypher === 'SHOW CONSTRAINTS')
        return { records: live.constraints.map((c) => record({ ...c })) };
      if (cypher === 'SHOW INDEXES')
        return { records: live.indexes.map((i) => record({ ...i })) };
      return { records: [] };
    }),
    close: jest.fn(async () => undefined),
  };
  const driver = {
    session: jest.fn(() => session),
    close: jest.fn(async () => {
      closed = true;
    }),
  } as unknown as Driver;
  return { driver, runs, isClosed: () => closed };
}

interface TestIO extends CliIO {
  stdout: string[];
  stderr: string[];
}

function makeIO(
  driver: Driver,
  opts?: { interactive?: boolean; confirm?: (q: string) => Promise<boolean> },
): TestIO {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-push-'));
  fs.writeFileSync(path.join(cwd, 'schema.graphql'), SCHEMA);
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    cwd,
    env: {
      NEO4J_URI: 'bolt://localhost',
      NEO4J_USERNAME: 'neo4j',
      NEO4J_PASSWORD: 'secret',
    },
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
    driverFactory: () => driver,
    interactive: opts?.interactive,
    confirm: opts?.confirm,
    stdout,
    stderr,
  };
}

const wrote = (runs: string[]) =>
  runs.filter((c) => c.startsWith('CREATE') || c.startsWith('DROP'));

describe('grafeo db push (cli-db-push spec)', () => {
  it('--dry-run prints the plan cypher and executes no writes', async () => {
    const mock = makeDriver({ constraints: [], indexes: [] });
    const io = makeIO(mock.driver);

    const code = await runDbPush(['--dry-run'], io);

    expect(code).toBe(0);
    const out = io.stdout.join('\n');
    expect(out).toContain('CREATE CONSTRAINT Book_id_unique');
    expect(out).toContain('CREATE FULLTEXT INDEX BookSearch');
    expect(out).toContain('Dry run');
    expect(wrote(mock.runs)).toHaveLength(0);
    expect(mock.isClosed()).toBe(true);
  });

  it('additive apply creates every missing item', async () => {
    const mock = makeDriver({ constraints: [], indexes: [] });
    const io = makeIO(mock.driver);

    const code = await runDbPush([], io);

    expect(code).toBe(0);
    expect(wrote(mock.runs).filter((c) => c.startsWith('CREATE'))).toHaveLength(
      3,
    );
    expect(io.stdout.join('\n')).toContain('✓ created');
  });

  it('is idempotent — a second push against an in-sync DB writes nothing', async () => {
    const mock = makeDriver(ALL_IN_SYNC);
    const io = makeIO(mock.driver);

    const code = await runDbPush([], io);

    expect(code).toBe(0);
    expect(io.stdout.join('\n')).toContain('No changes');
    expect(wrote(mock.runs)).toHaveLength(0);
  });

  it('sanitizes control characters in live-DB names before printing (v1.13.0)', async () => {
    // An attacker with schema-write can name a constraint with ANSI escapes;
    // it must land in `unmanaged` (never dropped) AND print without the raw
    // escape bytes reaching the terminal.
    const hostile = 'evil\u001b]0;pwned\u0007constraint';
    const mock = makeDriver({
      ...ALL_IN_SYNC,
      constraints: [
        ...ALL_IN_SYNC.constraints,
        { name: hostile, type: 'UNIQUENESS' },
      ],
    });
    const io = makeIO(mock.driver);

    const code = await runDbPush([], io);

    expect(code).toBe(0);
    const out = io.stdout.join('\n');
    expect(out).toContain('Unmanaged — 1 ignored');
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u0007');
    expect(out).toContain('evil�]0;pwned�constraint');
    expect(wrote(mock.runs)).toHaveLength(0);
  });

  it('reports an orphan as kept when --force-drop is not passed', async () => {
    const mock = makeDriver({
      ...ALL_IN_SYNC,
      constraints: [
        ...ALL_IN_SYNC.constraints,
        { name: 'Author_email_unique', type: 'UNIQUENESS' },
      ],
    });
    const io = makeIO(mock.driver);

    const code = await runDbPush([], io);

    expect(code).toBe(0);
    const out = io.stdout.join('\n');
    expect(out).toContain('Author_email_unique');
    expect(out).toContain('kept');
    expect(out).toContain('--force-drop');
    // An outstanding orphan means the schema is NOT in sync.
    expect(out).not.toContain('No changes');
    expect(wrote(mock.runs)).toHaveLength(0);
  });

  it('--force-drop without --yes fails non-interactively and drops nothing', async () => {
    const mock = makeDriver({
      ...ALL_IN_SYNC,
      constraints: [
        ...ALL_IN_SYNC.constraints,
        { name: 'Author_email_unique', type: 'UNIQUENESS' },
      ],
    });
    const io = makeIO(mock.driver); // interactive undefined → non-interactive

    await expect(runDbPush(['--force-drop'], io)).rejects.toThrow(/--yes/);
    expect(wrote(mock.runs).filter((c) => c.startsWith('DROP'))).toHaveLength(
      0,
    );
    expect(mock.isClosed()).toBe(true);
  });

  it('--force-drop --yes drops the orphan', async () => {
    const mock = makeDriver({
      ...ALL_IN_SYNC,
      constraints: [
        ...ALL_IN_SYNC.constraints,
        { name: 'Author_email_unique', type: 'UNIQUENESS' },
      ],
    });
    const io = makeIO(mock.driver);

    const code = await runDbPush(['--force-drop', '--yes'], io);

    expect(code).toBe(0);
    expect(mock.runs).toContain(
      'DROP CONSTRAINT Author_email_unique IF EXISTS',
    );
    expect(io.stdout.join('\n')).toContain('✓ dropped Author_email_unique');
  });

  it('--dry-run --force-drop previews the drop Cypher and executes nothing', async () => {
    const mock = makeDriver({
      ...ALL_IN_SYNC,
      constraints: [
        ...ALL_IN_SYNC.constraints,
        { name: 'Author_email_unique', type: 'UNIQUENESS' },
      ],
    });
    const io = makeIO(mock.driver);

    const code = await runDbPush(['--dry-run', '--force-drop'], io);

    expect(code).toBe(0);
    const out = io.stdout.join('\n');
    // dry-run must surface the destructive part of the plan, not hide it.
    expect(out).toContain('DROP CONSTRAINT Author_email_unique IF EXISTS');
    expect(out).toContain('Dry run');
    expect(wrote(mock.runs)).toHaveLength(0);
    expect(mock.isClosed()).toBe(true);
  });

  it('interactive --force-drop: accepting the prompt drops the orphan', async () => {
    const mock = makeDriver({
      ...ALL_IN_SYNC,
      constraints: [
        ...ALL_IN_SYNC.constraints,
        { name: 'Author_email_unique', type: 'UNIQUENESS' },
      ],
    });
    const confirm = jest.fn(async () => true);
    const io = makeIO(mock.driver, { interactive: true, confirm });

    const code = await runDbPush(['--force-drop'], io);

    expect(code).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mock.runs).toContain(
      'DROP CONSTRAINT Author_email_unique IF EXISTS',
    );
  });

  it('interactive --force-drop: declining keeps the orphan but still applies creates', async () => {
    // Live DB is missing Author_id_unique (→ create) and carries an orphan.
    const mock = makeDriver({
      constraints: [
        { name: 'Book_id_unique', type: 'UNIQUENESS' },
        { name: 'Author_email_unique', type: 'UNIQUENESS' }, // orphan
      ],
      indexes: [{ name: 'BookSearch', type: 'FULLTEXT' }],
    });
    const confirm = jest.fn(async () => false);
    const io = makeIO(mock.driver, { interactive: true, confirm });

    const code = await runDbPush(['--force-drop'], io);

    expect(code).toBe(0); // declining is not an error
    // The additive create happened; the orphan drop did not.
    expect(mock.runs).toContain(
      'CREATE CONSTRAINT Author_id_unique IF NOT EXISTS FOR (n:Author) REQUIRE n.id IS UNIQUE',
    );
    expect(mock.runs.filter((c) => c.startsWith('DROP'))).toHaveLength(0);
    expect(io.stdout.join('\n')).toContain('Drop declined');
  });
});
