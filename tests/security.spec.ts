import {
  assertSafeIdentifier,
  assertSafeLabel,
  assertSafeKey,
  assertSortDirection,
  escapeIdentifier,
} from '../src/utils/validation';
import { FulltextCompiler } from '../src/compilers/fulltext.compiler';
import { MutationCompiler } from '../src/compilers/mutation.compiler';
import {
  SchemaMetadata,
  NodeDefinition,
  PropertyDefinition,
  FulltextIndex,
  RelationshipDefinition,
} from '../src/schema/types';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function makeProperty(
  overrides: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return {
    name: 'id',
    type: 'ID',
    required: true,
    isArray: false,
    isListItemRequired: false,
    isGenerated: true,
    isUnique: false,
    isCypher: false,
    directives: ['id'],
    defaultValue: undefined,
    ...overrides,
  };
}

function makeNodeDef(overrides: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    typeName: 'Book',
    label: 'Book',
    labels: ['Book'],
    pluralName: 'books',
    properties: new Map([['id', makeProperty()]]),
    relationships: new Map(),
    fulltextIndexes: [],
    implementsInterfaces: [],
    ...overrides,
  };
}

function makeSchema(overrides: Partial<SchemaMetadata> = {}): SchemaMetadata {
  return {
    nodes: new Map(),
    interfaces: new Map(),
    relationshipProperties: new Map(),
    enums: new Map(),
    unions: new Map(),
    ...overrides,
  };
}

// ─── assertSafeIdentifier ─────────────────────────────────────────────────────

describe('assertSafeIdentifier', () => {
  it.each(['name', 'title', '_id', 'field123', 'A', '_', '_foo_bar'])(
    'accepts valid identifier: %s',
    (value) => {
      expect(() => assertSafeIdentifier(value, 'test')).not.toThrow();
    },
  );

  it.each([
    ["'; DROP DB--", 'SQL/Cypher injection'],
    ['name` OR 1=1', 'backtick injection'],
    ['a b', 'space in identifier'],
    ['123start', 'starts with digit'],
    ['', 'empty string'],
    ['foo-bar', 'hyphen'],
    ['foo.bar', 'dot notation'],
    ['foo;bar', 'semicolon'],
    ['name\n', 'newline'],
  ])('rejects injection attempt: %s (%s)', (value) => {
    expect(() => assertSafeIdentifier(value, 'test')).toThrow(
      /Invalid identifier/,
    );
  });
});

// ─── assertSafeLabel ──────────────────────────────────────────────────────────

describe('assertSafeLabel', () => {
  it.each(['Book', 'MyNode', '_Label', 'Label123'])(
    'accepts valid label: %s',
    (value) => {
      expect(() => assertSafeLabel(value)).not.toThrow();
    },
  );

  it('returns the label backtick-escaped when valid', () => {
    expect(assertSafeLabel('Book')).toBe('`Book`');
  });

  it.each(["'; DROP DB--", 'a b', '123start', '', 'foo-bar'])(
    'rejects invalid label: %s',
    (value) => {
      expect(() => assertSafeLabel(value)).toThrow(/Invalid identifier/);
    },
  );
});

// ─── escapeIdentifier ─────────────────────────────────────────────────────────

describe('escapeIdentifier', () => {
  it('wraps identifier in backticks', () => {
    expect(escapeIdentifier('name')).toBe('`name`');
  });

  it('doubles existing backticks', () => {
    expect(escapeIdentifier('na`me')).toBe('`na``me`');
  });

  it.each([
    'ORDER',
    'MATCH',
    'SET',
    'CALL',
    'RETURN',
    'DELETE',
    'CREATE',
    'WHERE',
    'WITH',
  ])('escapes Cypher reserved word: %s', (word) => {
    expect(escapeIdentifier(word)).toBe(`\`${word}\``);
  });
});

// ─── assertSafeKey ────────────────────────────────────────────────────────────

