import { emitWhereTypes } from '../../src/generator/type-emitters/where-emitter';
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
  overrides: Partial<NodeDefinition> = {},
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
    ...overrides,
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

describe('emitWhereTypes', () => {
  it('emits Where type with scalar operators for node', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', [
            makeProp('id', 'ID', { required: true }),
            makeProp('title', 'String'),
          ]),
        ],
      ]),
    );
    const output = emitWhereTypes(schema);

    expect(output).toContain('export type BookWhere = {');
    expect(output).toContain('id?: InputMaybe<Scalars["ID"]["input"]>');
    expect(output).toContain('id_NOT?');
    expect(output).toContain('id_CONTAINS?');
    expect(output).toContain('title_STARTS_WITH?');
    expect(output).toContain('title_MATCHES?');
    expect(output).toContain('OR?: InputMaybe<Array<BookWhere>>');
    expect(output).toContain('AND?: InputMaybe<Array<BookWhere>>');
    expect(output).toContain('NOT?: InputMaybe<BookWhere>');
  });

  it('omits _MATCHES when stringMatchesFilter is false', () => {
    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', [makeProp('name', 'String')])]]),
    );
    const output = emitWhereTypes(schema, { stringMatchesFilter: false });

    expect(output).not.toContain('_MATCHES');
  });

  it('emits Boolean operators (only exact + _NOT)', () => {
    const schema = makeSchema(
      new Map([
        ['Book', makeNodeDef('Book', [makeProp('isActive', 'Boolean')])],
      ]),
    );
    const output = emitWhereTypes(schema);

    expect(output).toContain('isActive?: InputMaybe');
    expect(output).toContain('isActive_NOT?');
    expect(output).not.toContain('isActive_IN');
    expect(output).not.toContain('isActive_CONTAINS');
  });

  it('emits numeric operators for Int/Float/DateTime', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', [
            makeProp('dose', 'Float'),
            makeProp('quantity', 'Int'),
            makeProp('createdAt', 'DateTime'),
          ]),
        ],
      ]),
    );
    const output = emitWhereTypes(schema);

    expect(output).toContain('dose_LT?');
    expect(output).toContain('dose_LTE?');
    expect(output).toContain('dose_GT?');
    expect(output).toContain('dose_GTE?');
    expect(output).toContain('quantity_LT?');
    expect(output).toContain('createdAt_GT?');
  });

  it('emits enum operators (exact, _NOT, _IN, _NOT_IN only)', () => {
    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', [makeProp('status', 'Status')])]]),
      { enums: new Map([['Status', ['ACTIVE', 'INACTIVE']]]) },
    );
    const output = emitWhereTypes(schema);

    expect(output).toContain('status?: InputMaybe<Status>');
    expect(output).toContain('status_NOT?');
    expect(output).toContain('status_IN?');
    expect(output).toContain('status_NOT_IN?');
    expect(output).not.toContain('status_CONTAINS');
    expect(output).not.toContain('status_LT');
  });

  it('emits relationship operators for array relationships', () => {
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
    const output = emitWhereTypes(schema);

    expect(output).toContain('books?: InputMaybe<BookWhere>');
    expect(output).toContain('books_NOT?');
    expect(output).toContain('books_ALL?');
    expect(output).toContain('books_NONE?');
    expect(output).toContain('books_SINGLE?');
    expect(output).toContain('books_SOME?');
    expect(output).toContain('booksConnection?');
    expect(output).toContain('booksConnection_ALL?');
    expect(output).toContain('booksConnection_SOME?');
    expect(output).toContain('booksAggregate?');
  });

  it('emits limited operators for singular relationships', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef(
            'Book',
            [makeProp('id', 'ID')],
            [
              makeRel({
                fieldName: 'hasStatus',
                type: 'HAS',
                target: 'Status',
                isArray: false,
              }),
            ],
          ),
        ],
        ['Status', makeNodeDef('Status', [makeProp('id', 'ID')])],
      ]),
    );
    const output = emitWhereTypes(schema);

    expect(output).toContain('hasStatus?: InputMaybe<StatusWhere>');
    expect(output).toContain('hasStatus_NOT?');
    expect(output).toContain('hasStatusConnection?');
    expect(output).toContain('hasStatusConnection_NOT?');
    // Singular → no _ALL, _NONE, _SOME, _SINGLE
    expect(output).not.toContain('hasStatus_ALL');
    expect(output).not.toContain('hasStatus_SOME');
  });

  it('emits Interface Where types', () => {
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
    const output = emitWhereTypes(schema);

    expect(output).toContain('export type EntityWhere = {');
    expect(output).toContain('name_CONTAINS?');
    expect(output).toContain('resources_SOME?');
  });

  it('emits RelationshipProperty Where types', () => {
    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', [makeProp('id', 'ID')])]]),
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
    const output = emitWhereTypes(schema);

    expect(output).toContain('export type AuthorBookPropsWhere = {');
    expect(output).toContain('position_LT?');
    expect(output).toContain('position_GTE?');
  });

  it('emits Union Where types (per-member keyed)', () => {
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
    const output = emitWhereTypes(schema);

    expect(output).toContain('export type ChapterTypeWhere = {');
    expect(output).toContain('RangeChapter?: InputMaybe<RangeChapterWhere>');
    expect(output).toContain(
      'StandardChapter?: InputMaybe<StandardChapterWhere>',
    );
  });

  it('uses interface ConnectionWhere when relationship is declared on interface', () => {
    const iface: InterfaceDefinition = {
      name: 'Entity',
      label: 'Entity',
      properties: new Map([['id', makeProp('id', 'ID')]]),
      relationships: new Map([
        [
          'resources',
          makeRel({ fieldName: 'resources', type: 'HAS', target: 'Resource' }),
        ],
      ]),
      implementedBy: ['Organization'],
    };

    const schema = makeSchema(
      new Map([
        [
          'Organization',
          makeNodeDef(
            'Organization',
            [makeProp('id', 'ID')],
            [
              makeRel({
                fieldName: 'resources',
                type: 'HAS',
                target: 'Resource',
              }),
            ],
            { implementsInterfaces: ['Entity'] },
          ),
        ],
        ['Resource', makeNodeDef('Resource', [makeProp('id', 'ID')])],
      ]),
      { interfaces: new Map([['Entity', iface]]) },
    );
    const output = emitWhereTypes(schema);

    // Organization's resources should use Entity-level ConnectionWhere
    expect(output).toContain('EntityResourcesConnectionWhere');
  });

  it('skips @cypher fields that return non-scalar types', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', [
            makeProp('id', 'ID'),
            makeProp('relatedBooks', 'Book', { isCypher: true, isArray: true }),
          ]),
        ],
      ]),
    );
    const output = emitWhereTypes(schema);

    // relatedBooks is @cypher returning Book (a node), should be skipped
    expect(output).not.toContain('relatedBooks?');
  });

  it('includes @cypher fields that return scalar types', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', [
            makeProp('id', 'ID'),
            makeProp('statusName', 'String', { isCypher: true }),
          ]),
        ],
      ]),
    );
    const output = emitWhereTypes(schema);

    // statusName is @cypher returning String (scalar), should be included
    expect(output).toContain('statusName?');
    expect(output).toContain('statusName_CONTAINS?');
  });

  it('handles _IN with required vs optional fields', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', [
            makeProp('id', 'ID', { required: true }),
            makeProp('name', 'String', { required: false }),
          ]),
        ],
      ]),
    );
    const output = emitWhereTypes(schema);

    // Required field: _IN has non-nullable inner type
    expect(output).toMatch(/id_IN\?.*Array<Scalars\["ID"\]\["input"\]>/);
    // Optional field: _IN has nullable inner type
    expect(output).toMatch(
      /name_IN\?.*Array<InputMaybe<Scalars\["String"\]\["input"\]>>/,
    );
  });

  it('sorts multiple interfaces, rel-props, and unions alphabetically', () => {
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
        relationshipProperties: new Map([
          [
            'ZebraProps',
            {
              typeName: 'ZebraProps',
              properties: new Map([['val', makeProp('val', 'Int')]]),
            },
          ],
          [
            'AlphaProps',
            {
              typeName: 'AlphaProps',
              properties: new Map([['val', makeProp('val', 'Int')]]),
            },
          ],
        ]),
        unions: new Map([
          ['ZebraUnion', ['Book']],
          ['AlphaUnion', ['Book']],
        ]),
      },
    );
    const output = emitWhereTypes(schema);

    // Interfaces should be sorted
    const alphaIfaceIdx = output.indexOf('AlphaWhere');
    const zebraIfaceIdx = output.indexOf('ZebraWhere');
    expect(alphaIfaceIdx).toBeLessThan(zebraIfaceIdx);

    // Rel-props should be sorted
    const alphaPropsIdx = output.indexOf('AlphaPropsWhere');
    const zebraPropsIdx = output.indexOf('ZebraPropsWhere');
    expect(alphaPropsIdx).toBeLessThan(zebraPropsIdx);

    // Unions should be sorted
    const alphaUnionIdx = output.indexOf('AlphaUnionWhere');
    const zebraUnionIdx = output.indexOf('ZebraUnionWhere');
    expect(alphaUnionIdx).toBeLessThan(zebraUnionIdx);
  });

  it('treats unknown scalar types as string-like', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', [makeProp('customField', 'CustomScalar')]),
        ],
      ]),
    );
    const output = emitWhereTypes(schema);

    // Unknown scalars should get string-like operators
    expect(output).toContain('customField_CONTAINS?');
    expect(output).toContain('customField_STARTS_WITH?');
    // Should use Scalars["CustomScalar"]["input"] fallback
    expect(output).toContain('Scalars["CustomScalar"]["input"]');
  });

  it('does not emit _MATCHES for ID type even when enabled', () => {
    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', [makeProp('id', 'ID')])]]),
    );
    const output = emitWhereTypes(schema);

    expect(output).not.toContain('id_MATCHES');
  });
});
