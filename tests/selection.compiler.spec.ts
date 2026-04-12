import {
  SelectionCompiler,
  type SelectionNode,
} from '../src/compilers/selection.compiler';
import { WhereCompiler } from '../src/compilers/where.compiler';
import type {
  SchemaMetadata,
  NodeDefinition,
  RelationshipDefinition,
  PropertyDefinition,
} from '../src/schema/types';

// --- Helper factories ---

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

function makeRel(
  overrides: Partial<RelationshipDefinition> &
    Pick<RelationshipDefinition, 'fieldName' | 'type' | 'target'>,
): RelationshipDefinition {
  return {
    direction: 'OUT',
    isArray: true,
    isRequired: false,
    ...overrides,
  };
}

function makeNode(
  typeName: string,
  props: PropertyDefinition[],
  rels: RelationshipDefinition[] = [],
): NodeDefinition {
  const properties = new Map(props.map((p) => [p.name, p]));
  const relationships = new Map(rels.map((r) => [r.fieldName, r]));
  return {
    typeName,
    label: typeName,
    labels: [typeName],
    pluralName: typeName.toLowerCase() + 's',
    properties,
    relationships,
    fulltextIndexes: [],
    implementsInterfaces: [],
  };
}

// --- Mock schema ---

function createMockSchema(): SchemaMetadata {
  const statusNode = makeNode('Status', [
    makeProp('id', 'ID', true),
    makeProp('name', 'String', true),
  ]);

  const tierNode = makeNode('Tier', [
    makeProp('id', 'ID', true),
    makeProp('name', 'String', true),
  ]);

  const resourceNode = makeNode(
    'Resource',
    [makeProp('id', 'ID', true), makeProp('title', 'String', true)],
    [
      makeRel({
        fieldName: 'tiers',
        type: 'GRANTS_ACCESS_TO_RESOURCE',
        target: 'Tier',
        direction: 'OUT',
      }),
    ],
  );

  const bookNode = makeNode(
    'Book',
    [
      makeProp('id', 'ID', true),
      makeProp('title', 'String', true),
      makeProp('description', 'String'),
    ],
    [
      makeRel({
        fieldName: 'hasStatus',
        type: 'DRUG_HAS_STATUS',
        target: 'Status',
        direction: 'OUT',
        isArray: false,
      }),
    ],
  );

  const authorNode = makeNode(
    'Author',
    [makeProp('id', 'ID', true), makeProp('name', 'String', true)],
    [
      makeRel({
        fieldName: 'books',
        type: 'WRITTEN_BY_AUTHOR',
        target: 'Book',
        direction: 'IN',
        properties: 'AuthorBookProps',
      }),
      makeRel({
        fieldName: 'resource',
        type: 'IS_RESOURCE_OF',
        target: 'Resource',
        direction: 'OUT',
        isArray: false,
      }),
      makeRel({
        fieldName: 'hasParentAuthor',
        type: 'HAS_PARENT_CHART',
        target: 'Author',
        direction: 'OUT',
        isArray: false,
      }),
    ],
  );

  const dosePublisherNode = makeNode('ChapterPublisher', [
    makeProp('id', 'ID', true),
    makeProp('publisherName', 'String', true),
  ]);

  const doseNode = makeNode(
    'Chapter',
    [makeProp('id', 'ID', true), makeProp('value', 'Float', true)],
    [
      makeRel({
        fieldName: 'dosePublishers',
        type: 'HAS_CHAPTER_POPULATION',
        target: 'ChapterPublisher',
        direction: 'OUT',
        properties: 'ChapterPublisherProps',
      }),
    ],
  );

  const nodes = new Map<string, NodeDefinition>([
    ['Status', statusNode],
    ['Tier', tierNode],
    ['Resource', resourceNode],
    ['Book', bookNode],
    ['Author', authorNode],
    ['ChapterPublisher', dosePublisherNode],
    ['Chapter', doseNode],
  ]);

  return {
    nodes,
    interfaces: new Map(),
    relationshipProperties: new Map([
      [
        'AuthorBookProps',
        {
          typeName: 'AuthorBookProps',
          properties: new Map([
            ['position', makeProp('position', 'Int', true)],
          ]),
        },
      ],
      [
        'ChapterPublisherProps',
        {
          typeName: 'ChapterPublisherProps',
          properties: new Map([['order', makeProp('order', 'Int', true)]]),
        },
      ],
    ]),
    enums: new Map(),
    unions: new Map(),
  };
}

