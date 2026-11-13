#!/usr/bin/env node
// Type-check every ```ts / ```typescript block of README.md and llms-full.txt
// against src/ and against types generated from scripts/docs/examples/schema.graphql
// by this repo's own generator.
//
//   node scripts/docs/typecheck-examples.mjs [file.md ...]
//
// Each block becomes its own module. A block that uses a name it does not
// declare (`ogm`, `driver`, `Book`, `BookWhere`, `SortDirection`, ...) gets
// that name imported from scripts/docs/examples/prelude.ts, so short fragments
// compile without repeating the setup. `./grafeo.generated` resolves to the
// generated types and `grafeo-ogm` / `grafeo-ogm/testing` to src/.
//
// Opt-out: put `<!-- typecheck: skip — reason -->` on the line before the
// fence. The reason is required. Keep skips rare: pseudo-code and partial
// fragments only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { createJiti } = require('jiti');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXAMPLES = path.join(HERE, 'examples');
const DEFAULT_FILES = ['README.md', 'llms-full.txt'];

const FENCE_OPEN = /^```(ts|typescript)\s*$/;
const MARKER = /^<!--\s*typecheck:\s*(.*?)\s*-->\s*$/;

function extractBlocks(file) {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf-8').split('\n');
  const blocks = [];
  const problems = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('```')) continue;
    const isTs = FENCE_OPEN.test(line);
    const start = i;
    let end = i + 1;
    while (end < lines.length && !/^```\s*$/.test(lines[end])) end++;
    if (end >= lines.length) {
      problems.push(`${file}:${start + 1}: unterminated code fence`);
      break;
    }
    i = end;
    if (!isTs) continue;

    let skip = null;
    const prev = start > 0 ? lines[start - 1] : '';
    const marker = MARKER.exec(prev);
    if (marker) {
      const m = /^skip\b\s*(?:[—–:-]\s*)?(.*)$/.exec(marker[1]);
      if (!m) {
        problems.push(
          `${file}:${start}: unknown typecheck marker "${marker[1]}"`,
        );
      } else if (!m[1].trim()) {
        problems.push(`${file}:${start}: "typecheck: skip" needs a reason`);
      } else {
        skip = m[1].trim();
      }
    }
    blocks.push({
      file,
      fenceLine: start + 1, // 1-based line of the opening fence
      body: lines.slice(start + 1, end).join('\n'),
      skip,
    });
  }
  return { blocks, problems };
}

/** Top-level names a block declares, and every identifier it mentions. */
function scanNames(body) {
  const sf = ts.createSourceFile(
    'block.ts',
    body,
    ts.ScriptTarget.Latest,
    true,
  );
  const declared = new Set();
  const used = new Set();
  const addBinding = (name) => {
    if (!name) return;
    if (ts.isIdentifier(name)) declared.add(name.text);
    else
      for (const el of name.elements)
        if (!ts.isOmittedExpression(el)) addBinding(el.name);
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause) {
      const c = st.importClause;
      if (c.name) declared.add(c.name.text);
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) declared.add(nb.name.text);
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements) declared.add(el.name.text);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) addBinding(d.name);
    } else if (
      (ts.isFunctionDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEnumDeclaration(st)) &&
      st.name
    ) {
      declared.add(st.name.text);
    }
  }
  const visit = (node) => {
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const isModule = sf.statements.some(
    (st) =>
      ts.isImportDeclaration(st) ||
      ts.isExportDeclaration(st) ||
      ts.isExportAssignment(st),
  );
  return { declared, used, isModule };
}

async function main() {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : DEFAULT_FILES;

  const all = [];
  const problems = [];
  for (const f of files) {
    const r = extractBlocks(f);
    all.push(...r.blocks);
    problems.push(...r.problems);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-docs-typecheck-'));
  try {
    // Generate types for the docs schema with this repo's generator (from src/).
    const jiti = createJiti(import.meta.url);
    const { generateTypes } = await jiti.import(
      path.join(ROOT, 'src', 'generator', 'index.ts'),
    );
    const generatedFile = path.join(dir, 'grafeo.generated.ts');
    await generateTypes({
      typeDefs: fs.readFileSync(path.join(EXAMPLES, 'schema.graphql'), 'utf-8'),
      outFile: generatedFile,
      config: { formatOutput: false },
    });
    fs.copyFileSync(
      path.join(EXAMPLES, 'prelude.ts'),
      path.join(dir, 'prelude.ts'),
    );
    fs.copyFileSync(
      path.join(EXAMPLES, 'schema.graphql'),
      path.join(dir, 'schema.graphql'),
    );
    // llms-full.txt imports its shared setup as './setup'.
    fs.writeFileSync(
      path.join(dir, 'setup.ts'),
      "export * from './prelude';\n",
    );
    // The README's "Type Generation" section writes to ./src/generated/ogm-types.ts
    // and imports it as './generated/ogm-types'.
    fs.mkdirSync(path.join(dir, 'generated'));
    fs.writeFileSync(
      path.join(dir, 'generated', 'ogm-types.ts'),
      "export * from '../grafeo.generated';\n",
    );

    // Names the prelude offers: read its export list from the checker.
    const preludeProgram = ts.createProgram(
      [path.join(dir, 'prelude.ts')],
      compilerOptions(dir),
    );
    const checker = preludeProgram.getTypeChecker();
    const preludeSym = checker.getSymbolAtLocation(
      preludeProgram.getSourceFile(path.join(dir, 'prelude.ts')),
    );
    const preludeNames = new Set(
      checker.getExportsOfModule(preludeSym).map((s) => s.name),
    );

    const checked = all.filter((b) => !b.skip);
    const entries = [];
    checked.forEach((b, i) => {
      const { declared, used, isModule } = scanNames(b.body);
      const wanted = [...preludeNames]
        .filter((n) => used.has(n) && !declared.has(n))
        .sort();
      const header = wanted.length
        ? `import { ${wanted.join(', ')} } from './prelude';\n`
        : '';
      const footer = isModule || header ? '' : '\nexport {};\n';
      const name = `${path.basename(b.file).replace(/\W/g, '_')}_L${b.fenceLine}_${i}.ts`;
      const fileName = path.join(dir, name);
      fs.writeFileSync(fileName, header + b.body + '\n' + footer);
      entries.push({ block: b, fileName, offset: header ? 1 : 0 });
    });

    const program = ts.createProgram(
      entries.map((e) => e.fileName),
      compilerOptions(dir),
    );
    const errors = [];
    const report = (d, where) => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n  ');
      errors.push(`${where}: TS${d.code}: ${msg}`);
    };
    for (const e of entries) {
      const sf = program.getSourceFile(e.fileName);
      const diags = [
        ...program.getSyntacticDiagnostics(sf),
        ...program.getSemanticDiagnostics(sf),
      ];
      for (const d of diags) {
        let where = `${e.block.file}:${e.block.fenceLine}`;
        if (d.file && d.start !== undefined && d.file.fileName === e.fileName) {
          const lc = d.file.getLineAndCharacterOfPosition(d.start);
          const blockLine = lc.line - e.offset;
          where =
            blockLine >= 0
              ? `${e.block.file}:${e.block.fenceLine + 1 + blockLine}:${lc.character + 1}`
              : `${e.block.file}:${e.block.fenceLine} (prelude import)`;
        }
        report(d, where);
      }
    }
    // The prelude and generated file must compile too.
    for (const f of ['prelude.ts', 'grafeo.generated.ts']) {
      const sf = program.getSourceFile(path.join(dir, f));
      if (!sf) continue;
      for (const d of [
        ...program.getSyntacticDiagnostics(sf),
        ...program.getSemanticDiagnostics(sf),
      ]) {
        const lc = sf.getLineAndCharacterOfPosition(d.start ?? 0);
        report(d, `scripts/docs/examples/${f}:${lc.line + 1}`);
      }
    }

    const skipped = all.filter((b) => b.skip);
    for (const f of files) {
      const n = all.filter((b) => b.file === f);
      const s = n.filter((b) => b.skip).length;
      console.log(`${f}: ${n.length - s} blocks checked, ${s} skipped`);
    }
    for (const b of skipped)
      console.log(`  skip ${b.file}:${b.fenceLine} — ${b.skip}`);

    const failures = [...problems, ...errors];
    if (failures.length) {
      console.error(`\n${failures.length} problem(s):\n`);
      for (const f of failures) console.error(f);
      process.exitCode = 1;
    } else {
      console.log('\nAll checked blocks compile.');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function compilerOptions(dir) {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022, // top-level await
    moduleResolution: ts.ModuleResolutionKind.Node10,
    lib: ['lib.es2022.d.ts'],
    strict: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['node', 'jest'], // README testing examples use expect()
    typeRoots: [path.join(ROOT, 'node_modules', '@types')],
    baseUrl: dir,
    paths: {
      'grafeo-ogm': [path.join(ROOT, 'src', 'index.ts')],
      'grafeo-ogm/testing': [path.join(ROOT, 'src', 'testing', 'index.ts')],
      // The temp dir is outside the repo: resolve bare imports
      // (neo4j-driver, graphql) from the repo's node_modules.
      '*': [path.join(ROOT, 'node_modules', '*')],
    },
  };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
