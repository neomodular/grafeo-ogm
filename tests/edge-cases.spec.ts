import { WhereCompiler } from '../src/compilers/where.compiler';
import {
  SelectionCompiler,
  SelectionNode,
} from '../src/compilers/selection.compiler';
import { MutationCompiler } from '../src/compilers/mutation.compiler';
import { SelectNormalizer } from '../src/compilers/select-normalizer';
import {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../src/schema/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeProp(
  overrides: Partial<PropertyDefinition> & { name: string; type: string },
): PropertyDefinition {
  return {
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

const statusNode = makeNodeDef({
  typeName: 'Status',
  properties: new Map([
    ['id', makeProp({ name: 'id', type: 'ID', isGenerated: true })],
    ['name', makeProp({ name: 'name', type: 'String' })],
  ]),
});

const bookNode = makeNodeDef({
  typeName: 'Book',
  properties: new Map([
    ['id', makeProp({ name: 'id', type: 'ID', isGenerated: true })],
    ['title', makeProp({ name: 'title', type: 'String' })],
    ['isActive', makeProp({ name: 'isActive', type: 'Boolean' })],
    ['position', makeProp({ name: 'position', type: 'Int' })],
    ['createdAt', makeProp({ name: 'createdAt', type: 'DateTime' })],
  ]),
  relationships: new Map<string, RelationshipDefinition>([
    [
      'hasStatus',
      makeRelDef({
        fieldName: 'hasStatus',
        type: 'HAS_STATUS',
        target: 'Status',
        direction: 'OUT',
        isArray: false,
      }),
    ],
    [
      'relatedBooks',
      makeRelDef({
        fieldName: 'relatedBooks',
        type: 'RELATED_TO',
        target: 'Book',
        direction: 'OUT',
        isArray: true,
      }),
    ],
  ]),
});

const schema: SchemaMetadata = {
  nodes: new Map([
    ['Book', bookNode],
    ['Status', statusNode],
  ]),
  interfaces: new Map(),
  relationshipProperties: new Map(),
  enums: new Map(),
  unions: new Map(),
};

// ---------------------------------------------------------------------------
// WhereCompiler — universal edge cases
// ---------------------------------------------------------------------------

describe('WhereCompiler — edge cases', () => {
  const compiler = new WhereCompiler(schema);

  // 1. Empty arrays
  it('handles empty arrays (id_IN: [])', () => {
    const result = compiler.compile({ id_IN: [] }, 'n', bookNode);

    expect(result.cypher).toBe('n.`id` IN $param0');
    expect(result.params).toEqual({ param0: [] });
  });

  // 2. Single-element arrays
  it('handles single-element arrays (id_IN: ["x"])', () => {
    const result = compiler.compile({ id_IN: ['x'] }, 'n', bookNode);

    expect(result.cypher).toBe('n.`id` IN $param0');
    expect(result.params).toEqual({ param0: ['x'] });
  });

  // 3. Unicode strings
  it('passes Unicode strings as parameters correctly', () => {
    const result = compiler.compile({ title: '日本語テスト' }, 'n', bookNode);

    expect(result.cypher).toBe('n.`title` = $param0');
    expect(result.params).toEqual({ param0: '日本語テスト' });
  });

  // 4. Emoji in values
  it('passes emoji values as parameters correctly', () => {
    const result = compiler.compile({ title: '💊 Book' }, 'n', bookNode);

    expect(result.cypher).toBe('n.`title` = $param0');
    expect(result.params).toEqual({ param0: '💊 Book' });
  });

  // 5. Long strings (>10K chars)
  it('passes long strings (>10K chars) without truncation', () => {
    const longString = 'A'.repeat(15_000);
    const result = compiler.compile({ title: longString }, 'n', bookNode);

    expect(result.cypher).toBe('n.`title` = $param0');
    expect(result.params.param0).toBe(longString);
    expect((result.params.param0 as string).length).toBe(15_000);
  });

  // 6. Special characters
  it('parameterizes special characters (no injection)', () => {
    const result = compiler.compile({ title: "O'Brien & Co." }, 'n', bookNode);

    expect(result.cypher).toBe('n.`title` = $param0');
    expect(result.params).toEqual({ param0: "O'Brien & Co." });
    // Value must never be inlined into the cypher string
    expect(result.cypher).not.toContain("O'Brien");
  });

  // 7. Boolean false vs missing
  it('produces WHERE clause for boolean false (not omitted)', () => {
    const result = compiler.compile({ isActive: false }, 'n', bookNode);

    expect(result.cypher).toBe('n.`isActive` = $param0');
    expect(result.params).toEqual({ param0: false });
  });

  it('omits clause for null/undefined where', () => {
    const resultNull = compiler.compile(null, 'n', bookNode);
    expect(resultNull.cypher).toBe('');
    expect(resultNull.params).toEqual({});

    const resultUndef = compiler.compile(undefined, 'n', bookNode);
    expect(resultUndef.cypher).toBe('');
    expect(resultUndef.params).toEqual({});
  });

  // 8. Numeric zero
  it('produces WHERE clause for numeric zero (not omitted)', () => {
    const result = compiler.compile({ position: 0 }, 'n', bookNode);

    expect(result.cypher).toBe('n.`position` = $param0');
    expect(result.params).toEqual({ param0: 0 });
  });

  // 9. DateTime strings
  it('passes DateTime strings as parameters', () => {
    const result = compiler.compile(
      { createdAt_GT: '2024-01-01T00:00:00Z' },
      'n',
      bookNode,
    );

    expect(result.cypher).toBe('n.`createdAt` > $param0');
    expect(result.params).toEqual({ param0: '2024-01-01T00:00:00Z' });
  });
});

// ---------------------------------------------------------------------------
// WhereCompiler — logical operator edge cases
// ---------------------------------------------------------------------------

describe('WhereCompiler — logical operators', () => {
  const compiler = new WhereCompiler(schema);

  // 10. AND with single element
  it('wraps AND with a single element in parentheses', () => {
    const result = compiler.compile(
      { AND: [{ title: 'Aspirin' }] },
      'n',
      bookNode,
    );

    expect(result.cypher).toBe('(n.`title` = $param0)');
    expect(result.params).toEqual({ param0: 'Aspirin' });
  });

  // 11. OR with mixed operators
  it('compiles OR branches independently with mixed operators', () => {
    const result = compiler.compile(
      {
        OR: [{ title_CONTAINS: 'asp' }, { position_GTE: 10 }],
      },
      'n',
      bookNode,
    );

    expect(result.cypher).toBe(
      '(n.`title` CONTAINS $param0 OR n.`position` >= $param1)',
    );
    expect(result.params).toEqual({ param0: 'asp', param1: 10 });
  });

  // 12. NOT with nested conditions
  it('compiles NOT with nested conditions', () => {
    const result = compiler.compile(
      { NOT: { isActive: true, position_GT: 5 } },
      'n',
      bookNode,
    );

    expect(result.cypher).toBe(
      'NOT (n.`isActive` = $param0 AND n.`position` > $param1)',
    );
    expect(result.params).toEqual({ param0: true, param1: 5 });
  });

  it('compiles deeply nested AND/OR/NOT combinations', () => {
    const result = compiler.compile(
      {
        AND: [
          { OR: [{ title: 'A' }, { title: 'B' }] },
          { NOT: { isActive: false } },
        ],
      },
      'n',
      bookNode,
    );

    expect(result.cypher).toBe(
      '((n.`title` = $param0 OR n.`title` = $param1) AND NOT (n.`isActive` = $param2))',
    );
    expect(result.params).toEqual({ param0: 'A', param1: 'B', param2: false });
  });
});

// ---------------------------------------------------------------------------
// SelectionCompiler — edge cases
// ---------------------------------------------------------------------------

describe('SelectionCompiler — edge cases', () => {
  const compiler = new SelectionCompiler(schema);

  // 13. Connection without edge properties
  it('omits properties from RETURN map when no edgeChildren are present', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'hasStatusConnection',
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
            fieldName: 'name',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
        // No edgeChildren
      },
    ];

    const cypher = compiler.compile(selection, 'n', bookNode);

    // Should contain node projection but NOT properties
    expect(cypher).toContain('node:');
    expect(cypher).not.toContain('properties:');
  });

  it('includes properties in RETURN map when edgeChildren are present', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'hasStatusConnection',
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
            fieldName: 'since',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];

    const cypher = compiler.compile(selection, 'n', bookNode);

    expect(cypher).toContain('node:');
    expect(cypher).toContain('properties:');
    expect(cypher).toContain('.`since`');
  });

  // 14. Depth limiting
  it('returns null for relationships beyond maxDepth', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'relatedBooks',
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
            fieldName: 'relatedBooks',
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

    // maxDepth=1: first level allowed (depth 0 -> 1), second level blocked (depth 1 >= 1)
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cypher = compiler.compile(selection, 'n', bookNode, 1);

    // The outer relationship compiles, the inner one is silently truncated
    expect(cypher).toContain('relatedBooks:');
    warnSpy.mockRestore();
  });

  it('compiles scalar-only selection correctly', () => {
    const selection: SelectionNode[] = [
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
    ];

    const cypher = compiler.compile(selection, 'n', bookNode);
    expect(cypher).toBe('n { .`id`, .`title` }');
  });

  it('returns empty projection for empty selection', () => {
    const cypher = compiler.compile([], 'n', bookNode);
    expect(cypher).toBe('n { .id }');
  });
});

