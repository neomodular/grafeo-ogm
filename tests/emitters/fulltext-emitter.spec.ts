import { emitFulltextTypes } from '../../src/generator/type-emitters/fulltext-emitter';
import type {
  SchemaMetadata,
  NodeDefinition,
  PropertyDefinition,
} from '../../src/schema/types';

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

function makeNodeDef(
  typeName: string,
  fulltextIndexes: { name: string; fields: string[] }[] = [],
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [typeName],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map([['id', makeProp('id', 'ID', true)]]),
    relationships: new Map(),
    fulltextIndexes,
    implementsInterfaces: [],
  };
}

function makeSchema(nodes: Map<string, NodeDefinition>): SchemaMetadata {
  return {
    nodes,
    interfaces: new Map(),
    relationshipProperties: new Map(),
    enums: new Map(),
    unions: new Map(),
  };
}

describe('emitFulltextTypes', () => {
  it('returns empty string when no nodes have fulltext indexes', () => {
    const schema = makeSchema(new Map([['Book', makeNodeDef('Book')]]));
    expect(emitFulltextTypes(schema)).toBe('');
  });

  it('emits fulltext types for a single node', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', [{ name: 'BookFullSearch', fields: ['name'] }]),
        ],
      ]),
    );
    const output = emitFulltextTypes(schema);

    expect(output).toContain('FloatWhere');
    expect(output).toContain('BookFulltextResult');
    expect(output).toContain('BookFulltextWhere');
    expect(output).toContain('BookFulltextSort');
    expect(output).toContain('book: Book');
    expect(output).toContain('score: Scalars["Float"]["output"]');
  });

  it('sorts multiple fulltext nodes alphabetically (exercises localeCompare)', () => {
    const schema = makeSchema(
      new Map([
        [
          'Zebra',
          makeNodeDef('Zebra', [{ name: 'ZebraSearch', fields: ['name'] }]),
        ],
        [
          'Alpha',
          makeNodeDef('Alpha', [{ name: 'AlphaSearch', fields: ['name'] }]),
        ],
      ]),
    );
    const output = emitFulltextTypes(schema);

    // Alpha should appear before Zebra (sorted alphabetically)
    const alphaIdx = output.indexOf('AlphaFulltextResult');
    const zebraIdx = output.indexOf('ZebraFulltextResult');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(zebraIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(zebraIdx);
  });

  it('uses camelCase for the field name in result/where/sort types', () => {
    const schema = makeSchema(
      new Map([
        [
          'EquipmentPage',
          makeNodeDef('EquipmentPage', [
            { name: 'EPSearch', fields: ['title'] },
          ]),
        ],
      ]),
    );
    const output = emitFulltextTypes(schema);

    expect(output).toContain('equipmentPage: EquipmentPage');
    expect(output).toContain('equipmentPage?: InputMaybe<EquipmentPageWhere>');
    expect(output).toContain('equipmentPage?: InputMaybe<EquipmentPageSort>');
  });
});
