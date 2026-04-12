import { SelectNormalizer } from '../src/compilers/select-normalizer';
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
  isCypher = false,
): PropertyDefinition {
  return {
    name,
    type,
    required,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher,
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

  const bookNode = makeNode(
    'Book',
    [
      makeProp('id', 'ID', true),
      makeProp('title', 'String', true),
      makeProp('description', 'String'),
      makeProp('statusName', 'String', false, true), // cypher field
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

describe('SelectNormalizer', () => {
  let schema: SchemaMetadata;
  let normalizer: SelectNormalizer;

  beforeEach(() => {
    schema = createMockSchema();
    normalizer = new SelectNormalizer(schema);
  });

  it('should normalize simple scalar fields', () => {
    const authorDef = schema.nodes.get('Author')!;
    const result = normalizer.normalize({ id: true, name: true }, authorDef);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      fieldName: 'id',
      isScalar: true,
      isRelationship: false,
      isConnection: false,
    });
    expect(result[1]).toMatchObject({
      fieldName: 'name',
      isScalar: true,
      isRelationship: false,
      isConnection: false,
    });
  });

  it('should expand boolean true on relationship to all scalar fields of target', () => {
    const authorDef = schema.nodes.get('Author')!;
    const result = normalizer.normalize({ books: true }, authorDef);

    expect(result).toHaveLength(1);
    const booksNode = result[0];
    expect(booksNode.fieldName).toBe('books');
    expect(booksNode.isRelationship).toBe(true);
    expect(booksNode.isScalar).toBe(false);

    // Book has: id, title, description (statusName is @cypher so excluded)
    const childNames = booksNode.children!.map((c) => c.fieldName);
    expect(childNames).toContain('id');
    expect(childNames).toContain('title');
    expect(childNames).toContain('description');
    expect(childNames).not.toContain('statusName'); // cypher field excluded
    expect(booksNode.children).toHaveLength(3);
  });

  it('should normalize nested select on relationship', () => {
    const authorDef = schema.nodes.get('Author')!;
    const result = normalizer.normalize(
      { books: { select: { id: true, title: true } } },
      authorDef,
    );

    expect(result).toHaveLength(1);
    const booksNode = result[0];
    expect(booksNode.fieldName).toBe('books');
    expect(booksNode.isRelationship).toBe(true);
    expect(booksNode.children).toHaveLength(2);
    expect(booksNode.children![0]).toMatchObject({
      fieldName: 'id',
      isScalar: true,
    });
    expect(booksNode.children![1]).toMatchObject({
      fieldName: 'title',
      isScalar: true,
    });
  });

  it('should normalize connection field with where and nested select', () => {
    const authorDef = schema.nodes.get('Author')!;
    const result = normalizer.normalize(
      {
        booksConnection: {
          where: { title: 'Aspirin' },
          select: {
            edges: {
              node: { select: { id: true, title: true } },
              properties: { select: { position: true } },
            },
          },
        },
      },
      authorDef,
    );

    expect(result).toHaveLength(1);
    const conn = result[0];
    expect(conn.fieldName).toBe('booksConnection');
    expect(conn.isConnection).toBe(true);
    expect(conn.connectionWhere).toEqual({ title: 'Aspirin' });

    expect(conn.children).toHaveLength(2);
    expect(conn.children![0]).toMatchObject({
      fieldName: 'id',
      isScalar: true,
    });
    expect(conn.children![1]).toMatchObject({
      fieldName: 'title',
      isScalar: true,
    });

    expect(conn.edgeChildren).toHaveLength(1);
    expect(conn.edgeChildren![0]).toMatchObject({
      fieldName: 'position',
      isScalar: true,
    });
  });

  it('should skip false and undefined values', () => {
    const authorDef = schema.nodes.get('Author')!;
    const result = normalizer.normalize(
      { id: true, name: false, books: undefined as unknown },
      authorDef,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ fieldName: 'id', isScalar: true });
  });

  it('should return empty array for empty select', () => {
    const authorDef = schema.nodes.get('Author')!;
    const result = normalizer.normalize({}, authorDef);

    expect(result).toHaveLength(0);
  });

  // --- Prisma-like select with where ---

  describe('relationship where filtering', () => {
    it('should extract where clause from relationship with select', () => {
      const authorDef = schema.nodes.get('Author')!;
      const result = normalizer.normalize(
        {
          books: {
            where: { title_CONTAINS: 'aspirin' },
            select: { id: true, title: true },
          },
        },
        authorDef,
      );

      expect(result).toHaveLength(1);
      const booksNode = result[0];
      expect(booksNode.fieldName).toBe('books');
      expect(booksNode.isRelationship).toBe(true);
      expect(booksNode.relationshipWhere).toEqual({
        title_CONTAINS: 'aspirin',
      });
      expect(booksNode.children).toHaveLength(2);
      expect(booksNode.children![0].fieldName).toBe('id');
      expect(booksNode.children![1].fieldName).toBe('title');
    });

    it('should handle where-only (no select) by selecting all scalar fields', () => {
      const authorDef = schema.nodes.get('Author')!;
      const result = normalizer.normalize(
        {
          books: {
            where: { title_STARTS_WITH: 'A' },
          },
        },
        authorDef,
      );

      expect(result).toHaveLength(1);
      const booksNode = result[0];
      expect(booksNode.fieldName).toBe('books');
      expect(booksNode.isRelationship).toBe(true);
      expect(booksNode.relationshipWhere).toEqual({
        title_STARTS_WITH: 'A',
      });
      // Should expand to all scalar fields of Book (excluding cypher)
      const childNames = booksNode.children!.map((c) => c.fieldName);
      expect(childNames).toContain('id');
      expect(childNames).toContain('title');
      expect(childNames).toContain('description');
      expect(childNames).not.toContain('statusName');
    });

    it('should handle where with multiple operators', () => {
      const doseDef = schema.nodes.get('Chapter')!;
      const result = normalizer.normalize(
        {
          dosePublishers: {
            where: { publisherName_CONTAINS: 'Adult', id_NOT: '123' },
            select: { id: true, publisherName: true },
          },
        },
        doseDef,
      );

      expect(result).toHaveLength(1);
      const node = result[0];
      expect(node.relationshipWhere).toEqual({
        publisherName_CONTAINS: 'Adult',
        id_NOT: '123',
      });
    });

    it('should fallback to id field when select is an empty object', () => {
      const authorDef = schema.nodes.get('Author')!;
      const result = normalizer.normalize({ books: { select: {} } }, authorDef);

      expect(result).toHaveLength(1);
      const booksNode = result[0];
      expect(booksNode.children).toHaveLength(1);
      expect(booksNode.children![0].fieldName).toBe('id');
    });

    it('should return null for relationship with unrecognized object value (no select/where)', () => {
      const authorDef = schema.nodes.get('Author')!;
      // Object value with no 'select' or 'where' key
      const result = normalizer.normalize(
        { books: { someUnknownOption: true } },
        authorDef,
      );

      // The normalizeRelationship returns null for this, so it's skipped
      expect(result).toHaveLength(0);
    });

    it('should treat unknown fields as scalars (passthrough)', () => {
      const authorDef = schema.nodes.get('Author')!;
      // 'nonExistent' is not a known property/relationship but treated as scalar
      const result = normalizer.normalize(
        { id: true, nonExistent: true },
        authorDef,
      );

      expect(result).toHaveLength(2);
      expect(result[0].fieldName).toBe('id');
      expect(result[1].fieldName).toBe('nonExistent');
      expect(result[1].isScalar).toBe(true);
    });

    it('should not set relationshipWhere when no where is provided', () => {
      const authorDef = schema.nodes.get('Author')!;
      const result = normalizer.normalize(
        { books: { select: { id: true } } },
        authorDef,
      );

      expect(result).toHaveLength(1);
      expect(result[0].relationshipWhere).toBeUndefined();
    });
  });
});
