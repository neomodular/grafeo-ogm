import { FulltextCompiler } from '../src/compilers/fulltext.compiler';
import { isFulltextLeaf, isFulltextIndexEntry } from '../src/model';
import {
  NodeDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../src/schema/types';

// --- Mock helpers -----------------------------------------------------------

function createMockNodeDef(
  overrides: Partial<NodeDefinition> = {},
): NodeDefinition {
  return {
    typeName: 'Post',
    label: 'Post',
    labels: ['Post'],
    pluralName: 'posts',
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
      [
        'body',
        {
          name: 'body',
          type: 'String',
          required: false,
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
      { name: 'PostTitleSearch', fields: ['title'] },
      { name: 'PostBodySearch', fields: ['body'] },
    ],
    implementsInterfaces: [],
    ...overrides,
  };
}

function createMockSchema(
  nodeDef: NodeDefinition,
  relProps: SchemaMetadata['relationshipProperties'] = new Map(),
): SchemaMetadata {
  return {
    nodes: new Map([[nodeDef.typeName, nodeDef]]),
    interfaces: new Map(),
    relationshipProperties: relProps,
    enums: new Map(),
    unions: new Map(),
  };
}

// --- Tests ------------------------------------------------------------------

describe('FulltextCompiler - type guards', () => {
  describe('isFulltextLeaf', () => {
    it('should return true for a plain index entry', () => {
      expect(isFulltextLeaf({ PostTitleSearch: { phrase: 'hello' } })).toBe(
        true,
      );
    });

    it('should return false for OR operator', () => {
      expect(isFulltextLeaf({ OR: [] })).toBe(false);
    });

    it('should return false for AND operator', () => {
      expect(isFulltextLeaf({ AND: [] })).toBe(false);
    });

    it('should return false for NOT operator', () => {
      expect(
        isFulltextLeaf({ NOT: { PostTitleSearch: { phrase: 'test' } } }),
      ).toBe(false);
    });
  });

  describe('isFulltextIndexEntry', () => {
    it('should return true when value has phrase property', () => {
      expect(isFulltextIndexEntry({ phrase: 'test', score: 0.5 })).toBe(true);
    });

    it('should return true for phrase-only entry', () => {
      expect(isFulltextIndexEntry({ phrase: 'test' })).toBe(true);
    });

    it('should return false for nested relationship entry', () => {
      expect(isFulltextIndexEntry({ SomeIndex: { phrase: 'test' } })).toBe(
        false,
      );
    });
  });
});

describe('FulltextCompiler - compileRelationship', () => {
  const relIndex = { name: 'CommentTextSearch', fields: ['text'] };

  let compiler: FulltextCompiler;

  beforeEach(() => {
    const nodeDef = createMockNodeDef();
    const schema = createMockSchema(nodeDef);
    compiler = new FulltextCompiler(schema);
  });

  it('should compile a basic relationship fulltext query', () => {
    const result = compiler.compileRelationship(
      { CommentTextSearch: { phrase: 'interesting' } },
      relIndex,
    );

    expect(result.cypher).toContain('db.index.fulltext.queryRelationships');
    expect(result.cypher).toContain('CommentTextSearch');
    expect(result.cypher).toContain('$ft_phrase');
    expect(result.cypher).toContain('YIELD relationship AS r, score');
    expect(result.params).toEqual({ ft_phrase: 'interesting' });
  });

  it('should include score threshold when score is provided', () => {
    const result = compiler.compileRelationship(
      { CommentTextSearch: { phrase: 'test', score: 0.8 } },
      relIndex,
    );

    expect(result.params).toEqual({ ft_phrase: 'test', ft_score: 0.8 });
    expect(result.scoreThreshold).toBe(0.8);
  });

  it('should not include score threshold when score is not provided', () => {
    const result = compiler.compileRelationship(
      { CommentTextSearch: { phrase: 'test' } },
      relIndex,
    );

    expect(result.scoreThreshold).toBeUndefined();
    expect(result.params).not.toHaveProperty('ft_score');
  });

  it('should support custom relationship variable name', () => {
    const result = compiler.compileRelationship(
      { CommentTextSearch: { phrase: 'test' } },
      relIndex,
      'rel',
    );

    expect(result.cypher).toContain('YIELD relationship AS rel, score');
  });

  it('should throw for empty input', () => {
    expect(() => compiler.compileRelationship({}, relIndex)).toThrow(
      /at least one index entry/,
    );
  });

  it('should throw for empty phrase', () => {
    expect(() =>
      compiler.compileRelationship(
        { CommentTextSearch: { phrase: '' } },
        relIndex,
      ),
    ).toThrow(/Fulltext phrase must not be empty/);
  });

  it('should throw for whitespace-only phrase', () => {
    expect(() =>
      compiler.compileRelationship(
        { CommentTextSearch: { phrase: '   ' } },
        relIndex,
      ),
    ).toThrow(/Fulltext phrase must not be empty/);
  });

  it('should throw for mismatched index name', () => {
    expect(() =>
      compiler.compileRelationship(
        { WrongIndex: { phrase: 'test' } },
        relIndex,
      ),
    ).toThrow(/Unknown relationship fulltext index "WrongIndex"/);
  });
});

describe('FulltextCompiler - OR logical operator', () => {
  let compiler: FulltextCompiler;
  let nodeDef: NodeDefinition;

  beforeEach(() => {
    nodeDef = createMockNodeDef();
    const schema = createMockSchema(nodeDef);
    compiler = new FulltextCompiler(schema);
  });

  it('should compile OR with two branches using UNION', () => {
    const result = compiler.compile(
      {
        OR: [
          { PostTitleSearch: { phrase: 'hello' } },
          { PostBodySearch: { phrase: 'world' } },
        ],
      },
      nodeDef,
    );

    expect(result.cypher).toContain('CALL {');
    expect(result.cypher).toContain('UNION');
    expect(result.cypher).toContain('PostTitleSearch');
    expect(result.cypher).toContain('PostBodySearch');
    expect(result.cypher).toContain('max(score)');
    expect(Object.keys(result.params)).toHaveLength(2);
  });

  it('should collapse single-branch OR to the branch itself', () => {
    const result = compiler.compile(
      {
        OR: [{ PostTitleSearch: { phrase: 'only' } }],
      },
      nodeDef,
    );

    expect(result.cypher).not.toContain('UNION');
    expect(result.cypher).toContain('PostTitleSearch');
  });

  it('should throw for empty OR array', () => {
    expect(() => compiler.compile({ OR: [] }, nodeDef)).toThrow(
      /OR must contain at least one branch/,
    );
  });
});

describe('FulltextCompiler - AND logical operator', () => {
  let compiler: FulltextCompiler;
  let nodeDef: NodeDefinition;

  beforeEach(() => {
    nodeDef = createMockNodeDef();
    const schema = createMockSchema(nodeDef);
    compiler = new FulltextCompiler(schema);
  });

  it('should compile AND with correlated subqueries', () => {
    const result = compiler.compile(
      {
        AND: [
          { PostTitleSearch: { phrase: 'hello' } },
          { PostBodySearch: { phrase: 'world' } },
        ],
      },
      nodeDef,
    );

    expect(result.cypher).toContain('CALL {');
    expect(result.cypher).toContain('PostTitleSearch');
    expect(result.cypher).toContain('PostBodySearch');
    // Second branch uses 'm' variable and matches against nodeVar
    expect(result.cypher).toContain('WHERE m = n');
    expect(Object.keys(result.params)).toHaveLength(2);
  });

  it('should collapse single-branch AND to the branch itself', () => {
    const result = compiler.compile(
      {
        AND: [{ PostTitleSearch: { phrase: 'only' } }],
      },
      nodeDef,
    );

    expect(result.cypher).not.toContain('CALL {');
    expect(result.cypher).toContain('PostTitleSearch');
  });

  it('should throw for empty AND array', () => {
    expect(() => compiler.compile({ AND: [] }, nodeDef)).toThrow(
      /AND must contain at least one branch/,
    );
  });
});

describe('FulltextCompiler - NOT logical operator', () => {
  let compiler: FulltextCompiler;
  let nodeDef: NodeDefinition;

  beforeEach(() => {
    nodeDef = createMockNodeDef();
    const schema = createMockSchema(nodeDef);
    compiler = new FulltextCompiler(schema);
  });

  it('should compile NOT with WHERE NOT EXISTS pattern', () => {
    const result = compiler.compile(
      {
        NOT: { PostTitleSearch: { phrase: 'spam' } },
      },
      nodeDef,
    );

    expect(result.cypher).toContain('MATCH (n:`Post`)');
    expect(result.cypher).toContain('WHERE NOT EXISTS {');
    expect(result.cypher).toContain('PostTitleSearch');
    expect(result.cypher).toContain('WHERE excluded = n');
    expect(result.cypher).toContain('0 AS score');
  });
});

describe('FulltextCompiler - nested logical operators', () => {
  let compiler: FulltextCompiler;
  let nodeDef: NodeDefinition;

  beforeEach(() => {
    nodeDef = createMockNodeDef();
    const schema = createMockSchema(nodeDef);
    compiler = new FulltextCompiler(schema);
  });

  it('should compile OR inside AND', () => {
    const result = compiler.compile(
      {
        AND: [
          { PostTitleSearch: { phrase: 'hello' } },
          {
            OR: [
              { PostBodySearch: { phrase: 'world' } },
              { PostTitleSearch: { phrase: 'earth' } },
            ],
          },
        ],
      },
      nodeDef,
    );

    expect(result.cypher).toContain('PostTitleSearch');
    expect(result.cypher).toContain('PostBodySearch');
    expect(result.cypher).toContain('UNION');
    expect(Object.keys(result.params)).toHaveLength(3);
  });

  it('should compile NOT inside OR', () => {
    const result = compiler.compile(
      {
        OR: [
          { PostTitleSearch: { phrase: 'hello' } },
          { NOT: { PostBodySearch: { phrase: 'spam' } } },
        ],
      },
      nodeDef,
    );

    expect(result.cypher).toContain('UNION');
    expect(result.cypher).toContain('WHERE NOT EXISTS');
    expect(Object.keys(result.params)).toHaveLength(2);
  });

  it('should throw for invalid fulltext input shape', () => {
    // A non-leaf, non-logical input causes an error when the value is a
    // non-object (string) and `in` operator fails on it.
    expect(() =>
      compiler.compile({ INVALID: 'something' } as never, nodeDef),
    ).toThrow();
  });
});

describe('FulltextCompiler - relationship index via compile()', () => {
  it('should compile relationship fulltext via leaf entry in compile()', () => {
    const relDef: RelationshipDefinition = {
      fieldName: 'comments',
      type: 'HAS_COMMENT',
      direction: 'OUT',
      target: 'Comment',
      isArray: true,
      isRequired: false,
      properties: 'CommentEdgeProps',
    };

    const nodeDef = createMockNodeDef({
      relationships: new Map([['comments', relDef]]),
    });

    const relPropsMap = new Map([
      [
        'CommentEdgeProps',
        {
          typeName: 'CommentEdgeProps',
          properties: new Map([
            [
              'text',
              {
                name: 'text',
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
          fulltextIndexes: [{ name: 'CommentTextSearch', fields: ['text'] }],
        },
      ],
    ]);

    const schema = createMockSchema(nodeDef, relPropsMap);
    const compiler = new FulltextCompiler(schema);

    const result = compiler.compile(
      { comments: { CommentTextSearch: { phrase: 'great post' } } },
      nodeDef,
    );

    expect(result.cypher).toContain('db.index.fulltext.queryRelationships');
    expect(result.cypher).toContain('CommentTextSearch');
    expect(result.cypher).toContain('startNode(rel)');
  });

  // v1.7.4 regression — IN-direction relationship fulltext used to
  // hardcode `startNode(rel)`, binding the WRONG endpoint to nodeVar.
  // For `(parent)<-[rel]-(target)`, the parent is `endNode(rel)`.
  it('uses endNode(rel) for IN-direction relationship fulltext (v1.7.4)', () => {
    const relDef: RelationshipDefinition = {
      fieldName: 'comments',
      type: 'HAS_COMMENT',
      direction: 'IN',
      target: 'Comment',
      isArray: true,
      isRequired: false,
      properties: 'CommentEdgeProps',
    };

    const nodeDef = createMockNodeDef({
      relationships: new Map([['comments', relDef]]),
    });

    const relPropsMap = new Map([
      [
        'CommentEdgeProps',
        {
          typeName: 'CommentEdgeProps',
          properties: new Map([
            [
              'text',
              {
                name: 'text',
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
          fulltextIndexes: [{ name: 'CommentTextSearch', fields: ['text'] }],
        },
      ],
    ]);

    const schema = createMockSchema(nodeDef, relPropsMap);
    const compiler = new FulltextCompiler(schema);

    const result = compiler.compile(
      { comments: { CommentTextSearch: { phrase: 'great post' } } },
      nodeDef,
    );

    expect(result.cypher).toContain('endNode(rel)');
    expect(result.cypher).not.toContain('startNode(rel)');
  });

  it('should throw for unknown relationship field', () => {
    const nodeDef = createMockNodeDef();
    const schema = createMockSchema(nodeDef);
    const compiler = new FulltextCompiler(schema);

    expect(() =>
      compiler.compile(
        { nonExistentRel: { SomeIndex: { phrase: 'test' } } },
        nodeDef,
      ),
    ).toThrow(/Unknown relationship field/);
  });

  it('should throw for relationship without @relationshipProperties', () => {
    const relDef: RelationshipDefinition = {
      fieldName: 'comments',
      type: 'HAS_COMMENT',
      direction: 'OUT',
      target: 'Comment',
      isArray: true,
      isRequired: false,
      // No properties field
    };

    const nodeDef = createMockNodeDef({
      relationships: new Map([['comments', relDef]]),
    });
    const schema = createMockSchema(nodeDef);
    const compiler = new FulltextCompiler(schema);

    expect(() =>
      compiler.compile(
        { comments: { SomeIndex: { phrase: 'test' } } },
        nodeDef,
      ),
    ).toThrow(/has no @relationshipProperties/);
  });
});