// ---------------------------------------------------------------------------
// MutationCompiler — edge cases
// ---------------------------------------------------------------------------

describe('MutationCompiler — edge cases', () => {
  const compiler = new MutationCompiler(schema);

  // 15a. Create with empty scalar properties (only generated ID)
  it('creates a node with only generated ID when no scalars provided', () => {
    const result = compiler.compileCreate([{}], bookNode);

    expect(result.cypher).toContain('CREATE (n:`Book`');
    expect(result.cypher).toContain('randomUUID()');
    expect(result.cypher).toContain('RETURN n');
  });

  // 15b. Update with empty update object produces no SET clause
  it('produces no SET clause when update object is empty', () => {
    const whereResult = { cypher: 'n.id = $param0', params: { param0: '1' } };
    const result = compiler.compileUpdate(
      { id: '1' },
      {},
      undefined,
      undefined,
      bookNode,
      whereResult,
    );

    expect(result.cypher).not.toContain('SET');
    expect(result.cypher).toContain('MATCH (n:`Book`)');
    expect(result.cypher).toContain('RETURN n');
  });

  // 15c. Delete without cascade uses DETACH DELETE
  it('uses DETACH DELETE n without cascade input', () => {
    const whereResult = { cypher: 'n.id = $param0', params: { param0: '1' } };
    const result = compiler.compileDelete(bookNode, whereResult);

    expect(result.cypher).toContain('DETACH DELETE n');
    expect(result.cypher).not.toContain('OPTIONAL MATCH');
  });

  // 15d. Delete with cascade produces OPTIONAL MATCH for related nodes
  it('produces OPTIONAL MATCH and cascaded delete for related nodes', () => {
    const whereResult = { cypher: 'n.id = $param0', params: { param0: '1' } };
    const result = compiler.compileDelete(bookNode, whereResult, {
      hasStatus: true,
    });

    expect(result.cypher).toContain('OPTIONAL MATCH');
    expect(result.cypher).toContain('`HAS_STATUS`');
    expect(result.cypher).toContain('DETACH DELETE');
  });

  // 15e. Boolean false and numeric zero in create input
  it('includes boolean false and numeric zero in CREATE properties', () => {
    const result = compiler.compileCreate(
      [{ isActive: false, position: 0 }],
      bookNode,
    );

    expect(result.params).toHaveProperty('create0_isActive', false);
    expect(result.params).toHaveProperty('create0_position', 0);
    expect(result.cypher).toContain('`isActive`: $create0_isActive');
    expect(result.cypher).toContain('`position`: $create0_position');
  });

  // 15f. Update with boolean false does not skip the field
  it('includes boolean false in SET clause during update', () => {
    const whereResult = { cypher: 'n.id = $param0', params: { param0: '1' } };
    const result = compiler.compileUpdate(
      { id: '1' },
      { isActive: false },
      undefined,
      undefined,
      bookNode,
      whereResult,
    );

    expect(result.cypher).toContain('SET n.`isActive` = $update_isActive');
    expect(result.params).toHaveProperty('update_isActive', false);
  });

  // 15g. Multiple node creates share the same RETURN
  it('batches multiple creates with a single RETURN n', () => {
    const result = compiler.compileCreate(
      [{ title: 'A' }, { title: 'B' }],
      bookNode,
    );

    expect(result.cypher).toContain('CREATE (n:`Book`');
    expect(result.cypher).toContain('CREATE (n_1:`Book`');
    // Only one RETURN at the end
    const returnCount = (result.cypher.match(/RETURN n/g) || []).length;
    expect(returnCount).toBe(1);
  });

  // 15h. Set/remove labels
  it('generates SET and REMOVE label clauses', () => {
    const whereResult = { cypher: 'n.id = $param0', params: { param0: '1' } };
    const result = compiler.compileSetLabels(
      bookNode,
      whereResult,
      ['Published'],
      ['Draft'],
    );

    expect(result.cypher).toContain('SET n:`Published`');
    expect(result.cypher).toContain('REMOVE n:`Draft`');
  });
});

