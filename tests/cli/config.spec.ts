import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadConfigFile,
  resolveConnection,
  resolveOutPath,
  resolveSchemaPath,
} from '../../src/cli/config';
import { CliError } from '../../src/cli/errors';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-cli-'));
}

describe('CLI config — discovery (cli-config spec)', () => {
  it('loads grafeo.config.ts via jiti', async () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, 'grafeo.config.ts'),
      `const config: { schema: string; out: string } = {
         schema: './my-schema.graphql',
         out: './generated.ts',
       };
       export default config;`,
    );

    const { config, filePath } = await loadConfigFile(cwd);
    expect(config.schema).toBe('./my-schema.graphql');
    expect(config.out).toBe('./generated.ts');
    expect(filePath).toBe(path.join(cwd, 'grafeo.config.ts'));
  });

  it('loads grafeo.config.json', async () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, 'grafeo.config.json'),
      JSON.stringify({ schema: './s.graphql' }),
    );

    const { config } = await loadConfigFile(cwd);
    expect(config.schema).toBe('./s.graphql');
  });

  it('prefers .ts over .json when both exist', async () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, 'grafeo.config.ts'),
      `export default { schema: './from-ts.graphql' };`,
    );
    fs.writeFileSync(
      path.join(cwd, 'grafeo.config.json'),
      JSON.stringify({ schema: './from-json.graphql' }),
    );

    const { config } = await loadConfigFile(cwd);
    expect(config.schema).toBe('./from-ts.graphql');
  });

  it('returns empty config when no file exists', async () => {
    const { config, filePath } = await loadConfigFile(tempDir());
    expect(config).toEqual({});
    expect(filePath).toBeUndefined();
  });

  it('throws CliError on malformed JSON', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'grafeo.config.json'), '{ not json');
    await expect(loadConfigFile(cwd)).rejects.toBeInstanceOf(CliError);
  });

  it('throws CliError when the TS config has no object default export', async () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, 'grafeo.config.ts'),
      `export const notDefault = 1;`,
    );
    await expect(loadConfigFile(cwd)).rejects.toThrow(
      /must export a configuration object/,
    );
  });
});

describe('CLI config — schema/out resolution', () => {
  it('flag overrides config (precedence spec)', () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, 'flag.graphql'),
      'type X @node { id: ID! @id }',
    );
    fs.writeFileSync(
      path.join(cwd, 'cfg.graphql'),
      'type Y @node { id: ID! @id }',
    );

    const resolved = resolveSchemaPath(
      { schema: './flag.graphql' },
      { schema: './cfg.graphql' },
      cwd,
    );
    expect(resolved).toBe(path.join(cwd, 'flag.graphql'));
  });

  it('falls back to ./schema.graphql when it exists (zero-config)', () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, 'schema.graphql'),
      'type X @node { id: ID! @id }',
    );
    expect(resolveSchemaPath({}, {}, cwd)).toBe(
      path.join(cwd, 'schema.graphql'),
    );
  });

  it('errors with a config example when nothing resolves (cli-config scenario)', () => {
    const cwd = tempDir();
    expect(() => resolveSchemaPath({}, {}, cwd)).toThrow(/No schema found/);
    expect(() => resolveSchemaPath({}, {}, cwd)).toThrow(/defineConfig/);
  });

  it('errors when a declared schema path does not exist', () => {
    const cwd = tempDir();
    expect(() =>
      resolveSchemaPath({ schema: './missing.graphql' }, {}, cwd),
    ).toThrow(/Schema file not found/);
  });

  it('resolves out path with flag > config > default precedence', () => {
    const cwd = tempDir();
    expect(resolveOutPath({ out: './a.ts' }, { out: './b.ts' }, cwd)).toBe(
      path.join(cwd, 'a.ts'),
    );
    expect(resolveOutPath({}, { out: './b.ts' }, cwd)).toBe(
      path.join(cwd, 'b.ts'),
    );
    expect(resolveOutPath({}, {}, cwd)).toBe(
      path.join(cwd, 'grafeo.generated.ts'),
    );
  });
});

describe('CLI config — connection resolution (cli-config spec)', () => {
  it('resolves entirely from NEO4J_* environment variables', () => {
    const conn = resolveConnection(
      {},
      {},
      {
        NEO4J_URI: 'bolt://localhost:7687',
        NEO4J_USERNAME: 'neo4j',
        NEO4J_PASSWORD: 'secret',
        NEO4J_DATABASE: 'app',
      },
    );
    expect(conn).toEqual({
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'secret',
      database: 'app',
    });
  });

  it('flags and config override env for non-secret settings', () => {
    const conn = resolveConnection(
      { uri: 'bolt://flag:7687' },
      { database: { username: 'cfg-user', password: 'cfg-pass' } },
      { NEO4J_URI: 'bolt://env:7687', NEO4J_USERNAME: 'env-user' },
    );
    expect(conn.uri).toBe('bolt://flag:7687');
    expect(conn.username).toBe('cfg-user');
    expect(conn.password).toBe('cfg-pass');
  });

  it('lists every missing setting in one error', () => {
    expect(() => resolveConnection({}, {}, {})).toThrow(
      /uri[\s\S]*username[\s\S]*password/,
    );
  });

  it('password guidance never suggests a flag', () => {
    try {
      resolveConnection({}, {}, {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('never a flag');
      expect((e as Error).message).not.toContain('--password');
    }
  });

  it('database is optional', () => {
    const conn = resolveConnection(
      {},
      {},
      {
        NEO4J_URI: 'bolt://x:7687',
        NEO4J_USERNAME: 'u',
        NEO4J_PASSWORD: 'p',
      },
    );
    expect(conn.database).toBeUndefined();
  });
});
