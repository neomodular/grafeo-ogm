import { WhereCompiler } from '../src/compilers/where.compiler';
import {
  NodeDefinition,
  RelationshipDefinition,
  SchemaMetadata,
  RelationshipPropertiesDefinition,
} from '../src/schema/types';

// ---------------------------------------------------------------------------
// Test helpers: build minimal schema objects
// ---------------------------------------------------------------------------

function makeNodeDef(
  overrides: Partial<NodeDefinition> & { typeName: string },
): NodeDefinition {
  return {
    label: overrides.typeName,
    labels: [overrides.typeName],
    pluralName: overrides.typeName.toLowerCase() + 's',
    properties: new Map(),
    relationships: new Map(),
    fulltextIndexes: [],
    implementsInterfaces: [],
    ...overrides,
  };
}

function makeRelDef(
  overrides: Partial<RelationshipDefinition> & {
    fieldName: string;
    type: string;
    target: string;
  },
): RelationshipDefinition {
  return {
    direction: 'OUT',
    isArray: true,
    isRequired: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema fixtures
// ---------------------------------------------------------------------------

const statusNode = makeNodeDef({ typeName: 'Status' });
const categoryNode = makeNodeDef({ typeName: 'Category' });
const tagNode = makeNodeDef({ typeName: 'Tag' });

const bookNode = makeNodeDef({
  typeName: 'Book',
  relationships: new Map<string, RelationshipDefinition>([
    [
      'hasStatus',
      makeRelDef({
        fieldName: 'hasStatus',
        type: 'HAS_STATUS',
        target: 'Status',
        direction: 'OUT',
        properties: 'BookStatusProps',
      }),
    ],
    [
      'belongsToCategory',
      makeRelDef({
        fieldName: 'belongsToCategory',
        type: 'BELONGS_TO_CATEGORY',
        target: 'Category',
        direction: 'OUT',
      }),
    ],
    [
      'taggedWith',
      makeRelDef({
        fieldName: 'taggedWith',
        type: 'TAGGED_WITH',
        target: 'Tag',
        direction: 'OUT',
      }),
    ],
  ]),
});

// Category -> Tags (for nested relationship tests)
categoryNode.relationships = new Map<string, RelationshipDefinition>([
  [
    'tags',
    makeRelDef({
      fieldName: 'tags',
      type: 'HAS_TAG',
      target: 'Tag',
      direction: 'OUT',
    }),
  ],
]);

const bookStatusProps: RelationshipPropertiesDefinition = {
  typeName: 'BookStatusProps',
  properties: new Map([
    [
      'endDate',
      {
        name: 'endDate',
        type: 'DateTime',
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
};

// Interface-target fixtures
const entityInterface = {
  name: 'Entity',
  label: 'Entity',
  properties: new Map([
    [
      'id',
      {
        name: 'id',
        type: 'ID',
        required: true,
        isArray: false,
        isListItemRequired: false,
        isGenerated: true,
        isUnique: true,
        isCypher: false,
        directives: ['id'],
      },
    ],
    [
      'name',
      {
        name: 'name',
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
  implementedBy: ['Book', 'Category'],
};

const containerNode = makeNodeDef({
  typeName: 'Container',
  relationships: new Map<string, RelationshipDefinition>([
    [
      'entities',
      makeRelDef({
        fieldName: 'entities',
        type: 'HAS_ENTITY',
        target: 'Entity',
        direction: 'OUT',
      }),
    ],
  ]),
});

const bookCategoryNode = makeNodeDef({
  typeName: 'BookCategory',
  relationships: new Map<string, RelationshipDefinition>([
    [
      'parentCategory',
      makeRelDef({
        fieldName: 'parentCategory',
        type: 'IS_SUBCATEGORY_OF',
        target: 'BookCategory',
        direction: 'OUT',
        isArray: false,
      }),
    ],
    [
      'resource',
      makeRelDef({
        fieldName: 'resource',
        type: 'RESOURCE_BELONGS_TO_BOOK_CATEGORY',
        target: 'BookCategory',
        direction: 'IN',
      }),
    ],
  ]),
});

const schema: SchemaMetadata = {
  nodes: new Map([
    ['Book', bookNode],
    ['Status', statusNode],
    ['Category', categoryNode],
    ['Tag', tagNode],
    ['Container', containerNode],
    ['BookCategory', bookCategoryNode],
  ]),
  interfaces: new Map([['Entity', entityInterface]]),
  relationshipProperties: new Map([['BookStatusProps', bookStatusProps]]),
  enums: new Map(),
  unions: new Map(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WhereCompiler', () => {
  let compiler: WhereCompiler;

  beforeEach(() => {
    compiler = new WhereCompiler(schema);
  });

  // 1. Exact match
  it('should compile exact match', () => {
    const result = compiler.compile({ id: 'abc' }, 'n', bookNode);
    expect(result.cypher).toBe('n.`id` = $param0');
    expect(result.params).toEqual({ param0: 'abc' });
  });

  // 2. _IN operator
  it('should compile _IN operator', () => {
    const result = compiler.compile({ id_IN: ['a', 'b'] }, 'n', bookNode);
    expect(result.cypher).toBe('n.`id` IN $param0');
    expect(result.params).toEqual({ param0: ['a', 'b'] });
  });

  // 3. _NOT operator
  it('should compile _NOT operator', () => {
    const result = compiler.compile({ id_NOT: 'abc' }, 'n', bookNode);
    expect(result.cypher).toBe('n.`id` <> $param0');
    expect(result.params).toEqual({ param0: 'abc' });
  });

  // 4. _NOT_IN operator
  it('should compile _NOT_IN operator', () => {
    const result = compiler.compile({ id_NOT_IN: ['a'] }, 'n', bookNode);
    expect(result.cypher).toBe('NOT n.`id` IN $param0');
    expect(result.params).toEqual({ param0: ['a'] });
  });

  // 5. _CONTAINS operator
  it('should compile _CONTAINS operator', () => {
    const result = compiler.compile({ name_CONTAINS: 'x' }, 'n', bookNode);
    expect(result.cypher).toBe('n.`name` CONTAINS $param0');
    expect(result.params).toEqual({ param0: 'x' });
  });

  // 6. _GTE and _LTE operators
  it('should compile _GTE operator', () => {
    const result = compiler.compile({ createdAt_GTE: '2024' }, 'n', bookNode);
    expect(result.cypher).toBe('n.`createdAt` >= $param0');
    expect(result.params).toEqual({ param0: '2024' });
  });

  it('should compile _LTE operator', () => {
    const result = compiler.compile({ createdAt_LTE: '2024' }, 'n', bookNode);
    expect(result.cypher).toBe('n.`createdAt` <= $param0');
    expect(result.params).toEqual({ param0: '2024' });
  });

  // 7. _MATCHES operator
  it('should compile _MATCHES operator', () => {
    const result = compiler.compile(
      { name_MATCHES: '(?i).*x.*' },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe('n.`name` =~ $param0');
    expect(result.params).toEqual({ param0: '(?i).*x.*' });
  });

  // Additional: _GT, _LT, _STARTS_WITH, _ENDS_WITH
  it('should compile _GT operator', () => {
    const result = compiler.compile({ age_GT: 10 }, 'n', bookNode);
    expect(result.cypher).toBe('n.`age` > $param0');
    expect(result.params).toEqual({ param0: 10 });
  });

  it('should compile _LT operator', () => {
    const result = compiler.compile({ age_LT: 10 }, 'n', bookNode);
    expect(result.cypher).toBe('n.`age` < $param0');
    expect(result.params).toEqual({ param0: 10 });
  });

  it('should compile _STARTS_WITH operator', () => {
    const result = compiler.compile({ name_STARTS_WITH: 'A' }, 'n', bookNode);
    expect(result.cypher).toBe('n.`name` STARTS WITH $param0');
    expect(result.params).toEqual({ param0: 'A' });
  });

  it('should compile _ENDS_WITH operator', () => {
    const result = compiler.compile({ name_ENDS_WITH: 'Z' }, 'n', bookNode);
    expect(result.cypher).toBe('n.`name` ENDS WITH $param0');
    expect(result.params).toEqual({ param0: 'Z' });
  });

  // 8. Multiple conditions (implicit AND)
  it('should compile multiple conditions as implicit AND', () => {
    const result = compiler.compile({ id: 'abc', name: 'Test' }, 'n', bookNode);
    expect(result.cypher).toBe('n.`id` = $param0 AND n.`name` = $param1');
    expect(result.params).toEqual({ param0: 'abc', param1: 'Test' });
  });

  // 9. AND logical operator
  it('should compile AND logical operator', () => {
    const result = compiler.compile(
      { AND: [{ id: 'a' }, { name: 'b' }] },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe('(n.`id` = $param0 AND n.`name` = $param1)');
    expect(result.params).toEqual({ param0: 'a', param1: 'b' });
  });

  // 10. OR logical operator
  it('should compile OR logical operator', () => {
    const result = compiler.compile(
      { OR: [{ id: 'a' }, { id: 'b' }] },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe('(n.`id` = $param0 OR n.`id` = $param1)');
    expect(result.params).toEqual({ param0: 'a', param1: 'b' });
  });

  // 11. NOT logical operator
  it('should compile NOT logical operator', () => {
    const result = compiler.compile({ NOT: { id: 'abc' } }, 'n', bookNode);
    expect(result.cypher).toBe('NOT (n.`id` = $param0)');
    expect(result.params).toEqual({ param0: 'abc' });
  });

  // 12. Relationship _SOME
  it('should compile relationship _SOME', () => {
    const result = compiler.compile(
      { hasStatus_SOME: { name: 'Active' } },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe(
      'EXISTS { MATCH (n)-[:`HAS_STATUS`]->(r0:`Status`) WHERE r0.`name` = $param1 }',
    );
    expect(result.params).toEqual({ param1: 'Active' });
  });

  // 13. Relationship _NONE
  it('should compile relationship _NONE', () => {
    const result = compiler.compile(
      { hasStatus_NONE: { name: 'Inactive' } },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe(
      'NOT EXISTS { MATCH (n)-[:`HAS_STATUS`]->(r0:`Status`) WHERE r0.`name` = $param1 }',
    );
    expect(result.params).toEqual({ param1: 'Inactive' });
  });

  // 14. Nested relationship filters (2+ levels deep)
  it('should compile nested relationship filters', () => {
    const result = compiler.compile(
      {
        belongsToCategory_SOME: {
          tags_SOME: { name: 'urgent' },
        },
      },
      'n',
      bookNode,
    );
    // First level: belongsToCategory -> Category
    // Second level: tags -> Tag
    expect(result.cypher).toBe(
      'EXISTS { MATCH (n)-[:`BELONGS_TO_CATEGORY`]->(r0:`Category`) WHERE EXISTS { MATCH (r0)-[:`HAS_TAG`]->(r1:`Tag`) WHERE r1.`name` = $param2 } }',
    );
    expect(result.params).toEqual({ param2: 'urgent' });
  });

  // 15. Connection _SOME with node filter
  it('should compile connection _SOME with node filter', () => {
    const result = compiler.compile(
      { hasStatusConnection_SOME: { node: { name: 'Active' } } },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe(
      'EXISTS { MATCH (n)-[e0:`HAS_STATUS`]->(r0:`Status`) WHERE r0.`name` = $param1 }',
    );
    expect(result.params).toEqual({ param1: 'Active' });
  });

  // 16. Connection _SOME with edge filter
  it('should compile connection _SOME with edge filter', () => {
    const result = compiler.compile(
      { hasStatusConnection_SOME: { edge: { endDate_GTE: '2024' } } },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe(
      'EXISTS { MATCH (n)-[e0:`HAS_STATUS`]->(r0:`Status`) WHERE e0.`endDate` >= $param1 }',
    );
    expect(result.params).toEqual({ param1: '2024' });
  });

  // 17. Connection _SOME with both node and edge
  it('should compile connection _SOME with both node and edge', () => {
    const result = compiler.compile(
      {
        hasStatusConnection_SOME: {
          node: { name: 'Active' },
          edge: { endDate_GTE: '2024' },
        },
      },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe(
      'EXISTS { MATCH (n)-[e0:`HAS_STATUS`]->(r0:`Status`) WHERE r0.`name` = $param1 AND e0.`endDate` >= $param2 }',
    );
    expect(result.params).toEqual({ param1: 'Active', param2: '2024' });
  });

  // 18. Empty where
  it('should return empty string for empty where', () => {
    const result = compiler.compile({}, 'n', bookNode);
    expect(result.cypher).toBe('');
    expect(result.params).toEqual({});
  });

  // 19. Null/undefined where
  it('should return empty string for null where', () => {
    const result = compiler.compile(null, 'n', bookNode);
    expect(result.cypher).toBe('');
    expect(result.params).toEqual({});
  });

  it('should return empty string for undefined where', () => {
    const result = compiler.compile(undefined, 'n', bookNode);
    expect(result.cypher).toBe('');
    expect(result.params).toEqual({});
  });

  // 20. Parameter counter increments correctly
  it('should increment parameter counter across multiple conditions', () => {
    const counter = { count: 0 };
    compiler.compile({ id: 'a' }, 'n', bookNode, counter);
    expect(counter.count).toBe(1);

    const result2 = compiler.compile({ id: 'b' }, 'n', bookNode, counter);
    expect(result2.cypher).toBe('n.`id` = $param1');
    expect(result2.params).toEqual({ param1: 'b' });
    expect(counter.count).toBe(2);
  });

  // Direction: IN
  it('should handle IN direction relationships', () => {
    const nodeWithInRel = makeNodeDef({
      typeName: 'Status',
      relationships: new Map([
        [
          'usedByBook',
          makeRelDef({
            fieldName: 'usedByBook',
            type: 'HAS_STATUS',
            target: 'Book',
            direction: 'IN',
          }),
        ],
      ]),
    });

    const result = compiler.compile(
      { usedByBook_SOME: { id: '123' } },
      'n',
      nodeWithInRel,
    );
    expect(result.cypher).toBe(
      'EXISTS { MATCH (n)<-[:`HAS_STATUS`]-(r0:`Book`) WHERE r0.`id` = $param1 }',
    );
    expect(result.params).toEqual({ param1: '123' });
  });

  // Max depth exceeded
  it('should throw on max depth exceeded', () => {
    // Build deeply nested NOT structure
    let where: Record<string, unknown> = { id: 'x' };
    for (let i = 0; i < 12; i++) where = { NOT: where };

    expect(() => compiler.compile(where, 'n', bookNode)).toThrow(
      /WHERE clause nesting depth exceeds maximum/,
    );
  });

  // _ALL relationship quantifier (double-negation pattern)
  it('should compile relationship _ALL with double-negation pattern', () => {
    const result = compiler.compile(
      { hasStatus_ALL: { name: 'Active' } },
      'n',
      bookNode,
    );
    expect(result.cypher).toContain('NOT EXISTS');
    expect(result.cypher).toContain('MATCH (n)-[:`HAS_STATUS`]->(');
    expect(result.cypher).toContain('WHERE NOT (');
    expect(result.cypher).toContain('.`name` = $param');
    expect(result.params).toEqual(
      expect.objectContaining({ param1: 'Active' }),
    );
  });

  // _ALL with no inner conditions returns empty
  it('should return empty cypher for _ALL with empty conditions', () => {
    const result = compiler.compile({ hasStatus_ALL: {} }, 'n', bookNode);
    expect(result.cypher).toBe('');
    expect(result.params).toEqual({});
  });

  // _SINGLE relationship quantifier (size(...) = 1 pattern)
  it('should compile relationship _SINGLE with size = 1 pattern', () => {
    const result = compiler.compile(
      { hasStatus_SINGLE: { name: 'Active' } },
      'n',
      bookNode,
    );
    expect(result.cypher).toContain('size(');
    expect(result.cypher).toContain('= 1');
    expect(result.params).toEqual(
      expect.objectContaining({ param1: 'Active' }),
    );
  });

  // GAP-4: Negated string operators
  it('should compile _NOT_CONTAINS operator', () => {
    const result = compiler.compile(
      { name_NOT_CONTAINS: 'aspirin' },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe('NOT n.`name` CONTAINS $param0');
    expect(result.params).toEqual({ param0: 'aspirin' });
  });

  it('should compile _NOT_STARTS_WITH operator', () => {
    const result = compiler.compile(
      { name_NOT_STARTS_WITH: 'A' },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe('NOT n.`name` STARTS WITH $param0');
    expect(result.params).toEqual({ param0: 'A' });
  });

  it('should compile _NOT_ENDS_WITH operator', () => {
    const result = compiler.compile({ name_NOT_ENDS_WITH: 'Z' }, 'n', bookNode);
    expect(result.cypher).toBe('NOT n.`name` ENDS WITH $param0');
    expect(result.params).toEqual({ param0: 'Z' });
  });

  // GAP-5: Connection operator suffixes
  it('should compile bare Connection (exists check)', () => {
    const result = compiler.compile(
      { hasStatusConnection: { node: { name: 'Active' } } },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe(
      'EXISTS { MATCH (n)-[e0:`HAS_STATUS`]->(r0:`Status`) WHERE r0.`name` = $param1 }',
    );
    expect(result.params).toEqual({ param1: 'Active' });
  });

  it('should compile Connection_NONE (NOT EXISTS check)', () => {
    const result = compiler.compile(
      { hasStatusConnection_NONE: { node: { name: 'Inactive' } } },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe(
      'NOT EXISTS { MATCH (n)-[e0:`HAS_STATUS`]->(r0:`Status`) WHERE r0.`name` = $param1 }',
    );
    expect(result.params).toEqual({ param1: 'Inactive' });
  });

  it('should compile Connection_NOT (NOT EXISTS check)', () => {
    const result = compiler.compile(
      { hasStatusConnection_NOT: { node: { name: 'Inactive' } } },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe(
      'NOT EXISTS { MATCH (n)-[e0:`HAS_STATUS`]->(r0:`Status`) WHERE r0.`name` = $param1 }',
    );
    expect(result.params).toEqual({ param1: 'Inactive' });
  });

  it('should compile Connection_ALL (all related nodes match)', () => {
    const result = compiler.compile(
      { hasStatusConnection_ALL: { node: { name: 'Active' } } },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe(
      'NOT EXISTS { MATCH (n)-[e0:`HAS_STATUS`]->(r0:`Status`) WHERE NOT (r0.`name` = $param1) }',
    );
    expect(result.params).toEqual({ param1: 'Active' });
  });

  it('should return empty cypher for Connection_ALL with empty conditions', () => {
    const result = compiler.compile(
      { hasStatusConnection_ALL: {} },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe('');
    expect(result.params).toEqual({});
  });

  it('should compile Connection_SINGLE (exactly one match)', () => {
    const result = compiler.compile(
      { hasStatusConnection_SINGLE: { node: { name: 'Active' } } },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe(
      'size([((n)-[e0:`HAS_STATUS`]->(r0:`Status`) WHERE r0.`name` = $param1 | 1)]) = 1',
    );
    expect(result.params).toEqual({ param1: 'Active' });
  });

  it('should compile Connection_ALL with edge conditions', () => {
    const result = compiler.compile(
      {
        hasStatusConnection_ALL: {
          node: { name: 'Active' },
          edge: { endDate_GTE: '2024' },
        },
      },
      'n',
      bookNode,
    );
    expect(result.cypher).toContain('NOT EXISTS');
    expect(result.cypher).toContain('WHERE NOT (');
    expect(result.cypher).toContain('r0.`name` = $param1');
    expect(result.cypher).toContain('e0.`endDate` >= $param2');
    expect(result.params).toEqual({ param1: 'Active', param2: '2024' });
  });

  // Unknown operator suffix treated as exact match on literal field name
  it('should treat unknown suffix as exact match on the full field name', () => {
    const result = compiler.compile({ name_INVALID: 'test' }, 'n', bookNode);
    // _INVALID is not a known operator, so the whole key "name_INVALID"
    // is treated as a property name with an exact match
    expect(result.cypher).toBe('n.`name_INVALID` = $param0');
    expect(result.params).toEqual({ param0: 'test' });
  });

  // Bare relationship key (no suffix) — treated as _SOME
  it('should compile bare relationship key as _SOME', () => {
    const result = compiler.compile(
      { hasStatus: { name: 'Active' } },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe(
      'EXISTS { MATCH (n)-[:`HAS_STATUS`]->(r0:`Status`) WHERE r0.`name` = $param1 }',
    );
    expect(result.params).toEqual({ param1: 'Active' });
  });

  it('should compile bare relationship key with NOT nested inside', () => {
    const result = compiler.compile(
      { hasStatus: { NOT: { name: 'Deleted' } } },
      'n',
      bookNode,
    );
    expect(result.cypher).toBe(
      'EXISTS { MATCH (n)-[:`HAS_STATUS`]->(r0:`Status`) WHERE NOT (r0.`name` = $param1) }',
    );
    expect(result.params).toEqual({ param1: 'Deleted' });
  });

  // Error paths: target node not found in schema
  it('should throw when connection target node is not in schema', () => {
    const orphanNode = makeNodeDef({
      typeName: 'Orphan',
      relationships: new Map([
        [
          'missingTarget',
          makeRelDef({
            fieldName: 'missingTarget',
            type: 'LINKS_TO',
            target: 'NonExistentNode',
            direction: 'OUT',
          }),
        ],
      ]),
    });

    expect(() =>
      compiler.compile(
        { missingTargetConnection_SOME: { node: { id: '1' } } },
        'n',
        orphanNode,
      ),
    ).toThrow(
      'Invalid connection filter: target type for "missingTarget" is not defined in the schema.',
    );
  });

  it('should throw when relationship target node is not in schema', () => {
    const orphanNode = makeNodeDef({
      typeName: 'Orphan',
      relationships: new Map([
        [
          'missingTarget',
          makeRelDef({
            fieldName: 'missingTarget',
            type: 'LINKS_TO',
            target: 'NonExistentNode',
            direction: 'OUT',
          }),
        ],
      ]),
    });

    expect(() =>
      compiler.compile({ missingTarget_SOME: { id: '1' } }, 'n', orphanNode),
    ).toThrow(
      'Invalid relationship filter: target type for "missingTarget" is not defined in the schema.',
    );
  });

  it('should not treat non-relationship bare key as relationship', () => {
    const result = compiler.compile({ someProp: 'value' }, 'n', bookNode);
    expect(result.cypher).toBe('n.`someProp` = $param0');
    expect(result.params).toEqual({ param0: 'value' });
  });

  // Union relationship filtering
  describe('union relationship WHERE', () => {
    const standardChapterNode = makeNodeDef({
      typeName: 'StandardChapter',
      labels: ['ChapterType', 'StandardChapter'],
    });

    const rangeChapterNode = makeNodeDef({
      typeName: 'RangeChapter',
      labels: ['ChapterType', 'RangeChapter'],
    });

    const doseNode = makeNodeDef({
      typeName: 'Chapter',
      relationships: new Map([
        [
          'chapters',
          makeRelDef({
            fieldName: 'chapters',
            type: 'DOSE_IS_OF_TYPE',
            target: 'ChapterType',
            direction: 'OUT',
          }),
        ],
      ]),
    });

    const unionSchema: SchemaMetadata = {
      nodes: new Map([
        ['Chapter', doseNode],
        ['StandardChapter', standardChapterNode],
        ['RangeChapter', rangeChapterNode],
      ]),
      interfaces: new Map(),
      relationshipProperties: new Map(),
      enums: new Map(),
      unions: new Map([['ChapterType', ['StandardChapter', 'RangeChapter']]]),
    };

    let unionCompiler: WhereCompiler;

    beforeEach(() => {
      unionCompiler = new WhereCompiler(unionSchema);
    });

    it('should compile _SOME on union with single member', () => {
      const result = unionCompiler.compile(
        { chapters_SOME: { StandardChapter: {} } },
        'n',
        doseNode,
      );
      expect(result.cypher).toBe(
        'EXISTS { MATCH (n)-[:`DOSE_IS_OF_TYPE`]->(r0:`StandardChapter`:`ChapterType`) }',
      );
      expect(result.params).toEqual({});
    });

    it('should compile _SOME on union with member property filter', () => {
      const result = unionCompiler.compile(
        { chapters_SOME: { StandardChapter: { value: 10 } } },
        'n',
        doseNode,
      );
      expect(result.cypher).toBe(
        'EXISTS { MATCH (n)-[:`DOSE_IS_OF_TYPE`]->(r0:`StandardChapter`:`ChapterType`) WHERE r0.`value` = $param1 }',
      );
      expect(result.params).toEqual({ param1: 10 });
    });

    it('should compile _SOME on union with multiple members (OR)', () => {
      const result = unionCompiler.compile(
        { chapters_SOME: { StandardChapter: {}, RangeChapter: {} } },
        'n',
        doseNode,
      );
      expect(result.cypher).toContain(
        'EXISTS { MATCH (n)-[:`DOSE_IS_OF_TYPE`]->(r0:`StandardChapter`:`ChapterType`) }',
      );
      expect(result.cypher).toContain(' OR ');
      expect(result.cypher).toContain(
        'EXISTS { MATCH (n)-[:`DOSE_IS_OF_TYPE`]->(r1:`RangeChapter`:`ChapterType`) }',
      );
    });

    it('should compile _NONE on union', () => {
      const result = unionCompiler.compile(
        { chapters_NONE: { StandardChapter: {} } },
        'n',
        doseNode,
      );
      expect(result.cypher).toBe(
        'NOT EXISTS { MATCH (n)-[:`DOSE_IS_OF_TYPE`]->(r0:`StandardChapter`:`ChapterType`) }',
      );
    });

    it('should throw on unknown union member key (security: prevent silent typos)', () => {
      expect(() =>
        unionCompiler.compile(
          { chapters_SOME: { UnknownType: {} } },
          'n',
          doseNode,
        ),
      ).toThrow(/Invalid union member key "UnknownType"/);
    });
  });

  // Complex combined query
  it('should compile a complex combined query', () => {
    const result = compiler.compile(
      {
        name_CONTAINS: 'aspirin',
        OR: [{ id: '1' }, { id: '2' }],
        hasStatus_SOME: { name: 'Active' },
      },
      'n',
      bookNode,
    );

    expect(result.cypher).toContain('n.`name` CONTAINS $param0');
    expect(result.cypher).toContain('(n.`id` = $param1 OR n.`id` = $param2)');
    expect(result.cypher).toContain(
      'EXISTS { MATCH (n)-[:`HAS_STATUS`]->(r3:`Status`) WHERE r3.`name` = $param4 }',
    );
    expect(result.params).toEqual({
      param0: 'aspirin',
      param1: '1',
      param2: '2',
      param4: 'Active',
    });
  });

  // Null value handling
  describe('null value handling', () => {
    it('should compile relationship null as NOT EXISTS (no parent)', () => {
      const result = compiler.compile(
        { parentCategory: null },
        'n',
        bookCategoryNode,
      );
      expect(result.cypher).toBe(
        'NOT EXISTS { MATCH (n)-[:`IS_SUBCATEGORY_OF`]->(r0:`BookCategory`) }',
      );
      expect(result.params).toEqual({});
    });

    it('should compile scalar null as IS NULL', () => {
      const result = compiler.compile({ migrationKey: null }, 'n', bookNode);
      expect(result.cypher).toBe('n.`migrationKey` IS NULL');
      expect(result.params).toEqual({});
    });

    it('should skip undefined values', () => {
      const result = compiler.compile(
        { id: 'abc', name: undefined },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe('n.`id` = $param0');
      expect(result.params).toEqual({ param0: 'abc' });
    });

    it('should compile relationship {NOT: null} as EXISTS (resource exists)', () => {
      const result = compiler.compile(
        { resource: { NOT: null } },
        'n',
        bookCategoryNode,
      );
      // resource (bare) → _SOME → EXISTS { MATCH ... }
      // inner {NOT: null} → NOT compileConditions(null) → empty → no inner WHERE
      expect(result.cypher).toBe(
        'EXISTS { MATCH (n)<-[:`RESOURCE_BELONGS_TO_BOOK_CATEGORY`]-(r0:`BookCategory`) }',
      );
      expect(result.params).toEqual({});
    });

    it('should compile combined null relationship + other conditions', () => {
      const result = compiler.compile(
        {
          parentCategory: null,
          name_CONTAINS: 'test',
          resource: { NOT: null },
        },
        'n',
        bookCategoryNode,
      );
      expect(result.cypher).toContain(
        'NOT EXISTS { MATCH (n)-[:`IS_SUBCATEGORY_OF`]->(r0:`BookCategory`) }',
      );
      expect(result.cypher).toContain('n.`name` CONTAINS $param1');
      expect(result.cypher).toContain(
        'EXISTS { MATCH (n)<-[:`RESOURCE_BELONGS_TO_BOOK_CATEGORY`]-(r2:`BookCategory`) }',
      );
    });

    it('should handle IN-direction relationship null', () => {
      const result = compiler.compile(
        { resource: null },
        'n',
        bookCategoryNode,
      );
      expect(result.cypher).toBe(
        'NOT EXISTS { MATCH (n)<-[:`RESOURCE_BELONGS_TO_BOOK_CATEGORY`]-(r0:`BookCategory`) }',
      );
    });
  });

  describe('interface target resolution', () => {
    it('resolves interface target for _SOME relationship filter', () => {
      const result = compiler.compile(
        { entities_SOME: { name: 'Test' } },
        'n',
        containerNode,
      );
      expect(result.cypher).toBe(
        'EXISTS { MATCH (n)-[:`HAS_ENTITY`]->(r0:`Entity`) WHERE r0.`name` = $param1 }',
      );
      expect(result.params).toEqual({ param1: 'Test' });
    });

    it('resolves interface target for bare relationship name (defaults to _SOME)', () => {
      const result = compiler.compile(
        { entities: { id: '123' } },
        'n',
        containerNode,
      );
      expect(result.cypher).toBe(
        'EXISTS { MATCH (n)-[:`HAS_ENTITY`]->(r0:`Entity`) WHERE r0.`id` = $param1 }',
      );
      expect(result.params).toEqual({ param1: '123' });
    });

    it('resolves interface target for _NONE relationship filter', () => {
      const result = compiler.compile(
        { entities_NONE: { name: 'Hidden' } },
        'n',
        containerNode,
      );
      expect(result.cypher).toBe(
        'NOT EXISTS { MATCH (n)-[:`HAS_ENTITY`]->(r0:`Entity`) WHERE r0.`name` = $param1 }',
      );
      expect(result.params).toEqual({ param1: 'Hidden' });
    });
  });

  // ---------------------------------------------------------------------------
  // Case-insensitive mode
  // ---------------------------------------------------------------------------
  describe('case-insensitive mode', () => {
    it('should wrap exact match in toLower() when mode is insensitive', () => {
      const result = compiler.compile(
        { name: 'Alice', mode: 'insensitive' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe('toLower(n.`name`) = toLower($param0)');
      expect(result.params).toEqual({ param0: 'Alice' });
    });

    it('should wrap _NOT in toLower() when mode is insensitive', () => {
      const result = compiler.compile(
        { name_NOT: 'Alice', mode: 'insensitive' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe('toLower(n.`name`) <> toLower($param0)');
      expect(result.params).toEqual({ param0: 'Alice' });
    });

    it('should wrap _CONTAINS in toLower() when mode is insensitive', () => {
      const result = compiler.compile(
        { name_CONTAINS: 'Search', mode: 'insensitive' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe('toLower(n.`name`) CONTAINS toLower($param0)');
      expect(result.params).toEqual({ param0: 'Search' });
    });

    it('should wrap _STARTS_WITH in toLower() when mode is insensitive', () => {
      const result = compiler.compile(
        { name_STARTS_WITH: 'A', mode: 'insensitive' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe(
        'toLower(n.`name`) STARTS WITH toLower($param0)',
      );
      expect(result.params).toEqual({ param0: 'A' });
    });

    it('should wrap _ENDS_WITH in toLower() when mode is insensitive', () => {
      const result = compiler.compile(
        { name_ENDS_WITH: 'Z', mode: 'insensitive' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe(
        'toLower(n.`name`) ENDS WITH toLower($param0)',
      );
      expect(result.params).toEqual({ param0: 'Z' });
    });

    it('should wrap _NOT_CONTAINS in toLower() when mode is insensitive', () => {
      const result = compiler.compile(
        { name_NOT_CONTAINS: 'bad', mode: 'insensitive' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe(
        'NOT toLower(n.`name`) CONTAINS toLower($param0)',
      );
      expect(result.params).toEqual({ param0: 'bad' });
    });

    it('should wrap _NOT_STARTS_WITH in toLower() when mode is insensitive', () => {
      const result = compiler.compile(
        { name_NOT_STARTS_WITH: 'X', mode: 'insensitive' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe(
        'NOT toLower(n.`name`) STARTS WITH toLower($param0)',
      );
      expect(result.params).toEqual({ param0: 'X' });
    });

    it('should wrap _NOT_ENDS_WITH in toLower() when mode is insensitive', () => {
      const result = compiler.compile(
        { name_NOT_ENDS_WITH: 'Y', mode: 'insensitive' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe(
        'NOT toLower(n.`name`) ENDS WITH toLower($param0)',
      );
      expect(result.params).toEqual({ param0: 'Y' });
    });

    it('should NOT affect _GT, _GTE, _LT, _LTE when mode is insensitive', () => {
      const result = compiler.compile(
        {
          age_GT: 10,
          age_GTE: 5,
          age_LT: 100,
          age_LTE: 50,
          mode: 'insensitive',
        },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe(
        'n.`age` > $param0 AND n.`age` >= $param1 AND n.`age` < $param2 AND n.`age` <= $param3',
      );
      expect(result.params).toEqual({
        param0: 10,
        param1: 5,
        param2: 100,
        param3: 50,
      });
    });

    it('should NOT affect _IN and _NOT_IN when mode is insensitive', () => {
      const result = compiler.compile(
        { id_IN: ['a', 'b'], id_NOT_IN: ['c'], mode: 'insensitive' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe('n.`id` IN $param0 AND NOT n.`id` IN $param1');
      expect(result.params).toEqual({ param0: ['a', 'b'], param1: ['c'] });
    });

    it('should NOT affect _MATCHES when mode is insensitive', () => {
      const result = compiler.compile(
        { name_MATCHES: '.*test.*', mode: 'insensitive' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe('n.`name` =~ $param0');
      expect(result.params).toEqual({ param0: '.*test.*' });
    });

    it('should NOT wrap in toLower() without mode (backward compatible)', () => {
      const result = compiler.compile(
        { name_CONTAINS: 'Search' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe('n.`name` CONTAINS $param0');
      expect(result.params).toEqual({ param0: 'Search' });
    });

    it('should work with nested AND/OR conditions', () => {
      const result = compiler.compile(
        {
          OR: [
            { name_CONTAINS: 'foo', mode: 'insensitive' },
            { name_STARTS_WITH: 'bar', mode: 'insensitive' },
          ],
        },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe(
        '(toLower(n.`name`) CONTAINS toLower($param0) OR toLower(n.`name`) STARTS WITH toLower($param1))',
      );
      expect(result.params).toEqual({ param0: 'foo', param1: 'bar' });
    });

    it('should not include mode key as a Cypher condition', () => {
      const result = compiler.compile(
        { name: 'test', mode: 'insensitive' },
        'n',
        bookNode,
      );
      expect(result.cypher).not.toContain('mode');
      expect(result.cypher).toBe('toLower(n.`name`) = toLower($param0)');
    });
  });

  // ---------------------------------------------------------------------------
  // Disabled operators (WhereCompilerOptions)
  // ---------------------------------------------------------------------------
  describe('disabled operators', () => {
    it('should throw OGMError when _MATCHES is disabled', () => {
      const restrictedCompiler = new WhereCompiler(schema, {
        disabledOperators: new Set(['_MATCHES'] as const),
      });

      expect(() =>
        restrictedCompiler.compile({ name_MATCHES: '.*' }, 'n', bookNode),
      ).toThrow('Operator "_MATCHES" is disabled');
    });

    it('should allow _MATCHES when no options are provided (backward compat)', () => {
      const defaultCompiler = new WhereCompiler(schema);
      const result = defaultCompiler.compile(
        { name_MATCHES: '(?i).*x.*' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe('n.`name` =~ $param0');
    });

    it('should allow _MATCHES when disabledOperators is empty', () => {
      const emptyCompiler = new WhereCompiler(schema, {
        disabledOperators: new Set(),
      });
      const result = emptyCompiler.compile(
        { name_MATCHES: '.*' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe('n.`name` =~ $param0');
    });

    it('should still allow other operators when _MATCHES is disabled', () => {
      const restrictedCompiler = new WhereCompiler(schema, {
        disabledOperators: new Set(['_MATCHES'] as const),
      });
      const result = restrictedCompiler.compile(
        { name_CONTAINS: 'foo' },
        'n',
        bookNode,
      );
      expect(result.cypher).toBe('n.`name` CONTAINS $param0');
    });
  });
});
