import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

import { generateTypes } from '../../src/generator';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

export interface TypecheckResult {
  /** Generated types source, for text assertions. */
  generated: string;
  /** Formatted diagnostics for the generated file and the usage file. */
  errors: string[];
}

/**
 * Generate types for `typeDefs`, write `usage` next to them (it imports from
 * `./generated`), and run a full semantic type-check with `grafeo-ogm`
 * resolved to this repo's `src/`. Text-only emitter assertions can't prove a
 * type-level fix — this compiles real user code against the real output.
 */
export async function typecheckGenerated(
  typeDefs: string,
  usage: string,
): Promise<TypecheckResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grafeo-typecheck-'));
  try {
    const generatedFile = path.join(dir, 'generated.ts');
    const usageFile = path.join(dir, 'usage.ts');
    await generateTypes({
      typeDefs,
      outFile: generatedFile,
      config: { formatOutput: false },
    });
    fs.writeFileSync(usageFile, usage, 'utf-8');

    const program = ts.createProgram([generatedFile, usageFile], {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      types: ['node'],
      typeRoots: [path.join(REPO_ROOT, 'node_modules', '@types')],
      baseUrl: dir,
      paths: {
        'grafeo-ogm': [path.join(REPO_ROOT, 'src', 'index.ts')],
        // The scratch dir lives outside the repo; resolve bare imports
        // (graphql, neo4j-driver) from the repo's node_modules.
        '*': [path.join(REPO_ROOT, 'node_modules', '*')],
      },
    });

    const errors: string[] = [];
    for (const file of [generatedFile, usageFile]) {
      const sf = program.getSourceFile(file);
      const diags = [
        ...program.getSyntacticDiagnostics(sf),
        ...program.getSemanticDiagnostics(sf),
      ];
      for (const d of diags) {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        const where =
          d.file && d.start !== undefined
            ? `${path.basename(d.file.fileName)}:${
                d.file.getLineAndCharacterOfPosition(d.start).line + 1
              }`
            : '?';
        errors.push(`${where} TS${d.code}: ${msg}`);
      }
    }

    return { generated: fs.readFileSync(generatedFile, 'utf-8'), errors };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
