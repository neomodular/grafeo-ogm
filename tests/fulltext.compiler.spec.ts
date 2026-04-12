import { FulltextCompiler } from '../src/compilers/fulltext.compiler';
import { NodeDefinition, SchemaMetadata } from '../src/schema/types';

describe('FulltextCompiler', () => {
  const mockNodeDef: NodeDefinition = {
    typeName: 'Book',
    label: 'Book',
    labels: ['Book'],
    pluralName: 'books',
    properties: new Map([
      [
        'title',
        {
          name: 'title',
          type: 'String',
          required: true,
          isArray: false,
          isListItemRequired: false,
          isGenerated: false,
          isUnique: false,
          isCypher: false,
          directives: [],
        },
      ],
    ]),
    relationships: new Map(),
    fulltextIndexes: [
      { name: 'BookTitleSearch', fields: ['title'] },
      { name: 'BookDescSearch', fields: ['description'] },
    ],
    implementsInterfaces: [],
  };

  const mockSchema: SchemaMetadata = {
    nodes: new Map([['Book', mockNodeDef]]),
    interfaces: new Map(),
    relationshipProperties: new Map(),
    enums: new Map(),
    unions: new Map(),
  };

  let compiler: FulltextCompiler;

  beforeEach(() => {
    compiler = new FulltextCompiler(mockSchema);
  });

  it('should generate correct CALL + YIELD for a simple fulltext query', () => {
    const result = compiler.compile(
      { BookTitleSearch: { phrase: '*albuterol*' } },
      mockNodeDef,
    );

    expect(result.cypher).toBe(
      "CALL db.index.fulltext.queryNodes('BookTitleSearch', $ft_phrase)\n" +
        'YIELD node AS n, score',
    );
    expect(result.params).toEqual({ ft_phrase: '*albuterol*' });
  });

  it('should include scoreThreshold and ft_score param when score is provided', () => {
    const result = compiler.compile(
      { BookTitleSearch: { phrase: 'aspirin', score: 0.5 } },
      mockNodeDef,
    );

    expect(result.cypher).toContain('CALL db.index.fulltext.queryNodes');
    expect(result.cypher).toContain('YIELD node AS n, score');
    expect(result.params).toEqual({ ft_phrase: 'aspirin', ft_score: 0.5 });
    expect(result.scoreThreshold).toBe(0.5);
  });

  it('should not include scoreThreshold when score is not provided', () => {
    const result = compiler.compile(
      { BookTitleSearch: { phrase: 'aspirin' } },
      mockNodeDef,
    );

    expect(result.params).toEqual({ ft_phrase: 'aspirin' });
    expect(result.scoreThreshold).toBeUndefined();
  });

  it('should throw an error for an unknown index name', () => {
    expect(() =>
      compiler.compile({ NonExistentIndex: { phrase: 'test' } }, mockNodeDef),
    ).toThrow(/Unknown fulltext index "NonExistentIndex"/);
  });

  it('should throw an error for an empty phrase', () => {
    expect(() =>
      compiler.compile({ BookTitleSearch: { phrase: '' } }, mockNodeDef),
    ).toThrow(/Fulltext phrase must not be empty/);
  });

  it('should throw an error for a whitespace-only phrase', () => {
    expect(() =>
      compiler.compile({ BookTitleSearch: { phrase: '   ' } }, mockNodeDef),
    ).toThrow(/Fulltext phrase must not be empty/);
  });

  it('should use the correct parameter name ($ft_phrase)', () => {
    const result = compiler.compile(
      { BookTitleSearch: { phrase: 'test' } },
      mockNodeDef,
    );

    expect(result.params).toHaveProperty('ft_phrase');
    expect(result.cypher).toContain('$ft_phrase');
  });

  it('should support custom node variable name', () => {
    const result = compiler.compile(
      { BookTitleSearch: { phrase: 'test' } },
      mockNodeDef,
      'book',
    );

    expect(result.cypher).toBe(
      "CALL db.index.fulltext.queryNodes('BookTitleSearch', $ft_phrase)\n" +
        'YIELD node AS book, score',
    );
  });

  it('should only use the first index when multiple are provided', () => {
    const result = compiler.compile(
      {
        BookTitleSearch: { phrase: 'first' },
        BookDescSearch: { phrase: 'second' },
      },
      mockNodeDef,
    );

    expect(result.cypher).toContain('BookTitleSearch');
    expect(result.params).toEqual({ ft_phrase: 'first' });
  });
});
