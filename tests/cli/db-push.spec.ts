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
    {
      name: 'Book_id_unique',
      type: 'UNIQUENESS',
      labelsOrTypes: ['Book'],
      properties: ['id'],
    },
    {
      name: 'Author_id_unique',
      type: 'UNIQUENESS',
      labelsOrTypes: ['Author'],
      properties: ['id'],
    },
  ],
  indexes: [{ name: 'BookSearch', type: 'FULLTEXT' }],
};

function record(obj: Record<string, unknown>) {
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
      if (cypher.startsWith('SHOW INDEXES'))
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
        {
          name: 'Author_email_unique',
          type: 'UNIQUENESS',
          labelsOrTypes: ['Author'],
          properties: ['email'],
        },
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
        {
          name: 'Author_email_unique',
          type: 'UNIQUENESS',
          labelsOrTypes: ['Author'],
          properties: ['email'],
        },
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
        {
          name: 'Author_email_unique',
          type: 'UNIQUENESS',
          labelsOrTypes: ['Author'],
          properties: ['email'],
        },
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
        {
          name: 'Author_email_unique',
          type: 'UNIQUENESS',
          labelsOrTypes: ['Author'],
          properties: ['email'],
        },
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
        {
          name: 'Author_email_unique',
          type: 'UNIQUENESS',
          labelsOrTypes: ['Author'],
          properties: ['email'],
        },
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
        {
          name: 'Book_id_unique',
          type: 'UNIQUENESS',
          labelsOrTypes: ['Book'],
          properties: ['id'],
        },
        {
          name: 'Author_email_unique',
          type: 'UNIQUENESS',
          labelsOrTypes: ['Author'],
          properties: ['email'],
        }, // orphan
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

  // v2.4.8 — a changed index definition used to print "No changes".
  describe('changed index definitions', () => {
    const CHANGED: LiveSchema = {
      constraints: ALL_IN_SYNC.constraints,
      indexes: [
        {
          name: 'BookSearch',
          type: 'FULLTEXT',
          entityType: 'NODE',
          labelsOrTypes: ['Book'],
          properties: ['title', 'body'],
        },
      ],
    };

    it('warns that the schema is NOT in sync and leaves it without --force-drop', async () => {
      const mock = makeDriver(CHANGED);
      const io = makeIO(mock.driver);

      expect(await runDbPush([], io)).toBe(0);

      const out = io.stdout.join('\n');
      expect(out).not.toContain('No changes');
      expect(out).toContain('BookSearch');
      expect(out).toMatch(/NOT in sync/);
      expect(out).toContain('--force-drop');
      expect(wrote(mock.runs)).toHaveLength(0);
    });

    it('--force-drop --yes drops and recreates it', async () => {
      const mock = makeDriver(CHANGED);
      const io = makeIO(mock.driver);

      expect(await runDbPush(['--force-drop', '--yes'], io)).toBe(0);

      expect(wrote(mock.runs)).toEqual([
        'DROP INDEX BookSearch IF EXISTS',
        'CREATE FULLTEXT INDEX BookSearch IF NOT EXISTS FOR (n:Book) ON EACH [n.title]',
      ]);
      expect(io.stdout.join('\n')).toContain('✓ recreated BookSearch');
    });

    it('--force-drop without --yes fails non-interactively and changes nothing', async () => {
      const mock = makeDriver(CHANGED);
      const io = makeIO(mock.driver);

      await expect(runDbPush(['--force-drop'], io)).rejects.toThrow(/--yes/);
      expect(wrote(mock.runs)).toHaveLength(0);
    });

    it('--dry-run --force-drop previews the drop and the create', async () => {
      const mock = makeDriver(CHANGED);
      const io = makeIO(mock.driver);

      expect(await runDbPush(['--dry-run', '--force-drop'], io)).toBe(0);
      const out = io.stdout.join('\n');
      expect(out).toContain('DROP INDEX BookSearch IF EXISTS');
      expect(out).toContain('CREATE FULLTEXT INDEX BookSearch');
      expect(wrote(mock.runs)).toHaveLength(0);
    });

    it('interactive decline keeps the old definition', async () => {
      const mock = makeDriver(CHANGED);
      const io = makeIO(mock.driver, {
        interactive: true,
        confirm: async () => false,
      });

      expect(await runDbPush(['--force-drop'], io)).toBe(0);
      expect(wrote(mock.runs)).toHaveLength(0);
    });
  });

  // v2.4.8 — "created X" was printed for every CREATE that ran, even when
  // Neo4j created nothing; a blocking RANGE index crashed the push.
  describe('create outcomes', () => {
    function driverWith(
      live: LiveSchema,
      onCreate: (cypher: string) => unknown,
    ): MockDriver {
      const mock = makeDriver(live);
      const session = (mock.driver.session as jest.Mock)();
      const base = session.run.getMockImplementation();
      session.run.mockImplementation(async (cypher: string) => {
        if (cypher.startsWith('CREATE')) {
          mock.runs.push(cypher);
          return onCreate(cypher);
        }
        return base(cypher);
      });
      return mock;
    }
    const counters = (added: number) => ({
      records: [],
      summary: {
        counters: {
          updates: () => ({ constraintsAdded: added, indexesAdded: 0 }),
        },
      },
    });
    const ONLY_AUTHOR: LiveSchema = {
      constraints: [ALL_IN_SYNC.constraints[1]],
      indexes: ALL_IN_SYNC.indexes,
    };

    it('does not claim "created" when Neo4j reports nothing was added', async () => {
      const mock = driverWith(ONLY_AUTHOR, () => counters(0));
      const io = makeIO(mock.driver);

      expect(await runDbPush([], io)).toBe(0);
      const out = io.stdout.join('\n');
      expect(out).not.toContain('✓ created Book_id_unique');
      expect(out).toMatch(/Book_id_unique.*already/);
    });

    it('still says "created" when Neo4j reports the constraint was added', async () => {
      const mock = driverWith(ONLY_AUTHOR, () => counters(1));
      const io = makeIO(mock.driver);

      expect(await runDbPush([], io)).toBe(0);
      expect(io.stdout.join('\n')).toContain('✓ created Book_id_unique');
    });

    it('reports an equivalent constraint under another name as covering it, and runs no CREATE', async () => {
      const mock = makeDriver({
        constraints: [
          {
            name: 'sx_dba_book_id',
            type: 'UNIQUENESS',
            labelsOrTypes: ['Book'],
            properties: ['id'],
          },
          ALL_IN_SYNC.constraints[1],
        ],
        indexes: ALL_IN_SYNC.indexes,
      });
      const io = makeIO(mock.driver);

      expect(await runDbPush([], io)).toBe(0);
      expect(io.stdout.join('\n')).toContain(
        'Book_id_unique covered by sx_dba_book_id',
      );
      expect(wrote(mock.runs)).toEqual([]);
    });

    it('reports a "schema rule already exists" failure instead of crashing', async () => {
      const mock = driverWith(
        { constraints: [], indexes: [] },
        (cypher: string) => {
          if (cypher.includes('Book_id_unique'))
            throw Object.assign(
              new Error('There already exists an index (:Book {id}).'),
              {
                code: 'Neo.ClientError.Schema.IndexAlreadyExists',
              },
            );
          return counters(1);
        },
      );
      const io = makeIO(mock.driver);

      expect(await runDbPush([], io)).toBe(0);
      expect(io.stderr.join('\n')).toMatch(/Book_id_unique/);
      // The rest of the plan still applied.
      expect(io.stdout.join('\n')).toContain('✓ created Author_id_unique');
    });

    it('still fails on any other error', async () => {
      const mock = driverWith({ constraints: [], indexes: [] }, () => {
        throw Object.assign(new Error('boom'), {
          code: 'Neo.ClientError.Security.Forbidden',
        });
      });
      await expect(runDbPush([], makeIO(mock.driver))).rejects.toThrow('boom');
    });
  });
});

