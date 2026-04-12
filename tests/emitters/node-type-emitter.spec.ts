import { emitNodeTypes } from '../../src/generator/type-emitters/node-type-emitter';
import type {
  SchemaMetadata,
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  RelationshipPropertiesDefinition,
} from '../../src/schema/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProp(
  name: string,
  overrides: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return {
    name,
    type: 'String',
    required: false,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher: false,
    directives: [],
    ...overrides,
  };
}

function makeRel(
  fieldName: string,
  target: string,
  overrides: Partial<RelationshipDefinition> = {},
): RelationshipDefinition {
  return {
    fieldName,
    type: 'HAS_' + target.toUpperCase(),
    direction: 'OUT',
    target,
    isArray: true,
    isRequired: true,
    ...overrides,
  };
}

function makeNodeDef(
  typeName: string,
  overrides: Partial<NodeDefinition> = {},
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map(),
    relationships: new Map(),
    fulltextIndexes: [],
    implementsInterfaces: [],
    ...overrides,
  };
}

function makeSchema(
  nodes: Map<string, NodeDefinition>,
  overrides: Partial<SchemaMetadata> = {},
): SchemaMetadata {
  return {
    nodes,
    interfaces: new Map(),
    relationshipProperties: new Map(),
    enums: new Map(),
    unions: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emitNodeTypes', () => {
  it('emits a node with scalar properties (required and optional)', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', {
            properties: new Map([
              ['id', makeProp('id', { type: 'ID', required: true })],
              ['name', makeProp('name', { type: 'String', required: true })],
              [
                'description',
                makeProp('description', { type: 'String', required: false }),
              ],
            ]),
          }),
        ],
      ]),
    );

    const output = emitNodeTypes(schema);

    expect(output).toContain('export type Book = {');
    expect(output).toContain('  __typename?: "Book";');
    expect(output).toContain('  id: Scalars["ID"]["output"];');
    expect(output).toContain('  name: Scalars["String"]["output"];');
    expect(output).toContain(
      '  description?: Maybe<Scalars["String"]["output"]>;',
    );
    expect(output).toContain('};');
  });

  it('always emits __typename as optional', () => {
    const schema = makeSchema(new Map([['Author', makeNodeDef('Author')]]));

    const output = emitNodeTypes(schema);

    expect(output).toContain('  __typename?: "Author";');
  });

  it('emits relationship fields: aggregate, relationship, and connection', () => {
    const schema = makeSchema(
      new Map([
        [
          'Author',
          makeNodeDef('Author', {
            relationships: new Map([
              ['books', makeRel('books', 'Book', { isArray: true })],
            ]),
          }),
        ],
      ]),
    );

    const output = emitNodeTypes(schema);

    // Aggregate field
    expect(output).toContain(
      '  booksAggregate?: Maybe<AuthorBookBooksAggregationSelection>;',
    );
    // Array relationship field
    expect(output).toContain('  books: Array<Book>;');
    // Connection field
    expect(output).toContain('  booksConnection: AuthorBooksConnection;');
  });

  it('emits singular required relationship field', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', {
            relationships: new Map([
              [
                'hasStatus',
                makeRel('hasStatus', 'Status', {
                  isArray: false,
                  isRequired: true,
                }),
              ],
            ]),
          }),
        ],
      ]),
    );

    const output = emitNodeTypes(schema);

    expect(output).toContain('  hasStatus: Status;');
    expect(output).toContain('  hasStatusConnection: BookHasStatusConnection;');
    expect(output).toContain(
      '  hasStatusAggregate?: Maybe<BookStatusHasStatusAggregationSelection>;',
    );
  });

  it('emits singular optional relationship with Maybe wrapper', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', {
            relationships: new Map([
              [
                'resource',
                makeRel('resource', 'Resource', {
                  isArray: false,
                  isRequired: false,
                }),
              ],
            ]),
          }),
        ],
      ]),
    );

    const output = emitNodeTypes(schema);

    expect(output).toContain('  resource?: Maybe<Resource>;');
  });

  it('emits @cypher field as optional Maybe<Type> for scalar types', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', {
            properties: new Map([
              ['id', makeProp('id', { type: 'ID', required: true })],
              [
                'computedName',
                makeProp('computedName', {
                  type: 'String',
                  isCypher: true,
                  required: false,
                }),
              ],
            ]),
          }),
        ],
      ]),
    );

    const output = emitNodeTypes(schema);

    expect(output).toContain(
      '  computedName?: Maybe<Scalars["String"]["output"]>;',
    );
    // Should still have the regular property
    expect(output).toContain('  id: Scalars["ID"]["output"];');
  });

  it('emits @cypher field that references a node type using the type name directly', () => {
    const schema = makeSchema(
      new Map([
        [
          'Author',
          makeNodeDef('Author', {
            properties: new Map([
              [
                'relatedBook',
                makeProp('relatedBook', {
                  type: 'Book',
                  isCypher: true,
                  required: false,
                  isArray: false,
                }),
              ],
            ]),
          }),
        ],
        ['Book', makeNodeDef('Book')],
      ]),
    );

    const output = emitNodeTypes(schema);

    // Should use 'Book' directly, not Scalars["Book"]["output"]
    expect(output).toContain('  relatedBook?: Maybe<Book>;');
    expect(output).not.toContain('Scalars["Book"]');
  });

  it('emits @cypher array field as Maybe<Array<Type>>', () => {
    const schema = makeSchema(
      new Map([
        [
          'Author',
          makeNodeDef('Author', {
            properties: new Map([
              [
                'relatedBooks',
                makeProp('relatedBooks', {
                  type: 'Book',
                  isCypher: true,
                  required: false,
                  isArray: true,
                }),
              ],
            ]),
          }),
        ],
        ['Book', makeNodeDef('Book')],
      ]),
    );

    const output = emitNodeTypes(schema);

    expect(output).toContain('  relatedBooks?: Maybe<Array<Book>>;');
  });

  it('emits @cypher array field with scalar type', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', {
            properties: new Map([
              [
                'tags',
                makeProp('tags', {
                  type: 'String',
                  isCypher: true,
                  required: false,
                  isArray: true,
                }),
              ],
            ]),
          }),
        ],
      ]),
    );

    const output = emitNodeTypes(schema);

    expect(output).toContain(
      '  tags?: Maybe<Array<Scalars["String"]["output"]>>;',
    );
  });

  it('emits union type aliases', () => {
    const schema = makeSchema(new Map(), {
      unions: new Map([
        ['SearchResult', ['Book', 'Author', 'Organization']],
        ['AdminEntity', ['User', 'Department']],
      ]),
    });

    const output = emitNodeTypes(schema);

    expect(output).toContain('export type AdminEntity = User | Department;');
    expect(output).toContain(
      'export type SearchResult = Book | Author | Organization;',
    );

    // Verify alphabetical sort
    const adminIdx = output.indexOf('export type AdminEntity');
    const searchIdx = output.indexOf('export type SearchResult');
    expect(adminIdx).toBeLessThan(searchIdx);
  });

  it('emits relationship property base types', () => {
    const relProps = new Map<string, RelationshipPropertiesDefinition>([
      [
        'AuthorBookProps',
        {
          typeName: 'AuthorBookProps',
          properties: new Map([
            ['order', makeProp('order', { type: 'Int', required: true })],
            [
              'migrationKey',
              makeProp('migrationKey', { type: 'String', required: false }),
            ],
          ]),
        },
      ],
    ]);

    const schema = makeSchema(new Map(), {
      relationshipProperties: relProps,
    });

    const output = emitNodeTypes(schema);

    expect(output).toContain('export type AuthorBookProps = {');
    expect(output).toContain('  order: Scalars["Int"]["output"];');
    expect(output).toContain(
      '  migrationKey?: Maybe<Scalars["String"]["output"]>;',
    );
    expect(output).toContain('};');
  });

  it('skips @cypher properties in relationship property types', () => {
    const relProps = new Map<string, RelationshipPropertiesDefinition>([
      [
        'EdgeProps',
        {
          typeName: 'EdgeProps',
          properties: new Map([
            ['weight', makeProp('weight', { type: 'Float', required: true })],
            [
              'computed',
              makeProp('computed', { type: 'String', isCypher: true }),
            ],
          ]),
        },
      ],
    ]);

    const schema = makeSchema(new Map(), {
      relationshipProperties: relProps,
    });

    const output = emitNodeTypes(schema);

    expect(output).toContain('  weight: Scalars["Float"]["output"];');
    expect(output).not.toContain('computed');
  });

  it('sorts relationship property types alphabetically', () => {
    const relProps = new Map<string, RelationshipPropertiesDefinition>([
      [
        'ZebraProps',
        {
          typeName: 'ZebraProps',
          properties: new Map([
            ['a', makeProp('a', { type: 'String', required: true })],
          ]),
        },
      ],
      [
        'AlphaProps',
        {
          typeName: 'AlphaProps',
          properties: new Map([
            ['b', makeProp('b', { type: 'String', required: true })],
          ]),
        },
      ],
    ]);

    const schema = makeSchema(new Map(), {
      relationshipProperties: relProps,
    });

    const output = emitNodeTypes(schema);

    const alphaIdx = output.indexOf('export type AlphaProps');
    const zebraIdx = output.indexOf('export type ZebraProps');
    expect(alphaIdx).toBeLessThan(zebraIdx);
  });

  it('sorts nodes alphabetically', () => {
    const schema = makeSchema(
      new Map([
        ['Zebra', makeNodeDef('Zebra')],
        ['Alpha', makeNodeDef('Alpha')],
      ]),
    );

    const output = emitNodeTypes(schema);

    const alphaIdx = output.indexOf('export type Alpha');
    const zebraIdx = output.indexOf('export type Zebra');
    expect(alphaIdx).toBeLessThan(zebraIdx);
  });

  it('emits array scalar properties correctly', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', {
            properties: new Map([
              [
                'tags',
                makeProp('tags', {
                  type: 'String',
                  required: true,
                  isArray: true,
                }),
              ],
            ]),
          }),
        ],
      ]),
    );

    const output = emitNodeTypes(schema);

    expect(output).toContain('  tags: Array<Scalars["String"]["output"]>;');
  });

  it('handles enum-typed properties on nodes', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', {
            properties: new Map([
              [
                'status',
                makeProp('status', { type: 'StatusEnum', required: true }),
              ],
            ]),
          }),
        ],
      ]),
      { enums: new Map([['StatusEnum', ['ACTIVE', 'INACTIVE']]]) },
    );

    const output = emitNodeTypes(schema);

    expect(output).toContain('  status: StatusEnum;');
  });

  it('returns empty string for no nodes, no unions, and no relationship properties', () => {
    const schema = makeSchema(new Map());
    const output = emitNodeTypes(schema);

    expect(output).toBe('');
  });

  it('handles schema with undefined unions gracefully', () => {
    const schema = makeSchema(new Map([['Book', makeNodeDef('Book')]]), {
      unions: undefined as unknown as Map<string, string[]>,
    });

    const output = emitNodeTypes(schema);

    expect(output).toContain('export type Book = {');
    expect(output).toContain('__typename?: "Book"');
  });

  it('combines nodes, unions, and relationship properties in output', () => {
    const relProps = new Map<string, RelationshipPropertiesDefinition>([
      [
        'EdgeProps',
        {
          typeName: 'EdgeProps',
          properties: new Map([
            ['weight', makeProp('weight', { type: 'Float', required: true })],
          ]),
        },
      ],
    ]);

    const schema = makeSchema(new Map([['Book', makeNodeDef('Book')]]), {
      unions: new Map([['SearchResult', ['Book', 'Author']]]),
      relationshipProperties: relProps,
    });

    const output = emitNodeTypes(schema);

    expect(output).toContain('export type Book = {');
    expect(output).toContain('export type SearchResult = Book | Author;');
    expect(output).toContain('export type EdgeProps = {');
  });

  it('handles custom scalar type (not built-in, not enum) via mapScalarType fallback', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', {
            properties: new Map([
              ['id', makeProp('id', { type: 'ID', required: true })],
              [
                'metadata',
                makeProp('metadata', { type: 'JSON', required: false }),
              ],
            ]),
          }),
        ],
      ]),
    );

    const output = emitNodeTypes(schema);

    // JSON is not a built-in scalar or enum, so mapScalarType returns 'JSON' directly
    expect(output).toContain('metadata?: Maybe<JSON>;');
  });
});
