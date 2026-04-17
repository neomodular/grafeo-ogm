import { emitVectorTypes } from '../../src/generator/type-emitters/vector-emitter';
import type {
  SchemaMetadata,
  NodeDefinition,
  PropertyDefinition,
  VectorIndex,
} from '../../src/schema/types';

function makeProp(
  name: string,
  type = 'String',
  required = false,
): PropertyDefinition {
  return {
    name,
    type,
    required,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher: false,
    directives: [],
  };
}

function makeNodeDef(
  typeName: string,
  vectorIndexes: VectorIndex[] | undefined = undefined,
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [typeName],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map([['id', makeProp('id', 'ID', true)]]),
    relationships: new Map(),
    fulltextIndexes: [],
    vectorIndexes,
    implementsInterfaces: [],
  };
}

function makeSchema(nodes: Map<string, NodeDefinition>): SchemaMetadata {
  return {
    nodes,
    interfaces: new Map(),
    relationshipProperties: new Map(),
    enums: new Map(),
    unions: new Map(),
  };
}

describe('emitVectorTypes', () => {
  it('returns empty string when schema has no vector indexes anywhere', () => {
    const schema = makeSchema(
      new Map([
        ['Article', makeNodeDef('Article')],
        ['Author', makeNodeDef('Author', [])],
      ]),
    );

    expect(emitVectorTypes(schema)).toBe('');
  });

  it('emits result + vector-input (no phrase-input) for a node with one index without provider', () => {
    const schema = makeSchema(
      new Map([
        [
          'Article',
          makeNodeDef('Article', [
            {
              indexName: 'article_content_idx',
              queryName: 'similarArticles',
              embeddingProperty: 'embedding',
            },
          ]),
        ],
      ]),
    );

    const output = emitVectorTypes(schema);

    expect(output).toContain('export type ArticleVectorResult');
    expect(output).toContain('node: Article;');
    expect(output).toContain('score: number;');

    expect(output).toContain('export type ArticleVectorSearchByVectorInput');
    expect(output).toContain("indexName: 'article_content_idx';");
    expect(output).toContain('vector: number[];');
    expect(output).toContain('k: number;');
    expect(output).toContain('where?: ArticleWhere;');
    expect(output).toContain('selectionSet?: string;');
    expect(output).toContain('labels?: string[];');

    expect(output).not.toContain('ArticleVectorSearchByPhraseInput');
  });

  it('emits all four types for a node with one index with provider set', () => {
    const schema = makeSchema(
      new Map([
        [
          'Article',
          makeNodeDef('Article', [
            {
              indexName: 'article_content_idx',
              queryName: 'similarArticles',
              embeddingProperty: 'embedding',
              provider: 'OpenAI',
            },
          ]),
        ],
      ]),
    );

    const output = emitVectorTypes(schema);

    expect(output).toContain('export type ArticleVectorResult');
    expect(output).toContain('export type ArticleVectorSearchByVectorInput');
    expect(output).toContain('export type ArticleVectorSearchByPhraseInput');

    expect(output).toContain('phrase: string;');
    expect(output).toContain('providerConfig?: Record<string, unknown>;');
    expect(output).toContain('where?: ArticleWhere;');
  });

  it('literal union for indexName lists all defined index names on SearchByVectorInput', () => {
    const schema = makeSchema(
      new Map([
        [
          'Article',
          makeNodeDef('Article', [
            {
              indexName: 'article_content_idx',
              queryName: 'similarArticles',
              embeddingProperty: 'embedding',
            },
            {
              indexName: 'article_summary_idx',
              queryName: 'similarSummaries',
              embeddingProperty: 'summaryEmbedding',
            },
          ]),
        ],
      ]),
    );

    const output = emitVectorTypes(schema);

    // The SearchByVectorInput union should include both indexes.
    const vectorInputMatch = output.match(
      /ArticleVectorSearchByVectorInput[\s\S]*?indexName: ([^;]+);/,
    );
    expect(vectorInputMatch).not.toBeNull();
    const vectorUnion = vectorInputMatch?.[1];
    expect(vectorUnion).toContain("'article_content_idx'");
    expect(vectorUnion).toContain("'article_summary_idx'");
    expect(vectorUnion).toContain(' | ');
  });

  it("SearchByPhraseInput's indexName union only includes indexes with provider set", () => {
    const schema = makeSchema(
      new Map([
        [
          'Article',
          makeNodeDef('Article', [
            {
              indexName: 'article_content_idx',
              queryName: 'similarArticles',
              embeddingProperty: 'embedding',
              provider: 'OpenAI',
            },
            {
              indexName: 'article_summary_idx',
              queryName: 'similarSummaries',
              embeddingProperty: 'summaryEmbedding',
            },
            {
              indexName: 'article_title_idx',
              queryName: 'similarTitles',
              embeddingProperty: 'titleEmbedding',
              provider: 'VertexAI',
            },
          ]),
        ],
      ]),
    );

    const output = emitVectorTypes(schema);

    const phraseInputMatch = output.match(
      /ArticleVectorSearchByPhraseInput[\s\S]*?indexName: ([^;]+);/,
    );
    expect(phraseInputMatch).not.toBeNull();
    const phraseUnion = phraseInputMatch?.[1] ?? '';
    expect(phraseUnion).toContain("'article_content_idx'");
    expect(phraseUnion).toContain("'article_title_idx'");
    expect(phraseUnion).not.toContain("'article_summary_idx'");

    // The SearchByVectorInput union should still include ALL three indexes.
    const vectorInputMatch = output.match(
      /ArticleVectorSearchByVectorInput[\s\S]*?indexName: ([^;]+);/,
    );
    const vectorUnion = vectorInputMatch?.[1] ?? '';
    expect(vectorUnion).toContain("'article_content_idx'");
    expect(vectorUnion).toContain("'article_summary_idx'");
    expect(vectorUnion).toContain("'article_title_idx'");
  });

  it('emits blocks for each node that has indexes and skips nodes without', () => {
    const schema = makeSchema(
      new Map([
        [
          'Zebra',
          makeNodeDef('Zebra', [
            {
              indexName: 'zebra_idx',
              queryName: 'similarZebras',
              embeddingProperty: 'embedding',
            },
          ]),
        ],
        ['Beta', makeNodeDef('Beta')],
        [
          'Alpha',
          makeNodeDef('Alpha', [
            {
              indexName: 'alpha_idx',
              queryName: 'similarAlphas',
              embeddingProperty: 'embedding',
              provider: 'OpenAI',
            },
          ]),
        ],
      ]),
    );

    const output = emitVectorTypes(schema);

    expect(output).toContain('AlphaVectorResult');
    expect(output).toContain('AlphaVectorSearchByVectorInput');
    expect(output).toContain('AlphaVectorSearchByPhraseInput');

    expect(output).toContain('ZebraVectorResult');
    expect(output).toContain('ZebraVectorSearchByVectorInput');
    expect(output).not.toContain('ZebraVectorSearchByPhraseInput');

    expect(output).not.toContain('BetaVectorResult');
    expect(output).not.toContain('BetaVectorSearchByVectorInput');

    // Alphabetical ordering: Alpha should appear before Zebra.
    const alphaIdx = output.indexOf('AlphaVectorResult');
    const zebraIdx = output.indexOf('ZebraVectorResult');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(zebraIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(zebraIdx);
  });

  it('emits valid TypeScript that parses without syntax errors', () => {
    const schema = makeSchema(
      new Map([
        [
          'Article',
          makeNodeDef('Article', [
            {
              indexName: 'article_content_idx',
              queryName: 'similarArticles',
              embeddingProperty: 'embedding',
              provider: 'OpenAI',
            },
          ]),
        ],
      ]),
    );

    const emitted = emitVectorTypes(schema);

    // Stub the referenced `ArticleWhere` type so the snippet compiles standalone.
    const source = `type ArticleWhere = { id?: string };
type Article = { id: string };
${emitted}
`;

    // The TypeScript compiler API is already available as a transitive dep
    // (ts-jest). Use a dynamic require so this test file stays decoupled
    // from the compiler when not needed elsewhere.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ts = require('typescript') as typeof import('typescript');

    const diagnostics: import('typescript').Diagnostic[] = [];
    const host: import('typescript').CompilerHost = {
      fileExists: (fileName: string) => fileName === 'test.ts',
      readFile: (fileName: string) =>
        fileName === 'test.ts' ? source : undefined,
      getSourceFile: (fileName: string, languageVersion) =>
        fileName === 'test.ts'
          ? ts.createSourceFile(fileName, source, languageVersion, true)
          : undefined,
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile: () => undefined,
      getCurrentDirectory: () => '',
      getCanonicalFileName: (fileName: string) => fileName,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
    };

    const program = ts.createProgram(
      ['test.ts'],
      {
        noResolve: true,
        noLib: true,
        strict: true,
        target: ts.ScriptTarget.ES2020,
      },
      host,
    );

    const syntacticDiagnostics = program.getSyntacticDiagnostics(
      program.getSourceFile('test.ts'),
    );
    diagnostics.push(...syntacticDiagnostics);

    expect(diagnostics).toHaveLength(0);
  });
});