describe('SelectionCompiler', () => {
  let schema: SchemaMetadata;
  let compiler: SelectionCompiler;

  beforeEach(() => {
    schema = createMockSchema();
    compiler = new SelectionCompiler(schema);
  });

  describe('compile', () => {
    it('should compile scalar fields only', () => {
      const selection: SelectionNode[] = [
        {
          fieldName: 'id',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
        {
          fieldName: 'name',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(selection, 'n', authorDef);

      expect(result).toBe('n { .\`id\`, .\`name\` }');
    });

    it('should compile an array relationship field with pattern comprehension', () => {
      const selection: SelectionNode[] = [
        {
          fieldName: 'books',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
            {
              fieldName: 'title',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(selection, 'n', authorDef);

      // books is direction IN on Author, so arrow should be <-
      expect(result).toBe(
        'n { books: [(n)<-[:\`WRITTEN_BY_AUTHOR\`]-(n0:\`Book\`) | n0 { .\`id\`, .\`title\` }] }',
      );
    });

    it('should compile a singular relationship field with head()', () => {
      const selection: SelectionNode[] = [
        {
          fieldName: 'hasStatus',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
            {
              fieldName: 'name',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const bookDef = schema.nodes.get('Book')!;
      const result = compiler.compile(selection, 'n', bookDef);

      expect(result).toBe(
        'n { hasStatus: head([(n)-[:\`DRUG_HAS_STATUS\`]->(n0:\`Status\`) | n0 { .\`id\`, .\`name\` }]) }',
      );
    });

    it('should compile nested relationships (2 levels deep)', () => {
      const selection: SelectionNode[] = [
        {
          fieldName: 'resource',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
            {
              fieldName: 'tiers',
              isScalar: false,
              isRelationship: true,
              isConnection: false,
              children: [
                {
                  fieldName: 'id',
                  isScalar: true,
                  isRelationship: false,
                  isConnection: false,
                },
                {
                  fieldName: 'name',
                  isScalar: true,
                  isRelationship: false,
                  isConnection: false,
                },
              ],
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(selection, 'n', authorDef);

      expect(result).toBe(
        'n { resource: head([(n)-[:\`IS_RESOURCE_OF\`]->(n0:\`Resource\`) | n0 { .\`id\`, tiers: [(n0)-[:\`GRANTS_ACCESS_TO_RESOURCE\`]->(n1:\`Tier\`) | n1 { .\`id\`, .\`name\` }] }]) }',
      );
    });

    it('should compile connection field with node only', () => {
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
            {
              fieldName: 'title',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(selection, 'n', authorDef);

      expect(result).toBe(
        'n { booksConnection: { edges: [(n)<-[e0:\`WRITTEN_BY_AUTHOR\`]-(n0:\`Book\`) | { node: n0 { .\`id\`, .\`title\` } }] } }',
      );
    });

    it('should compile connection field with node and edge properties', () => {
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
            {
              fieldName: 'title',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
          edgeChildren: [
            {
              fieldName: 'position',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(selection, 'n', authorDef);

      expect(result).toBe(
        'n { booksConnection: { edges: [(n)<-[e0:\`WRITTEN_BY_AUTHOR\`]-(n0:\`Book\`) | { node: n0 { .\`id\`, .\`title\` }, properties: e0 { .\`position\` } }] } }',
      );
    });

    it('should handle IN direction correctly', () => {
      // books on Author is direction IN
      const selection: SelectionNode[] = [
        {
          fieldName: 'books',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(selection, 'n', authorDef);

      expect(result).toContain('(n)<-[:\`WRITTEN_BY_AUTHOR\`]-(n0:\`Book\`)');
    });

    it('should handle OUT direction correctly', () => {
      // hasStatus on Book is direction OUT
      const selection: SelectionNode[] = [
        {
          fieldName: 'hasStatus',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const bookDef = schema.nodes.get('Book')!;
      const result = compiler.compile(selection, 'n', bookDef);

      expect(result).toContain('(n)-[:\`DRUG_HAS_STATUS\`]->(n0:\`Status\`)');
    });

    it('should truncate at max depth and log warning', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Create a deeply nested selection that exceeds depth 1
      const selection: SelectionNode[] = [
        {
          fieldName: 'resource',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
            {
              fieldName: 'tiers',
              isScalar: false,
              isRelationship: true,
              isConnection: false,
              children: [
                {
                  fieldName: 'id',
                  isScalar: true,
                  isRelationship: false,
                  isConnection: false,
                },
              ],
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      // maxDepth=1: resource at depth 0 succeeds, tiers at depth 1 gets truncated
      const result = compiler.compile(selection, 'n', authorDef, 1);

      // resource should render, but tiers should be silently truncated
      expect(result).toContain('resource: head(');
      expect(result).not.toContain('GRANTS_ACCESS_TO_RESOURCE');

      warnSpy.mockRestore();
    });

    it('should return minimal projection for empty selection', () => {
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile([], 'n', authorDef);

      expect(result).toBe('n { .id }');
    });

    it('should handle self-referential relationship', () => {
      const selection: SelectionNode[] = [
        {
          fieldName: 'hasParentAuthor',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
            {
              fieldName: 'name',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(selection, 'n', authorDef);

      expect(result).toBe(
        'n { hasParentAuthor: head([(n)-[:\`HAS_PARENT_CHART\`]->(n0:\`Author\`) | n0 { .\`id\`, .\`name\` }]) }',
      );
    });

    it('should combine scalars, relationships, and connections', () => {
      const selection: SelectionNode[] = [
        {
          fieldName: 'id',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
        {
          fieldName: 'name',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
        {
          fieldName: 'resource',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
          edgeChildren: [
            {
              fieldName: 'position',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(selection, 'n', authorDef);

      expect(result).toContain('.\`id\`');
      expect(result).toContain('.\`name\`');
      expect(result).toContain('resource: head(');
      expect(result).toContain('booksConnection: { edges:');
      expect(result).toContain('properties: e0 { .\`position\` }');
    });
  });

  describe('parseSelectionSet', () => {
    it('should parse scalar fields', () => {
      const nodes = compiler.parseSelectionSet('{ id name }');

      expect(nodes).toHaveLength(2);
      expect(nodes[0]).toMatchObject({
        fieldName: 'id',
        isScalar: true,
        isRelationship: false,
      });
      expect(nodes[1]).toMatchObject({
        fieldName: 'name',
        isScalar: true,
        isRelationship: false,
      });
    });

    it('should parse nested relationship fields', () => {
      const nodes = compiler.parseSelectionSet('{ id books { id title } }');

      expect(nodes).toHaveLength(2);
      expect(nodes[0]).toMatchObject({ fieldName: 'id', isScalar: true });
      expect(nodes[1]).toMatchObject({
        fieldName: 'books',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
      });
      expect(nodes[1].children).toHaveLength(2);
      expect(nodes[1].children![0]).toMatchObject({
        fieldName: 'id',
        isScalar: true,
      });
      expect(nodes[1].children![1]).toMatchObject({
        fieldName: 'title',
        isScalar: true,
      });
    });

    it('should parse connection fields with edges, node, and properties', () => {
      const nodes = compiler.parseSelectionSet(
        '{ booksConnection { edges { node { id title } properties { position } } } }',
      );

      expect(nodes).toHaveLength(1);
      const conn = nodes[0];
      expect(conn.fieldName).toBe('booksConnection');
      expect(conn.isConnection).toBe(true);
      expect(conn.children).toHaveLength(2);
      expect(conn.children![0].fieldName).toBe('id');
      expect(conn.children![1].fieldName).toBe('title');
      expect(conn.edgeChildren).toHaveLength(1);
      expect(conn.edgeChildren![0].fieldName).toBe('position');
    });

    it('should throw on invalid input', () => {
      expect(() => compiler.parseSelectionSet('not valid graphql {{{')).toThrow(
        /Failed to parse selectionSet/,
      );
    });
  });

  describe('compile + parseSelectionSet integration', () => {
    it('should compile a parsed selection set string end-to-end', () => {
      const nodes = compiler.parseSelectionSet(
        '{ id name books { id title } }',
      );
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(nodes, 'n', authorDef);

      expect(result).toBe(
        'n { .\`id\`, .\`name\`, books: [(n)<-[:\`WRITTEN_BY_AUTHOR\`]-(n0:\`Book\`) | n0 { .\`id\`, .\`title\` }] }',
      );
    });
  });

  describe('relationship where filtering', () => {
    let whereCompiler: WhereCompiler;
    let compilerWithWhere: SelectionCompiler;

    beforeEach(() => {
      whereCompiler = new WhereCompiler(schema);
      compilerWithWhere = new SelectionCompiler(schema, whereCompiler);
    });

    it('should inject WHERE clause for relationship with where filter', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'books',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          relationshipWhere: { title_CONTAINS: 'aspirin' },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
            {
              fieldName: 'title',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compilerWithWhere.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).toContain('WHERE');
      expect(result).toContain('n0.\`title\` CONTAINS');
      expect(result).toContain('$');
      // Verify params were populated
      expect(Object.keys(params).length).toBeGreaterThan(0);
      const paramKey = Object.keys(params)[0];
      expect(params[paramKey]).toBe('aspirin');
    });

    it('should inject WHERE with multiple conditions', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'books',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          relationshipWhere: {
            title_STARTS_WITH: 'A',
            description_CONTAINS: 'pain',
          },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compilerWithWhere.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).toContain('WHERE');
      expect(result).toContain('STARTS WITH');
      expect(result).toContain('CONTAINS');
      expect(Object.keys(params)).toHaveLength(2);
    });

    it('should not inject WHERE when relationshipWhere is undefined', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'books',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compilerWithWhere.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).not.toContain('WHERE');
      expect(Object.keys(params)).toHaveLength(0);
    });

    it('should not inject WHERE when relationshipWhere is empty object', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'books',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          relationshipWhere: {},
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compilerWithWhere.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).not.toContain('WHERE');
    });

    it('should work with singular relationship (head() wrapping)', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'hasStatus',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          relationshipWhere: { name: 'Active' },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
            {
              fieldName: 'name',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const bookDef = schema.nodes.get('Book')!;
      const result = compilerWithWhere.compile(
        selection,
        'n',
        bookDef,
        5,
        0,
        params,
        paramCounter,
      );

      // Singular rel → head() wrapping with WHERE inside
      expect(result).toContain('head(');
      expect(result).toContain('WHERE');
      expect(result).toContain('n0.\`name\` =');
    });

    it('should not inject WHERE without WhereCompiler', () => {
      // compiler (without where) should ignore relationshipWhere
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'books',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          relationshipWhere: { title_CONTAINS: 'aspirin' },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).not.toContain('WHERE');
    });
  });

  describe('connection where with WhereCompiler', () => {
    let whereCompiler: WhereCompiler;
    let compilerWithWhere: SelectionCompiler;

    beforeEach(() => {
      whereCompiler = new WhereCompiler(schema);
      compilerWithWhere = new SelectionCompiler(schema, whereCompiler);
    });

    it('should inject WHERE clause in connection using WhereCompiler', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          connectionWhere: { node: { title_CONTAINS: 'aspirin' } },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compilerWithWhere.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).toContain('WHERE');
      expect(result).toContain('n0.\`title\` CONTAINS');
      expect(result).toContain('edges:');
    });

    it('should unwrap { node: {...} } wrapper in connection with WhereCompiler', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          connectionWhere: { node: { title: 'Ibuprofen' } },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compilerWithWhere.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).toContain('WHERE');
      expect(result).toContain('n0.\`title\` =');
    });
  });

  describe('compileSimpleWhere fallback (connection without WhereCompiler)', () => {
    it('should apply simple exact match WHERE via compileSimpleWhere for string value', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          connectionWhere: { node: { title: 'aspirin' } },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).toContain('WHERE');
      expect(result).toContain('n0.\`title\` = $sel_param0');
      expect(params['sel_param0']).toBe('aspirin');
    });

    it('should unwrap { node: { ... } } wrapper in connectionWhere', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          connectionWhere: { node: { id: '123' } },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).toContain('WHERE');
      expect(result).toContain('n0.\`id\` = $sel_param0');
      expect(params['sel_param0']).toBe('123');
    });

    it('should handle _IN operator in connectionWhere', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          connectionWhere: { node: { id_IN: ['a', 'b', 'c'] } },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).toContain('WHERE');
      expect(result).toContain('n0.\`id\` IN $sel_param0');
      expect(params['sel_param0']).toEqual(['a', 'b', 'c']);
    });

    it('should handle number and boolean values in connectionWhere', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          connectionWhere: { node: { id: 42 } },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).toContain('n0.\`id\` = $sel_param0');
      expect(params['sel_param0']).toBe(42);
    });

    it('should handle boolean value in connectionWhere', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          connectionWhere: { node: { id: true } },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).toContain('n0.\`id\` = $sel_param0');
      expect(params['sel_param0']).toBe(true);
    });

    it('should combine multiple conditions with AND', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          connectionWhere: {
            node: { title: 'aspirin', description: 'pain relief' },
          },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).toContain('WHERE');
      expect(result).toContain('AND');
      expect(result).toContain('n0.\`title\` = $sel_param0');
      expect(result).toContain('n0.\`description\` = $sel_param1');
      expect(params['sel_param0']).toBe('aspirin');
      expect(params['sel_param1']).toBe('pain relief');
    });

    it('should omit WHERE clause when connectionWhere has no matchable conditions', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          connectionWhere: { unsupportedField: { nested: 'object' } },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).not.toContain('WHERE');
    });

    it('should throw when params is not provided for connection with connectionWhere', () => {
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          connectionWhere: { node: { id: '123' } },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;

      expect(() => compiler.compile(selection, 'n', authorDef)).toThrow(
        'compileSimpleWhere requires params and paramCounter for safe parameterization',
      );
    });

    it('should handle connectionWhere without node wrapper directly', () => {
      const params: Record<string, unknown> = {};
      const paramCounter = { count: 0 };
      const selection: SelectionNode[] = [
        {
          fieldName: 'booksConnection',
          isScalar: false,
          isRelationship: false,
          isConnection: true,
          connectionWhere: { title: 'ibuprofen' },
          children: [
            {
              fieldName: 'id',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];
      const authorDef = schema.nodes.get('Author')!;
      const result = compiler.compile(
        selection,
        'n',
        authorDef,
        5,
        0,
        params,
        paramCounter,
      );

      expect(result).toContain('WHERE');
      expect(result).toContain('n0.\`title\` = $sel_param0');
      expect(params['sel_param0']).toBe('ibuprofen');
    });
  });

  describe('inline fragment support (union types)', () => {
    let unionSchema: SchemaMetadata;
    let unionCompiler: SelectionCompiler;

    beforeEach(() => {
      const rangeChapter = makeNode('RangeChapter', [
        makeProp('id', 'ID', true),
        makeProp('minValue', 'Float'),
        makeProp('maxValue', 'Float'),
      ]);
      const standardChapter = makeNode('StandardChapter', [
        makeProp('id', 'ID', true),
        makeProp('value', 'Float'),
      ]);
      const doseNode = makeNode(
        'Chapter',
        [makeProp('id', 'ID', true)],
        [
          makeRel({
            fieldName: 'chapters',
            type: 'DOSE_IS_OF_TYPE',
            target: 'ChapterType',
            direction: 'OUT',
          }),
        ],
      );

      unionSchema = {
        nodes: new Map([
          ['RangeChapter', rangeChapter],
          ['StandardChapter', standardChapter],
          ['Chapter', doseNode],
        ]),
        interfaces: new Map(),
        relationshipProperties: new Map(),
        enums: new Map(),
        unions: new Map([['ChapterType', ['RangeChapter', 'StandardChapter']]]),
      };
      unionCompiler = new SelectionCompiler(unionSchema);
    });

    it('should parse inline fragments and merge fields from union members', () => {
      const selectionSet = `{
        __typename
        ... on RangeChapter { minValue maxValue }
        ... on StandardChapter { value }
      }`;
      const parsed = unionCompiler.parseSelectionSet(selectionSet);

      const names = parsed.map((n) => n.fieldName);
      expect(names).toContain('__typename');
      expect(names).toContain('minValue');
      expect(names).toContain('maxValue');
      expect(names).toContain('value');
    });

    it('should deduplicate fields across inline fragments', () => {
      const selectionSet = `{
        id
        ... on RangeChapter { id minValue }
        ... on StandardChapter { id value }
      }`;
      const parsed = unionCompiler.parseSelectionSet(selectionSet);

      const idNodes = parsed.filter((n) => n.fieldName === 'id');
      expect(idNodes).toHaveLength(1);
    });

    it('should compile union-target relationship using merged member properties', () => {
      const selectionSet = `{
        id
        chapters {
          __typename
          ... on RangeChapter { minValue maxValue }
          ... on StandardChapter { value }
        }
      }`;
      const parsed = unionCompiler.parseSelectionSet(selectionSet);
      const doseDef = unionSchema.nodes.get('Chapter')!;
      const result = unionCompiler.compile(parsed, 'n', doseDef);

      expect(result).toContain('.\`id\`');
      expect(result).toContain('chapters:');
      expect(result).toContain('\`DOSE_IS_OF_TYPE\`');
      // __typename for union targets resolves from labels, not a dot-property
      expect(result).toContain(
        "__typename: head([__label IN labels(n0) WHERE __label IN ['RangeChapter', 'StandardChapter']])",
      );
      expect(result).toContain('.\`minValue\`');
      expect(result).toContain('.\`maxValue\`');
      expect(result).toContain('.\`value\`');
    });

    it('should omit union type label from relationship pattern (union names are not Neo4j labels)', () => {
      const selectionSet = `{
        id
        chapters { id }
      }`;
      const parsed = unionCompiler.parseSelectionSet(selectionSet);
      const doseDef = unionSchema.nodes.get('Chapter')!;
      const result = unionCompiler.compile(parsed, 'n', doseDef);

      // Pattern should NOT include :ChapterType label — union names don't exist as Neo4j labels
      expect(result).not.toContain('`ChapterType`');
      // Should still have the relationship type
      expect(result).toContain('`DOSE_IS_OF_TYPE`');
      // Target variable should appear without a label filter
      expect(result).toMatch(/\(n0\)/);
    });

    it('should emit constant __typename for concrete (non-union) types', () => {
      const selectionSet = `{
        id
        __typename
      }`;
      const parsed = unionCompiler.parseSelectionSet(selectionSet);
      const doseDef = unionSchema.nodes.get('Chapter')!;
      const result = unionCompiler.compile(parsed, 'n', doseDef);

      expect(result).toContain('.\`id\`');
      expect(result).toContain("__typename: 'Chapter'");
    });

    it('should resolve __typename from labels inside nested union relationships', () => {
      // Compile just the inner union-target selection directly
      const innerSelectionSet = `{
        __typename
        ... on RangeChapter { minValue }
      }`;
      const parsed = unionCompiler.parseSelectionSet(innerSelectionSet);
      // Create a synthetic union nodeDef (like resolveTargetDef does)
      const syntheticDef = {
        typeName: 'ChapterType',
        label: 'ChapterType',
        labels: ['ChapterType'],
        pluralName: 'dosetypes',
        properties: new Map([['minValue', makeProp('minValue', 'Float')]]),
        relationships: new Map(),
        fulltextIndexes: [],
        implementsInterfaces: [],
      };
      const result = unionCompiler.compile(parsed, 'x', syntheticDef);

      expect(result).toContain(
        "__typename: head([__label IN labels(x) WHERE __label IN ['RangeChapter', 'StandardChapter']])",
      );
      expect(result).toContain('.\`minValue\`');
    });

    it('should return null for relationship with unknown target (not node or union)', () => {
      const orphanNode = makeNode(
        'Orphan',
        [makeProp('id', 'ID', true)],
        [
          makeRel({
            fieldName: 'missing',
            type: 'LINKS_TO',
            target: 'NonExistent',
            direction: 'OUT',
          }),
        ],
      );
      unionSchema.nodes.set('Orphan', orphanNode);

      const parsed = unionCompiler.parseSelectionSet('{ id missing { id } }');
      const result = unionCompiler.compile(parsed, 'n', orphanNode);

      // 'missing' should be skipped since target doesn't exist
      expect(result).toContain('.\`id\`');
      expect(result).not.toContain('missing');
    });

    it('should generate CASE WHEN for union members with different relationship types for same field', () => {
      // Simulate the Icon/IconType pattern: same field "publishers" but
      // different relationship types per union member.
      const publisherNode = makeNode('Publisher', [makeProp('id', 'ID', true)]);
      const formNode = makeNode('Form', [makeProp('id', 'ID', true)]);

      const formPresentationIcon = makeNode(
        'FormPresentationIcon',
        [makeProp('id', 'ID', true)],
        [
          makeRel({
            fieldName: 'publishers',
            type: 'FP_ICON_BELONGS_TO_POP',
            target: 'Publisher',
            direction: 'OUT',
          }),
          makeRel({
            fieldName: 'forms',
            type: 'FP_ICON_FOR_FORM',
            target: 'Form',
            direction: 'IN',
          }),
        ],
      );

      const adminRateIcon = makeNode(
        'AdminRateIcon',
        [makeProp('id', 'ID', true)],
        [
          makeRel({
            fieldName: 'publishers',
            type: 'AR_ICON_BELONGS_TO_POP',
            target: 'Publisher',
            direction: 'OUT',
          }),
        ],
      );

      const iconNode = makeNode(
        'Icon',
        [makeProp('id', 'ID', true)],
        [
          makeRel({
            fieldName: 'type',
            type: 'ICON_REF_TYPE',
            target: 'IconType',
            direction: 'OUT',
          }),
        ],
      );

      const iconSchema: SchemaMetadata = {
        nodes: new Map([
          ['Publisher', publisherNode],
          ['Form', formNode],
          ['FormPresentationIcon', formPresentationIcon],
          ['AdminRateIcon', adminRateIcon],
          ['Icon', iconNode],
        ]),
        interfaces: new Map(),
        relationshipProperties: new Map(),
        enums: new Map(),
        unions: new Map([
          ['IconType', ['FormPresentationIcon', 'AdminRateIcon']],
        ]),
      };

      const iconCompiler = new SelectionCompiler(iconSchema);
      const selectionSet = `{
        id
        type {
          __typename
          ... on FormPresentationIcon { id publishers { id } forms { id } }
          ... on AdminRateIcon { id publishers { id } }
        }
      }`;

      const parsed = iconCompiler.parseSelectionSet(selectionSet);
      const iconDef = iconSchema.nodes.get('Icon')!;
      const result = iconCompiler.compile(parsed, 'n', iconDef);

      // publishers should use CASE WHEN with different relationship types
      expect(result).toContain('CASE');
      expect(result).toContain('WHEN n0:`FormPresentationIcon`');
      expect(result).toContain('WHEN n0:`AdminRateIcon`');
      // Both relationship types should appear
      expect(result).toContain('`FP_ICON_BELONGS_TO_POP`');
      expect(result).toContain('`AR_ICON_BELONGS_TO_POP`');
      // forms only on FormPresentationIcon — single branch still uses CASE WHEN
      // to guard against non-matching member types
      expect(result).toContain('forms:');
      expect(result).toContain('`FP_ICON_FOR_FORM`');
      expect(result).toMatch(/forms: CASE.*WHEN.*FormPresentationIcon/);
      // __typename should use labels-based resolution
      expect(result).toContain('__typename:');
    });

    it('should wrap singular union relationships with head() and use ELSE null', () => {
      const unitNode = makeNode('MeasurementUnit', [
        makeProp('id', 'ID', true),
        makeProp('name', 'String'),
      ]);

      const mixingChapter = makeNode(
        'MixingChapterInitialEdition',
        [makeProp('id', 'ID', true), makeProp('value', 'Float')],
        [
          makeRel({
            fieldName: 'diluentUnit',
            type: 'DILUENT_MEASURED_IN',
            target: 'MeasurementUnit',
            direction: 'OUT',
            isArray: false,
          }),
        ],
      );

      const standardChapter = makeNode('StandardChapter', [
        makeProp('id', 'ID', true),
        makeProp('value', 'Float'),
      ]);

      const doseNode = makeNode(
        'Chapter',
        [makeProp('id', 'ID', true)],
        [
          makeRel({
            fieldName: 'chapters',
            type: 'DOSE_IS_OF_TYPE',
            target: 'ChapterType',
            direction: 'OUT',
          }),
        ],
      );

      const singularSchema: SchemaMetadata = {
        nodes: new Map([
          ['MeasurementUnit', unitNode],
          ['MixingChapterInitialEdition', mixingChapter],
          ['StandardChapter', standardChapter],
          ['Chapter', doseNode],
        ]),
        interfaces: new Map(),
        relationshipProperties: new Map(),
        enums: new Map(),
        unions: new Map([
          ['ChapterType', ['MixingChapterInitialEdition', 'StandardChapter']],
        ]),
      };

      const compiler = new SelectionCompiler(singularSchema);
      const selectionSet = `{
        id
        chapters {
          ... on MixingChapterInitialEdition {
            value
            diluentUnit { id name }
          }
          ... on StandardChapter { value }
        }
      }`;
      const parsed = compiler.parseSelectionSet(selectionSet);
      const doseDef = singularSchema.nodes.get('Chapter')!;
      const result = compiler.compile(parsed, 'n', doseDef);

      // diluentUnit is singular (isArray: false) — must use head()
      expect(result).toContain('head(');
      // Must use CASE WHEN even for single branch
      expect(result).toMatch(
        /diluentUnit: CASE.*WHEN.*MixingChapterInitialEdition.*THEN head\(/,
      );
      // ELSE should be null for singular relationships
      expect(result).toContain('ELSE null END');
    });
  });
});