// v2.11.0 — strict item 23: `strict: true` (config or --strict) plans the
// constraints of a type with custom `@node(labels)` on labels[0], as an
// OGM built with `strict: true` (and @neo4j/graphql) uses them.
describe('grafeo db push — @node(labels) and strict (item 23)', () => {
  const LABELLED = `
type Person @node(labels: ["Human", "Entity"]) {
  id: ID! @id @unique
}
type Toy @node {
  id: ID! @id @unique
}
`;
  const labelledIO = (driver: Driver, config?: Record<string, unknown>) => {
    const io = makeIO(driver);
    fs.writeFileSync(path.join(io.cwd, 'schema.graphql'), LABELLED);
    if (config)
      fs.writeFileSync(
        path.join(io.cwd, 'grafeo.config.json'),
        JSON.stringify(config),
      );
    return io;
  };

  it('default: constraints on the type name (unchanged) and a warning', async () => {
    const mock = makeDriver({ constraints: [], indexes: [] });
    const io = labelledIO(mock.driver);
    expect(await runDbPush(['--dry-run'], io)).toBe(0);
    const out = io.stdout.join('\n');
    expect(out).toContain(
      'CREATE CONSTRAINT Person_id_unique IF NOT EXISTS FOR (n:Person) REQUIRE n.id IS UNIQUE',
    );
    expect(out).not.toContain('Human_id_unique');
    const err = io.stderr.join('\n');
    expect(err).toContain(
      'warning: Person has @node(labels: ["Human", "Entity"])',
    );
    expect(err).toContain('uses :Human');
    expect(err).not.toContain('Toy');
  });

  it.each([
    ['--strict', ['--strict'], undefined],
    ['strict: true in grafeo.config', [], { strict: true }],
  ])('%s: constraints on labels[0], no warning', async (_n, flags, config) => {
    const mock = makeDriver({ constraints: [], indexes: [] });
    const io = labelledIO(mock.driver, config);
    expect(await runDbPush(['--dry-run', ...flags], io)).toBe(0);
    const out = io.stdout.join('\n');
    expect(out).toContain(
      'CREATE CONSTRAINT Human_id_unique IF NOT EXISTS FOR (n:Human) REQUIRE n.id IS UNIQUE',
    );
    expect(out).toContain('CREATE CONSTRAINT Toy_id_unique');
    expect(out).not.toContain('(n:Person)');
    expect(io.stderr.join('\n')).not.toContain('@node(labels');
  });

  it('strict: the 2.x constraint on the type name is a grafeo orphan, dropped only with --force-drop', async () => {
    const live: LiveSchema = {
      constraints: [
        {
          name: 'Person_id_unique',
          type: 'UNIQUENESS',
          labelsOrTypes: ['Person'],
          properties: ['id'],
        },
      ],
      indexes: [],
    };
    const kept = makeDriver(live);
    const io = labelledIO(kept.driver);
    expect(await runDbPush(['--dry-run', '--strict'], io)).toBe(0);
    expect(io.stdout.join('\n')).toContain('kept');
    expect(io.stdout.join('\n')).not.toMatch(/Unmanaged/);

    const dropped = makeDriver(live);
    expect(
      await runDbPush(
        ['--strict', '--force-drop', '--yes'],
        labelledIO(dropped.driver),
      ),
    ).toBe(0);
    expect(dropped.runs).toContain(
      'DROP CONSTRAINT Person_id_unique IF EXISTS',
    );
  });
});

// vNEXT — S5t-5: `indexName` (the @neo4j/graphql 4+ spelling) plans the
// fulltext index; pre-vNEXT it was ignored and no index was made.
describe('grafeo db push — @fulltext indexName', () => {
  it('plans a fulltext index declared with indexName', async () => {
    const mock = makeDriver({ constraints: [], indexes: [] });
    const io = makeIO(mock.driver);
    fs.writeFileSync(
      path.join(io.cwd, 'schema.graphql'),
      `type Product @node @fulltext(indexes: [{ indexName: "ProductName", fields: ["name"] }]) { name: String }`,
    );
    expect(await runDbPush(['--dry-run'], io)).toBe(0);
    expect(io.stdout.join('\n')).toMatch(
      /CREATE FULLTEXT INDEX ProductName IF NOT EXISTS/,
    );
  });
});
