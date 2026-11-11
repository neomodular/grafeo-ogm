/**
 * v2.28.1 — a where key named `mode` is the field's filter on a type that
 * declares a `mode` field (property, `@cypher` field or relationship), and
 * the case-insensitivity switch only on a type without one. Pre-2.28.1 the
 * key was always skipped, so the filter disappeared (an unfiltered
 * `deleteMany`, a policy `{ mode: … }` compiled to `true`), and the
 * generated where input declared `mode?` twice.
 */
import { permissive, restrictive } from '../src/policy/types';
import { compile, createCompileOnlyOgm } from '../src/testing';
import { typecheckGenerated } from './helpers/generated-typecheck';

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type Tagged @relationshipProperties {
    mode: String
  }
  type Theme @node {
    id: ID! @id @unique
    mode: String
    name: String
    owner: User @relationship(type: "OWNS", direction: IN)
  }
  type User @node {
    id: ID! @id @unique
    name: String
    themes: [Theme!]!
      @relationship(type: "OWNS", direction: OUT, properties: "Tagged")
  }
  type Setting @node {
    id: ID! @id @unique
    mode: Mode @relationship(type: "USES", direction: OUT)
  }
  type Mode @node {
    id: ID! @id @unique
    name: String
  }
  type Score @node {
    id: ID! @id @unique
    mode: Int @cypher(statement: "RETURN 1 AS m", columnName: "m")
  }
`;

describe('where `mode` on a type with a `mode` field (2.28.1)', () => {
  const ogm = createCompileOnlyOgm({ typeDefs });
  const Theme = compile(ogm.model('Theme'));
  const User = compile(ogm.model('User'));

  it('find filters on the property', async () => {
    const q = await Theme.find({ where: { mode: 'dark' } });
    expect(q.cypher).toContain('n.`mode` = $param0');
    expect(q.params.param0).toBe('dark');
  });

  it('`insensitive` is a value of the field, not the switch', async () => {
    const q = await Theme.find({ where: { mode: 'insensitive', name: 'A' } });
    expect(q.cypher).toContain('n.`mode` = $param0');
    expect(q.cypher).toContain('n.`name` = $param1');
    expect(q.cypher).not.toContain('toLower');
  });

  it('deleteMany is filtered', async () => {
    const q = await Theme.deleteMany({ where: { mode: 'dark' } });
    expect(q.cypher).toMatch(/WHERE n\.`mode` = \$param0[\s\S]*DETACH DELETE/);
  });

  it('updateMany is filtered', async () => {
    const q = await Theme.updateMany({
      where: { mode: 'dark' },
      data: { name: 'x' },
    });
    expect(q.cypher).toContain('n.`mode` = $param0');
  });

  it('a `_SOME` filter and an edge where filter on `mode`', async () => {
    const some = await User.find({ where: { themes_SOME: { mode: 'dark' } } });
    expect(some.cypher).toMatch(/\.`mode` = \$param\d/);
    const edge = await User.find({
      where: { themesConnection_SOME: { edge: { mode: 'x' } } },
    });
    expect(edge.cypher).toMatch(/\.`mode` = \$param\d/);
  });

  it('a nested delete where on `mode`', async () => {
    const q = await User.update({
      where: { id: 'u' },
      update: { themes: [{ delete: [{ where: { node: { mode: 'dark' } } }] }] },
    });
    expect(Object.values(q.params)).toContain('dark');
    expect(q.cypher).toMatch(/\.`mode` = \$/);
  });

  it('a relationship and a @cypher field named `mode`', async () => {
    const Setting = compile(ogm.model('Setting'));
    const rel = await Setting.find({ where: { mode: { name: 'm' } } });
    expect(rel.cypher).toContain('-[:`USES`]->(r0:`Mode`) WHERE r0.`name`');
    const Score = compile(ogm.model('Score'));
    const cy = await Score.find({ where: { mode: 1 } });
    expect(cy.cypher).toContain('RETURN 1 AS m');
  });

  it('a policy on `mode` compiles to a predicate', async () => {
    const pol = createCompileOnlyOgm({
      typeDefs,
      policies: {
        Theme: [
          permissive({ operations: ['read'], when: () => ({}) }),
          restrictive({
            operations: ['read'],
            when: () => ({ mode: 'light' }),
          }),
        ],
      },
    });
    const q = await compile(pol.withContext({}).model('Theme')).find({});
    expect(q.cypher).toMatch(/n\.`mode` = \$/);
    expect(Object.values(q.params)).toContain('light');
  });

  it('a type without a `mode` field keeps the switch', async () => {
    const Mode = compile(ogm.model('Mode'));
    const q = await Mode.find({ where: { name: 'A', mode: 'insensitive' } });
    expect(q.cypher).toContain('toLower(n.`name`) = toLower($param0)');
  });
});

describe('generated where input with a `mode` field (2.28.1)', () => {
  let generated = '';
  let errors: string[] = [];

  beforeAll(async () => {
    ({ generated, errors } = await typecheckGenerated(
      typeDefs,
      `
import type { OGM } from 'grafeo-ogm';
import type { ModelMap, InterfaceModelMap } from './generated';
declare const ogm: OGM<ModelMap, InterfaceModelMap>;

async function run() {
  await ogm.model('Theme').find({ where: { mode: 'dark', mode_IN: ['a'] } });
  await ogm.model('Setting').find({ where: { mode: { name: 'm' } } });
  await ogm.model('Score').find({ where: { mode: 1 } });
  await ogm.model('Mode').find({ where: { name: 'a', mode: 'insensitive' } });
  // @ts-expect-error a relationship filter is not the switch
  await ogm.model('Setting').find({ where: { mode: 'insensitive' } });
  // @ts-expect-error an Int field is not the switch
  await ogm.model('Score').find({ where: { mode: 'insensitive' } });
}
void run;
`,
    ));
  });

  it('compiles', () => {
    expect(errors).toEqual([]);
  });

  it('declares `mode` once per where input', () => {
    for (const name of ['Theme', 'Setting', 'Score', 'Tagged', 'Mode']) {
      const start = generated.indexOf(`export type ${name}Where = {`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = generated.slice(start, generated.indexOf('};', start));
      expect(body.match(/^\s*mode\?:/gm)).toHaveLength(1);
    }
    const mode = generated.indexOf('export type ModeWhere = {');
    expect(generated.slice(mode, generated.indexOf('};', mode))).toContain(
      'mode?: "insensitive" | (string & {});',
    );
  });
});
