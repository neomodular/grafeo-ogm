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

  // v1.7.3 — phrase length cap
  it('throws on phrases longer than 8 KB (DoS / billing-attack guard)', () => {
    const huge = 'a'.repeat(8 * 1024 + 1);
    expect(() =>
      compiler.compile({ BookTitleSearch: { phrase: huge } }, mockNodeDef),
    ).toThrow(/exceeds the maximum length/);
  });

  it('accepts phrases at the 8 KB boundary', () => {
    const limit = 'a'.repeat(8 * 1024);
    expect(() =>
      compiler.compile({ BookTitleSearch: { phrase: limit } }, mockNodeDef),
    ).not.toThrow();
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

  // ---------------------------------------------------------------------------
  // Fulltext leaf arity — v2.0.0
  //
  // Until v2.0.0 a leaf naming two indexes searched only the FIRST and dropped
  // the rest with no error, so the query returned a strictly wider result set
  // than asked for. A characterization test ("should only use the first index
  // when multiple are provided") pinned that behaviour; it described the defect
  // rather than defending it, and is replaced by the specs below. Multiple
  // indexes are expressed with the AND / OR operators the compiler already has.
  // ---------------------------------------------------------------------------
  it('should reject a leaf naming more than one index', () => {
    expect(() =>
      compiler.compile(
        {
          BookTitleSearch: { phrase: 'first' },
          BookDescSearch: { phrase: 'second' },
        },
        mockNodeDef,
      ),
    ).toThrow(/Fulltext leaf has 2 keys \(BookTitleSearch, BookDescSearch\)/);
  });

  it('should point at the AND / OR operators without echoing phrases', () => {
    let message = '';
    try {
      compiler.compile(
        {
          BookTitleSearch: { phrase: 'sensitive phrase' },
          BookDescSearch: { phrase: 'another' },
        },
        mockNodeDef,
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(
      '{ AND: [{ BookTitleSearch: … }, { BookDescSearch: … }] }',
    );
    // Phrases are user data — they must never land in an error string.
    expect(message).not.toContain('sensitive phrase');
  });

  it('should compile both indexes when combined with AND', () => {
    const result = compiler.compile(
      {
        AND: [
          { BookTitleSearch: { phrase: 'first' } },
          { BookDescSearch: { phrase: 'second' } },
        ],
      },
      mockNodeDef,
    );

    expect(result.cypher).toContain('BookTitleSearch');
    expect(result.cypher).toContain('BookDescSearch');
    expect(Object.values(result.params)).toEqual(
      expect.arrayContaining(['first', 'second']),
    );
  });

  it('should still compile a single-index leaf unchanged', () => {
    const result = compiler.compile(
      { BookTitleSearch: { phrase: 'only' } },
      mockNodeDef,
    );

    expect(result.cypher).toContain('BookTitleSearch');
    expect(result.params).toEqual({ ft_phrase: 'only' });
  });

  // ---------------------------------------------------------------------------
  // Operator arity — v2.0.0
  //
  // `compileNode` tests OR, then AND, then NOT, returning on the first hit — so
  // anything alongside the winning operator was silently discarded. The NOT
  // case is the worst: `{ NOT, AND }` compiled AND only, so an exclusion filter
  // vanished, inverting intent rather than merely widening the result set.
  // ---------------------------------------------------------------------------
  describe('operator arity', () => {
    it('rejects two logical operators in one object', () => {
      expect(() =>
        compiler.compile(
          {
            OR: [{ BookTitleSearch: { phrase: 'or-branch' } }],
            AND: [{ BookDescSearch: { phrase: 'and-branch' } }],
          },
          mockNodeDef,
        ),
      ).toThrow(/Fulltext input carries OR \+ AND/);
    });

    it('rejects NOT alongside AND — the case that dropped the exclusion', () => {
      expect(() =>
        compiler.compile(
          {
            NOT: { BookTitleSearch: { phrase: 'excluded' } },
            AND: [{ BookDescSearch: { phrase: 'required' } }],
          },
          mockNodeDef,
        ),
      ).toThrow(/Fulltext input carries AND \+ NOT/);
    });

    it('rejects an operator mixed with a bare index key', () => {
      expect(() =>
        compiler.compile(
          {
            OR: [{ BookTitleSearch: { phrase: 'or-branch' } }],
            BookDescSearch: { phrase: 'stray-leaf' },
          },
          mockNodeDef,
        ),
      ).toThrow(/carries OR and 1 other top-level key/);
    });

    it('never echoes unvalidated sibling keys into the message', () => {
      // Sibling keys are not identifier-checked at dispatch time, so they are
      // counted rather than interpolated.
      let message = '';
      try {
        compiler.compile(
          {
            OR: [{ BookTitleSearch: { phrase: 'x' } }],
            '\n\n[forged log line]': { phrase: 'y' },
          } as never,
          mockNodeDef,
        );
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('1 other top-level key');
      expect(message).not.toContain('forged log line');
    });

    it('still compiles a single operator unchanged', () => {
      const result = compiler.compile(
        {
          OR: [
            { BookTitleSearch: { phrase: 'a' } },
            { BookDescSearch: { phrase: 'b' } },
          ],
        },
        mockNodeDef,
      );

      expect(result.cypher).toContain('UNION');
    });

    it('still compiles properly nested operators', () => {
      const result = compiler.compile(
        {
          AND: [
            { OR: [{ BookTitleSearch: { phrase: 'a' } }] },
            { BookDescSearch: { phrase: 'b' } },
          ],
        },
        mockNodeDef,
      );

      expect(result.cypher).toContain('BookTitleSearch');
      expect(result.cypher).toContain('BookDescSearch');
    });
  });

  // ---------------------------------------------------------------------------
  // Non-object fulltext inputs — v2.0.0
  //
  // `Object.keys(null)` and `'OR' in null` both throw a bare TypeError from
  // inside the compiler, escaping `instanceof OGMError` handling.
  // ---------------------------------------------------------------------------
  describe('non-object inputs', () => {
    it('rejects a non-object top-level input', () => {
      expect(() => compiler.compile(null as never, mockNodeDef)).toThrow(
        /Fulltext input must be an object, got null\./,
      );
    });

    it('rejects a non-object nested inside an operator branch', () => {
      // The guard lives in compileNode, so recursion is covered too.
      expect(() =>
        compiler.compile({ OR: [null] } as never, mockNodeDef),
      ).toThrow(/Fulltext input must be an object, got null\./);
    });

    it('rejects a non-object index entry value', () => {
      expect(() =>
        compiler.compile({ BookTitleSearch: null } as never, mockNodeDef),
      ).toThrow(
        /Fulltext entry "BookTitleSearch" must be an object, got null\./,
      );
    });

    it('reports the kind without echoing the value', () => {
      let message = '';
      try {
        compiler.compile('\n\n[forged log line]' as never, mockNodeDef);
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('got a string');
      expect(message).not.toContain('forged log line');
    });
  });
});
