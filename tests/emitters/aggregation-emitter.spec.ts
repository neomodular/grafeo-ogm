import { emitAggregationTypes } from '../../src/generator/type-emitters/aggregation-emitter';
import type {
  SchemaMetadata,
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  InterfaceDefinition,
  RelationshipPropertiesDefinition,
} from '../../src/schema/types';

// --- Helpers ----------------------------------------------------------------

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

function makeNode(
  typeName: string,
  props: PropertyDefinition[],
  rels: RelationshipDefinition[] = [],
  overrides: Partial<NodeDefinition> = {},
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [typeName],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map(props.map((p) => [p.name, p])),
    relationships: new Map(rels.map((r) => [r.fieldName, r])),
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

// --- Tests ------------------------------------------------------------------

describe('emitAggregationTypes', () => {
  it('emits shared aggregate selection types', () => {
    const schema = makeSchema();
    const output = emitAggregationTypes(schema);

    expect(output).toContain('IdAggregateSelection');
    expect(output).toContain('StringAggregateSelection');
    expect(output).toContain('IntAggregateSelection');
    expect(output).toContain('FloatAggregateSelection');
    expect(output).toContain('DateTimeAggregateSelection');
  });

  it('emits node aggregate selection with various scalar types', () => {
    const node = makeNode('Book', [
      makeProp('id', { type: 'ID' }),
      makeProp('title', { type: 'String' }),
      makeProp('dosageCount', { type: 'Int' }),
      makeProp('price', { type: 'Float' }),
      makeProp('createdAt', { type: 'DateTime' }),
    ]);

    const schema = makeSchema({ nodes: new Map([['Book', node]]) });
    const output = emitAggregationTypes(schema);

    expect(output).toContain('BookAggregateSelection');
    expect(output).toContain('id: IdAggregateSelection');
    expect(output).toContain('title: StringAggregateSelection');
    expect(output).toContain('dosageCount: IntAggregateSelection');
    expect(output).toContain('price: FloatAggregateSelection');
    expect(output).toContain('createdAt: DateTimeAggregateSelection');
  });

  it('skips cypher fields in node aggregate selection', () => {
    const node = makeNode('Book', [
      makeProp('id', { type: 'ID' }),
      makeProp('computedField', { type: 'String', isCypher: true }),
    ]);

    const schema = makeSchema({ nodes: new Map([['Book', node]]) });
    const output = emitAggregationTypes(schema);

    expect(output).toContain('id: IdAggregateSelection');
    expect(output).not.toContain('computedField');
  });

  it('skips enum fields in node aggregate selection', () => {
    const node = makeNode('Book', [
      makeProp('id', { type: 'ID' }),
      makeProp('status', { type: 'BookStatus' }),
    ]);

    const schema = makeSchema({
      nodes: new Map([['Book', node]]),
      enums: new Map([['BookStatus', ['ACTIVE', 'INACTIVE']]]),
    });
    const output = emitAggregationTypes(schema);

    expect(output).not.toContain('status: ');
  });

  it('skips Boolean fields (no aggregate type mapping)', () => {
    const node = makeNode('Book', [
      makeProp('id', { type: 'ID' }),
      makeProp('isActive', { type: 'Boolean' }),
    ]);

    const schema = makeSchema({ nodes: new Map([['Book', node]]) });
    const output = emitAggregationTypes(schema);

    expect(output).not.toContain('isActive');
  });

  it('emits relationship aggregation selection without edge', () => {
    const statusNode = makeNode('Status', [makeProp('id', { type: 'ID' })]);
    const relDef: RelationshipDefinition = {
      fieldName: 'hasStatus',
      type: 'HAS_STATUS',
      direction: 'OUT',
      target: 'Status',
      isArray: false,
      isRequired: false,
    };
    const bookNode = makeNode(
      'Book',
      [makeProp('id', { type: 'ID' })],
      [relDef],
    );

    const schema = makeSchema({
      nodes: new Map([
        ['Book', bookNode],
        ['Status', statusNode],
      ]),
    });
    const output = emitAggregationTypes(schema);

    expect(output).toContain('BookStatusHasStatusAggregationSelection');
    expect(output).toContain('count: Scalars["Int"]["output"]');
    expect(output).toContain('BookStatusHasStatusNodeAggregateSelection');
    // No edge aggregate type since rel has no properties
    expect(output).not.toContain('BookStatusHasStatusEdgeAggregateSelection');
  });

  it('emits relationship aggregation selection with edge properties', () => {
    const statusNode = makeNode('Status', [makeProp('id', { type: 'ID' })]);
    const relDef: RelationshipDefinition = {
      fieldName: 'hasStatus',
      type: 'HAS_STATUS',
      direction: 'OUT',
      target: 'Status',
      properties: 'BookStatusEdge',
      isArray: false,
      isRequired: false,
    };
    const bookNode = makeNode(
      'Book',
      [makeProp('id', { type: 'ID' })],
      [relDef],
    );

    const relProps: RelationshipPropertiesDefinition = {
      typeName: 'BookStatusEdge',
      properties: new Map([
        ['priority', makeProp('priority', { type: 'Int' })],
        ['createdAt', makeProp('createdAt', { type: 'DateTime' })],
      ]),
    };

    const schema = makeSchema({
      nodes: new Map([
        ['Book', bookNode],
        ['Status', statusNode],
      ]),
      relationshipProperties: new Map([['BookStatusEdge', relProps]]),
    });
    const output = emitAggregationTypes(schema);

    expect(output).toContain('BookStatusHasStatusAggregationSelection');
    expect(output).toContain('BookStatusHasStatusEdgeAggregateSelection');
    expect(output).toContain('priority: IntAggregateSelection');
    expect(output).toContain('createdAt: DateTimeAggregateSelection');
  });

  it('emits relationship aggregate input types', () => {
    const statusNode = makeNode('Status', [makeProp('id', { type: 'ID' })]);
    const relDef: RelationshipDefinition = {
      fieldName: 'hasStatus',
      type: 'HAS_STATUS',
      direction: 'OUT',
      target: 'Status',
      isArray: false,
      isRequired: false,
    };
    const bookNode = makeNode(
      'Book',
      [makeProp('id', { type: 'ID' })],
      [relDef],
    );

    const schema = makeSchema({
      nodes: new Map([
        ['Book', bookNode],
        ['Status', statusNode],
      ]),
    });
    const output = emitAggregationTypes(schema);

    expect(output).toContain('BookHasStatusAggregateInput');
    expect(output).toContain('count?: InputMaybe<Scalars["Int"]["input"]>');
    expect(output).toContain('count_LT?: InputMaybe<Scalars["Int"]["input"]>');
    expect(output).toContain('count_LTE?: InputMaybe<Scalars["Int"]["input"]>');
    expect(output).toContain('count_GT?: InputMaybe<Scalars["Int"]["input"]>');
    expect(output).toContain('count_GTE?: InputMaybe<Scalars["Int"]["input"]>');
    expect(output).toContain(
      'AND?: InputMaybe<Array<BookHasStatusAggregateInput>>',
    );
    expect(output).toContain(
      'OR?: InputMaybe<Array<BookHasStatusAggregateInput>>',
    );
    expect(output).toContain('NOT?: InputMaybe<BookHasStatusAggregateInput>');
  });

  it('sorts multiple interface aggregate inputs alphabetically', () => {
    const relDef1: RelationshipDefinition = {
      fieldName: 'belongsTo',
      type: 'BELONGS_TO',
      direction: 'OUT',
      target: 'Organization',
      isArray: false,
      isRequired: false,
    };
    const relDef2: RelationshipDefinition = {
      fieldName: 'manages',
      type: 'MANAGES',
      direction: 'OUT',
      target: 'Department',
      isArray: true,
      isRequired: false,
    };

    const ifaceA: InterfaceDefinition = {
      name: 'Zebra',
      label: 'Zebra',
      properties: new Map([['id', makeProp('id', { type: 'ID' })]]),
      relationships: new Map([['belongsTo', relDef1]]),
      implementedBy: ['User'],
    };

    const ifaceB: InterfaceDefinition = {
      name: 'Alpha',
      label: 'Alpha',
      properties: new Map([['id', makeProp('id', { type: 'ID' })]]),
      relationships: new Map([['manages', relDef2]]),
      implementedBy: ['Admin'],
    };

    const schema = makeSchema({
      interfaces: new Map([
        ['Zebra', ifaceA],
        ['Alpha', ifaceB],
      ]),
    });
    const output = emitAggregationTypes(schema);

    // Alpha should appear before Zebra
    const alphaIdx = output.indexOf('AlphaManagesAggregateInput');
    const zebraIdx = output.indexOf('ZebraBelongsToAggregateInput');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(zebraIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(zebraIdx);
  });

  it('emits interface relationship aggregate input types', () => {
    const relDef: RelationshipDefinition = {
      fieldName: 'belongsTo',
      type: 'BELONGS_TO',
      direction: 'OUT',
      target: 'Organization',
      isArray: false,
      isRequired: false,
    };

    const iface: InterfaceDefinition = {
      name: 'Entity',
      label: 'Entity',
      properties: new Map([['id', makeProp('id', { type: 'ID' })]]),
      relationships: new Map([['belongsTo', relDef]]),
      implementedBy: ['User', 'Organization'],
    };

    const schema = makeSchema({
      interfaces: new Map([['Entity', iface]]),
    });
    const output = emitAggregationTypes(schema);

    expect(output).toContain('EntityBelongsToAggregateInput');
    expect(output).toContain('count?: InputMaybe<Scalars["Int"]["input"]>');
    expect(output).toContain(
      'AND?: InputMaybe<Array<EntityBelongsToAggregateInput>>',
    );
    expect(output).toContain(
      'OR?: InputMaybe<Array<EntityBelongsToAggregateInput>>',
    );
    expect(output).toContain('NOT?: InputMaybe<EntityBelongsToAggregateInput>');
  });
});