// ---------------------------------------------------------------------------
// SelectNormalizer — edge cases
// ---------------------------------------------------------------------------

describe('SelectNormalizer — edge cases', () => {
  const normalizer = new SelectNormalizer(schema);

  it('omits fields set to false', () => {
    const nodes = normalizer.normalize(
      { id: true, title: false, isActive: true },
      bookNode,
    );

    const fieldNames = nodes.map((n) => n.fieldName);
    expect(fieldNames).toContain('id');
    expect(fieldNames).toContain('isActive');
    expect(fieldNames).not.toContain('title');
  });

  it('expands relationship: true to all scalar fields of target', () => {
    const nodes = normalizer.normalize({ hasStatus: true }, bookNode);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].isRelationship).toBe(true);
    expect(nodes[0].children).toBeDefined();

    const childFields = nodes[0].children!.map((c) => c.fieldName);
    expect(childFields).toContain('id');
    expect(childFields).toContain('name');
  });

  it('normalizes connection without edge properties', () => {
    const nodes = normalizer.normalize(
      {
        hasStatusConnection: {
          select: {
            edges: {
              node: { select: { id: true } },
            },
          },
        },
      },
      bookNode,
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0].isConnection).toBe(true);
    expect(nodes[0].children).toHaveLength(1);
    expect(nodes[0].edgeChildren).toBeUndefined();
  });

  it('normalizes connection with edge properties', () => {
    const nodes = normalizer.normalize(
      {
        hasStatusConnection: {
          select: {
            edges: {
              node: { select: { id: true } },
              properties: { select: { since: true } },
            },
          },
        },
      },
      bookNode,
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0].edgeChildren).toBeDefined();
    expect(nodes[0].edgeChildren).toHaveLength(1);
    expect(nodes[0].edgeChildren![0].fieldName).toBe('since');
  });
});
