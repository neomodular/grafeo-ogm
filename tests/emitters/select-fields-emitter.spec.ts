import { emitSelectFieldTypes } from '../../src/generator/type-emitters/select-fields-emitter';
import type {
  SchemaMetadata,
  NodeDefinition,
  InterfaceDefinition,
  PropertyDefinition,
  RelationshipDefinition,
} from '../../src/schema/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProp(
  name: string,
  type = 'String',
  overrides: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return {
    name,
    type,
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
  overrides: Partial<RelationshipDefinition> &
    Pick<RelationshipDefinition, 'fieldName' | 'type' | 'target'>,
): RelationshipDefinition {
  return { direction: 'OUT', isArray: true, isRequired: false, ...overrides };
}

function makeNodeDef(
  typeName: string,
  props: PropertyDefinition[],
  rels: RelationshipDefinition[] = [],
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map(props.map((p) => [p.name, p])),
    relationships: new Map(rels.map((r) => [r.fieldName, r])),
    fulltextIndexes: [],
    implementsInterfaces: [],
  };
}

function makeSchema(
  nodes: Map<string, NodeDefinition>,
  extras: Partial<SchemaMetadata> = {},
): SchemaMetadata {
  return {
    nodes,
    interfaces: new Map(),
    relationshipProperties: new Map(),
    enums: new Map(),
    unions: new Map(),
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emitSelectFieldTypes', () => {
  it('emits SelectFields for node with scalar properties', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', [
            makeProp('id', 'ID'),
            makeProp('name', 'String'),
          ]),
        ],
      ]),
    );
    const output = emitSelectFieldTypes(schema);

    expect(output).toContain('export type BookSelectFields = {');
    expect(output).toContain('id?: boolean;');
    expect(output).toContain('name?: boolean;');
  });

  it('skips @cypher fields', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', [
            makeProp('id', 'ID'),
            makeProp('computed', 'String', { isCypher: true }),
          ]),
        ],
      ]),
    );
    const output = emitSelectFieldTypes(schema);

    expect(output).not.toContain('computed?: boolean');
  });

  it('emits relationship fields with where and select support', () => {
    const schema = makeSchema(
      new Map([
        [
          'Author',
          makeNodeDef(
            'Author',
            [makeProp('id', 'ID')],
            [makeRel({ fieldName: 'books', type: 'HAS', target: 'Book' })],
          ),
        ],
        ['Book', makeNodeDef('Book', [makeProp('id', 'ID')])],
      ]),
    );
    const output = emitSelectFieldTypes(schema);

    expect(output).toContain(
      'books?: boolean | { where?: BookWhere; select?: BookSelectFields }',
    );
  });

  it('emits connection fields with where and edges structure', () => {
    const schema = makeSchema(
      new Map([
        [
          'Author',
          makeNodeDef(
            'Author',
            [makeProp('id', 'ID')],
            [makeRel({ fieldName: 'books', type: 'HAS', target: 'Book' })],
          ),
        ],
        ['Book', makeNodeDef('Book', [makeProp('id', 'ID')])],
      ]),
    );
    const output = emitSelectFieldTypes(schema);

    expect(output).toContain('booksConnection?: boolean | {');
    expect(output).toContain('AuthorBooksConnectionWhere');
    expect(output).toContain('node?: boolean | { select: BookSelectFields }');
  });

  it('emits edge SelectFields and connection properties when relationship has properties', () => {
    const schema = makeSchema(
      new Map([
        [
          'Author',
          makeNodeDef(
            'Author',
            [makeProp('id', 'ID')],
            [
              makeRel({
                fieldName: 'books',
                type: 'HAS',
                target: 'Book',
                properties: 'AuthorBookProps',
              }),
            ],
          ),
        ],
        ['Book', makeNodeDef('Book', [makeProp('id', 'ID')])],
      ]),
      {
        relationshipProperties: new Map([
          [
            'AuthorBookProps',
            {
              typeName: 'AuthorBookProps',
              properties: new Map([['position', makeProp('position', 'Int')]]),
            },
          ],
        ]),
      },
    );
    const output = emitSelectFieldTypes(schema);

    // Edge SelectFields type
    expect(output).toContain('export type AuthorBooksEdgeSelectFields = {');
    expect(output).toContain('position?: boolean;');
    // Connection includes properties option
    expect(output).toContain(
      'properties?: boolean | { select: AuthorBooksEdgeSelectFields }',
    );
  });

  it('emits Interface SelectFields', () => {
    const iface: InterfaceDefinition = {
      name: 'Entity',
      label: 'Entity',
      properties: new Map([
        ['id', makeProp('id', 'ID')],
        ['name', makeProp('name', 'String')],
      ]),
      relationships: new Map([
        [
          'resources',
          makeRel({ fieldName: 'resources', type: 'HAS', target: 'Resource' }),
        ],
      ]),
      implementedBy: ['Organization'],
    };

    const schema = makeSchema(
      new Map([['Resource', makeNodeDef('Resource', [makeProp('id', 'ID')])]]),
      { interfaces: new Map([['Entity', iface]]) },
    );
    const output = emitSelectFieldTypes(schema);

    expect(output).toContain('export type EntitySelectFields = {');
    expect(output).toContain('id?: boolean;');
    expect(output).toContain('name?: boolean;');
    expect(output).toContain(
      'resources?: boolean | { where?: ResourceWhere; select?: ResourceSelectFields }',
    );
    expect(output).toContain('resourcesConnection?: boolean | {');
  });

  it('emits Union SelectFields as type alias of members', () => {
    const schema = makeSchema(
      new Map([
        [
          'StandardChapter',
          makeNodeDef('StandardChapter', [makeProp('id', 'ID')]),
        ],
        ['RangeChapter', makeNodeDef('RangeChapter', [makeProp('id', 'ID')])],
      ]),
      {
        unions: new Map([['ChapterType', ['StandardChapter', 'RangeChapter']]]),
      },
    );
    const output = emitSelectFieldTypes(schema);

    expect(output).toContain(
      'export type ChapterTypeSelectFields = StandardChapterSelectFields | RangeChapterSelectFields;',
    );
  });

  it('sorts multiple interfaces alphabetically', () => {
    const ifaceA: InterfaceDefinition = {
      name: 'Zebra',
      label: 'Zebra',
      properties: new Map([['id', makeProp('id', 'ID')]]),
      relationships: new Map(),
      implementedBy: [],
    };
    const ifaceB: InterfaceDefinition = {
      name: 'Alpha',
      label: 'Alpha',
      properties: new Map([['id', makeProp('id', 'ID')]]),
      relationships: new Map(),
      implementedBy: [],
    };

    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', [makeProp('id', 'ID')])]]),
      {
        interfaces: new Map([
          ['Zebra', ifaceA],
          ['Alpha', ifaceB],
        ]),
        unions: new Map([
          ['ZebraUnion', ['Book']],
          ['AlphaUnion', ['Book']],
        ]),
      },
    );
    const output = emitSelectFieldTypes(schema);

    const alphaIfaceIdx = output.indexOf('AlphaSelectFields');
    const zebraIfaceIdx = output.indexOf('ZebraSelectFields');
    expect(alphaIfaceIdx).toBeLessThan(zebraIfaceIdx);

    const alphaUnionIdx = output.indexOf('AlphaUnionSelectFields');
    const zebraUnionIdx = output.indexOf('ZebraUnionSelectFields');
    expect(alphaUnionIdx).toBeLessThan(zebraUnionIdx);
  });

  it('sorts nodes, interfaces, and unions alphabetically', () => {
    const schema = makeSchema(
      new Map([
        ['Zebra', makeNodeDef('Zebra', [makeProp('id', 'ID')])],
        ['Apple', makeNodeDef('Apple', [makeProp('id', 'ID')])],
      ]),
    );
    const output = emitSelectFieldTypes(schema);

    const appleIdx = output.indexOf('AppleSelectFields');
    const zebraIdx = output.indexOf('ZebraSelectFields');
    expect(appleIdx).toBeLessThan(zebraIdx);
  });
});