describe('assertSafeKey', () => {
  it.each(['id', 'name', 'isActive', 'someField', '_private'])(
    'accepts safe key: %s',
    (key) => {
      expect(() => assertSafeKey(key, 'test')).not.toThrow();
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects prototype pollution key: %s',
    (key) => {
      expect(() => assertSafeKey(key, 'test')).toThrow(
        /Potentially dangerous key/,
      );
    },
  );

  it('rejects __proto__ with descriptive message', () => {
    expect(() => assertSafeKey('__proto__', 'where')).toThrow(
      /Potentially dangerous key "__proto__" in where/,
    );
  });

  it('rejects constructor with descriptive message', () => {
    expect(() => assertSafeKey('constructor', 'input')).toThrow(
      /Potentially dangerous key "constructor" in input/,
    );
  });
});

// ─── assertSortDirection ─────────────────────────────────────────────────────

describe('assertSortDirection', () => {
  it('accepts ASC', () => {
    expect(assertSortDirection('ASC')).toBe('ASC');
  });

  it('accepts DESC', () => {
    expect(assertSortDirection('DESC')).toBe('DESC');
  });

  it('throws on invalid direction', () => {
    expect(() => assertSortDirection('ASCENDING')).toThrow(
      /Invalid sort direction "ASCENDING"/,
    );
  });

  it('throws on lowercase asc', () => {
    expect(() => assertSortDirection('asc')).toThrow(
      /Invalid sort direction "asc"/,
    );
  });
});

// ─── FulltextCompiler injection prevention ────────────────────────────────────

describe('FulltextCompiler', () => {
  const fulltextIndex: FulltextIndex = {
    name: 'BookTitleSearch',
    fields: ['title'],
  };

  const nodeDef = makeNodeDef({
    properties: new Map([
      ['id', makeProperty()],
      [
        'title',
        makeProperty({ name: 'title', type: 'String', isGenerated: false }),
      ],
    ]),
    fulltextIndexes: [fulltextIndex],
  });

  const schema = makeSchema({
    nodes: new Map([['Book', nodeDef]]),
  });

  const compiler = new FulltextCompiler(schema);

  it('compiles a valid fulltext query', () => {
    const result = compiler.compile(
      { BookTitleSearch: { phrase: 'albuterol' } },
      nodeDef,
    );

    expect(result.cypher).toContain('db.index.fulltext.queryNodes');
    expect(result.cypher).toContain('BookTitleSearch');
    expect(result.params).toEqual({ ft_phrase: 'albuterol' });
  });

  it('throws on injection attempt in index name', () => {
    expect(() =>
      compiler.compile({ "'; DROP DB--": { phrase: 'test' } }, nodeDef),
    ).toThrow(/Invalid identifier/);
  });

  it('throws on index name with spaces', () => {
    expect(() =>
      compiler.compile({ 'my index': { phrase: 'test' } }, nodeDef),
    ).toThrow(/Invalid identifier/);
  });

  it('throws on unknown fulltext index name', () => {
    expect(() =>
      compiler.compile({ UnknownIndex: { phrase: 'test' } }, nodeDef),
    ).toThrow(/Unknown fulltext index/);
  });

  it('throws on empty phrase', () => {
    expect(() =>
      compiler.compile({ BookTitleSearch: { phrase: '' } }, nodeDef),
    ).toThrow(/Fulltext phrase must not be empty/);
  });

  it('includes score threshold when provided', () => {
    const result = compiler.compile(
      { BookTitleSearch: { phrase: 'albuterol', score: 0.5 } },
      nodeDef,
    );

    expect(result.scoreThreshold).toBe(0.5);
    expect(result.params.ft_score).toBe(0.5);
  });
});

// ─── MutationCompiler security validations ────────────────────────────────────

describe('MutationCompiler', () => {
  describe('compileCreate property validation', () => {
    const nodeDef = makeNodeDef({
      properties: new Map([
        ['id', makeProperty()],
        [
          'name',
          makeProperty({
            name: 'name',
            type: 'String',
            isGenerated: false,
            required: true,
          }),
        ],
      ]),
    });

    const schema = makeSchema({
      nodes: new Map([['Book', nodeDef]]),
    });

    const compiler = new MutationCompiler(schema);

    it('creates a node with valid property names', () => {
      const result = compiler.compileCreate([{ name: 'Aspirin' }], nodeDef);

      expect(result.cypher).toContain('CREATE');
      expect(result.cypher).toContain('Book');
      expect(result.params).toHaveProperty('create0_name', 'Aspirin');
    });

    it('throws on injection attempt in property name', () => {
      expect(() =>
        compiler.compileCreate([{ "'; DROP DB--": 'evil' }], nodeDef),
      ).toThrow(/Invalid identifier/);
    });

    it('throws on property name with special characters', () => {
      expect(() =>
        compiler.compileCreate([{ 'name OR 1=1': 'evil' }], nodeDef),
      ).toThrow(/Invalid identifier/);
    });
  });

  describe('compileUpdate property validation', () => {
    const nodeDef = makeNodeDef({
      properties: new Map([
        ['id', makeProperty()],
        [
          'name',
          makeProperty({
            name: 'name',
            type: 'String',
            isGenerated: false,
            required: true,
          }),
        ],
      ]),
    });

    const schema = makeSchema({
      nodes: new Map([['Book', nodeDef]]),
    });

    const compiler = new MutationCompiler(schema);

    const whereResult = { cypher: 'n.\`id\` = $id', params: { id: '1' } };

    it('updates with valid property names', () => {
      const result = compiler.compileUpdate(
        { id: '1' },
        { name: 'NewName' },
        undefined,
        undefined,
        nodeDef,
        whereResult,
      );

      expect(result.cypher).toContain('SET n.\`name\`');
      expect(result.params).toHaveProperty('update_name', 'NewName');
    });

    it('throws on injection in update property name', () => {
      expect(() =>
        compiler.compileUpdate(
          { id: '1' },
          { "'; DROP DB--": 'evil' },
          undefined,
          undefined,
          nodeDef,
          whereResult,
        ),
      ).toThrow(/Invalid identifier/);
    });
  });

  describe('label validation in mutations', () => {
    it('throws on malicious label in node definition', () => {
      const maliciousNodeDef = makeNodeDef({
        label: "Book') DETACH DELETE n//",
        labels: ["Book') DETACH DELETE n//"],
      });

      const schema = makeSchema({
        nodes: new Map([['Book', maliciousNodeDef]]),
      });

      const compiler = new MutationCompiler(schema);

      expect(() =>
        compiler.compileCreate([{ name: 'Aspirin' }], maliciousNodeDef),
      ).toThrow(/Invalid identifier/);
    });
  });

  describe('edge property validation via buildConnects', () => {
    const targetNodeDef = makeNodeDef({
      typeName: 'Status',
      label: 'Status',
      labels: ['Status'],
      pluralName: 'statuses',
      properties: new Map([
        ['id', makeProperty()],
        [
          'name',
          makeProperty({
            name: 'name',
            type: 'String',
            isGenerated: false,
          }),
        ],
      ]),
    });

    const relDef: RelationshipDefinition = {
      fieldName: 'hasStatus',
      type: 'HAS_STATUS',
      direction: 'OUT',
      target: 'Status',
      properties: 'StatusEdgeProps',
      isArray: false,
      isRequired: false,
    };

    const nodeDef = makeNodeDef({
      properties: new Map([
        ['id', makeProperty()],
        [
          'name',
          makeProperty({
            name: 'name',
            type: 'String',
            isGenerated: false,
          }),
        ],
      ]),
      relationships: new Map([['hasStatus', relDef]]),
    });

    const schema = makeSchema({
      nodes: new Map([
        ['Book', nodeDef],
        ['Status', targetNodeDef],
      ]),
    });

    const compiler = new MutationCompiler(schema);

    it('connects with valid edge property names', () => {
      const whereResult = { cypher: 'n.\`id\` = $id', params: { id: '1' } };

      const result = compiler.compileUpdate(
        { id: '1' },
        undefined,
        {
          hasStatus: {
            where: { node: { id: 'status-1' } },
            edge: { priority: 1 },
          },
        },
        undefined,
        nodeDef,
        whereResult,
      );

      expect(result.cypher).toContain('MERGE');
      expect(result.cypher).toContain('HAS_STATUS');
      expect(result.params).toHaveProperty(
        'connect_hasStatus_edge_priority',
        1,
      );
    });

    it('throws on injection in connect where property name', () => {
      const whereResult = { cypher: 'n.\`id\` = $id', params: { id: '1' } };

      expect(() =>
        compiler.compileUpdate(
          { id: '1' },
          undefined,
          {
            hasStatus: {
              where: { node: { "'; DROP DB--": 'evil' } },
            },
          },
          undefined,
          nodeDef,
          whereResult,
        ),
      ).toThrow(/Invalid identifier/);
    });
  });
});
