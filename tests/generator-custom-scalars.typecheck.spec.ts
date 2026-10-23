/**
 * v2.12.6 — a schema that declares a custom scalar (`scalar JSON`) and uses
 * it on a field generated a file that did not compile: the where inputs
 * referenced `Scalars["JSON"]`, which had no entry (TS2339), and the node
 * and write inputs referenced a bare `JSON` / `Email` the file never
 * declares (TS2304 — or, for `JSON`, silently the global `JSON` object).
 *
 * Custom scalars now get a `Scalars` entry typed `{ input: any; output: any }`
 * (graphql-codegen's default, which @neo4j/graphql-ogm emitted), and their
 * where inputs offer equality, `_NOT`, `_IN` and `_NOT_IN` only — the
 * operators that hold for any value. These cases compile the generated file
 * and real user code against it.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateTypes } from '../src/generator';
import { parseSchema } from '../src/schema/parser';
import { WhereCompiler } from '../src/compilers/where.compiler';
import { typecheckGenerated } from './helpers/generated-typecheck';

jest.setTimeout(60_000);

const PRELUDE = `
import type { OGM } from 'grafeo-ogm';
import type { ModelMap, InterfaceModelMap } from './generated';
import * as G from './generated';
declare const ogm: OGM<ModelMap, InterfaceModelMap>;
type Expect<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
`;

const typeDefs = /* GraphQL */ `
  scalar JSON
  "An e-mail address"
  scalar Email
  scalar DateTime

  interface Contact {
    email: Email!
  }

  type Person implements Contact @node {
    id: ID! @id
    email: Email!
    data: JSON
    tags: [JSON!]
    seen: DateTime
    meta: JSON
      @cypher(statement: "RETURN this.data AS meta", columnName: "meta")
    knows: [Person!]!
      @relationship(type: "KNOWS", direction: OUT, properties: "Knows")
  }

  type Knows @relationshipProperties {
    note: JSON
  }
`;

describe('custom scalars in the generated types', () => {
  it('compiles, and create / update / where / select on the fields type-check', async () => {
    const { generated, errors } = await typecheckGenerated(
      typeDefs,
      `${PRELUDE}
async function run() {
  const People = ogm.model('Person');
  await People.create({
    input: [
      {
        email: 'a@b.c',
        data: { any: 'value' },
        tags: [1, 'two'],
        knows: { create: [{ node: { email: 'x@y.z' }, edge: { note: 'hi' } }] },
      },
    ],
  });
  await People.update({
    where: { email: 'a@b.c' },
    update: { data: null, tags: [], email: 'd@e.f' },
  });
  const rows = await People.find({
    where: {
      email: 'a@b.c',
      email_NOT: 'x',
      email_IN: ['a@b.c'],
      email_NOT_IN: ['x'],
      data_IN: [null, 1],
      tags: ['a'],
      tags_IN: [['a']],
      meta: 'm',
      knowsConnection_SOME: { edge: { note: 'hi' } },
    },
    select: { email: true, data: true, tags: true, meta: true },
  });
  type _email = Expect<IsAny<typeof rows[0]['email']>>;
  const p: G.Person = rows[0] as unknown as G.Person;
  type _data = Expect<IsAny<NonNullable<G.Person['data']>>>;
  const c: G.Contact = { email: 'a@b.c' };
  const k: G.KnowsCreateInput = { note: [1, 2] };
  // Custom scalars are opaque: string / comparison operators are not offered.
  // @ts-expect-error -- no _CONTAINS on a custom scalar
  const w1: G.PersonWhere = { email_CONTAINS: 'b' };
  // @ts-expect-error -- no _GT on a custom scalar
  const w2: G.PersonWhere = { data_GT: 1 };
  return [p, c, k, w1, w2];
}
`,
    );
    expect(errors).toEqual([]);
    expect(generated).toContain('  JSON: { input: any; output: any };');
    expect(generated).toContain('  Email: { input: any; output: any };');
    // A redeclared built-in keeps its built-in entry, once.
    expect(generated.match(/^ {2}DateTime: /gm)).toHaveLength(1);
    expect(generated).toContain('seen?: Maybe<Scalars["DateTime"]["output"]>;');
  });

  it('offers only operators the runtime WhereCompiler compiles', () => {
    const schema = parseSchema(typeDefs);
    const person = schema.nodes.get('Person')!;
    const compiler = new WhereCompiler(schema);
    const { cypher } = compiler.compile(
      {
        email: 'a',
        email_NOT: 'b',
        email_IN: ['a'],
        email_NOT_IN: ['b'],
      },
      'n',
      person,
    );
    expect(cypher).toBe(
      'n.`email` = $param0 AND n.`email` <> $param1 AND ' +
        'n.`email` IN $param2 AND NOT n.`email` IN $param3',
    );
  });

  it('a redeclared built-in scalar (`scalar DateTime`) changes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-scalars-'));
    try {
      const gen = async (sdl: string) => {
        const outFile = path.join(dir, 'out.ts');
        await generateTypes({
          typeDefs: sdl,
          outFile,
          config: { formatOutput: false },
        });
        return fs.readFileSync(outFile, 'utf-8');
      };
      const base = `type Event @node { id: ID! @id at: DateTime! n: BigInt }`;
      expect(await gen(`scalar DateTime\nscalar BigInt\n${base}`)).toBe(
        await gen(base),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('schemas without custom scalars generate byte-identical output', () => {
  // Runs the generator in a child process: prettier (an ESM dynamic import)
  // does not load inside Jest's CJS runtime, and the committed file is
  // prettier-formatted, as `pnpm run verify:examples` writes it.
  it('examples/schema.graphql regenerates examples/grafeo.generated.ts exactly', () => {
    const root = path.resolve(__dirname, '..');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-scalars-'));
    try {
      const outFile = path.join(dir, 'grafeo.generated.ts');
      const script =
        `require('./src/generator').generateTypes({` +
        `typeDefs: require('fs').readFileSync('examples/schema.graphql', 'utf-8'),` +
        `outFile: ${JSON.stringify(outFile)},` +
        `}).then((r) => { if (r.warnings.length) ` +
        `throw new Error(JSON.stringify(r.warnings)); })`;
      execFileSync(
        process.execPath,
        ['-r', 'ts-node/register/transpile-only', '-e', script],
        { cwd: root, stdio: 'pipe' },
      );
      expect(fs.readFileSync(outFile, 'utf-8')).toBe(
        fs.readFileSync(
          path.join(root, 'examples', 'grafeo.generated.ts'),
          'utf-8',
        ),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
