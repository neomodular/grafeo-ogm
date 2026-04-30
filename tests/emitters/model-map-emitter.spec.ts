import {
  emitModelDeclarations,
  emitModelMap,
  emitInterfaceModelMap,
} from '../../src/generator/type-emitters/model-map-emitter';
import type {
  SchemaMetadata,
  NodeDefinition,
  InterfaceDefinition,
  PropertyDefinition,
} from '../../src/schema/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProp(name: string): PropertyDefinition {
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
  };
}

function makeNodeDef(
  typeName: string,
  pluralName: string,
  overrides: Partial<NodeDefinition> = {},
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [],
    pluralName,
    properties: new Map([['id', makeProp('id')]]),
    relationships: new Map(),
    fulltextIndexes: [],
    implementsInterfaces: [],
    ...overrides,
  };
}

function makeInterfaceDef(name: string): InterfaceDefinition {
  return {
    name,
    label: name,
    properties: new Map([
      ['id', makeProp('id')],
      ['name', makeProp('name')],
    ]),
    relationships: new Map(),
    implementedBy: ['User', 'Organization'],
  };
}

function makeSchema(
  nodes: Map<string, NodeDefinition>,
  interfaces: Map<string, InterfaceDefinition> = new Map(),
): SchemaMetadata {
  return {
    nodes,
    interfaces,
    relationshipProperties: new Map(),
    enums: new Map(),
    unions: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emitModelDeclarations', () => {
  it('should emit ModelInterface type for each node', () => {
    const schema = makeSchema(
      new Map([
        ['Book', makeNodeDef('Book', 'books')],
        ['Author', makeNodeDef('Author', 'authors')],
      ]),
    );
    const output = emitModelDeclarations(schema);

    expect(output).toContain('export type AuthorModel = ModelInterface<');
    expect(output).toContain('AuthorSelectFields,');
    expect(output).toContain('AuthorWhere,');
    expect(output).toContain("'authors'");

    expect(output).toContain('export type BookModel = ModelInterface<');
    expect(output).toContain("'books'");
  });

  it('should include MutationSelectFields as 10th generic parameter', () => {
    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', 'books')]]),
    );
    const output = emitModelDeclarations(schema);

    expect(output).toContain('BookMutationSelectFields');
    // Should be the 10th param (after 'books',)
    expect(output).toMatch(/'books',\s*BookMutationSelectFields/);
  });

  it('should include Sort as 11th generic parameter', () => {
    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', 'books')]]),
    );
    const output = emitModelDeclarations(schema);

    expect(output).toContain('BookSort');
    // Should follow MutationSelectFields with a trailing comma
    expect(output).toMatch(/BookMutationSelectFields,\s*BookSort/);
  });

  it('should pass Sort to InterfaceModelInterface', () => {
    const schema = makeSchema(
      new Map([['User', makeNodeDef('User', 'users')]]),
      new Map([['Entity', makeInterfaceDef('Entity')]]),
    );
    const output = emitModelDeclarations(schema);

    expect(output).toContain('EntitySort');
    expect(output).toMatch(/EntityWhere,\s*EntitySort/);
  });

  it('should emit InterfaceModelInterface type for each interface', () => {
    const schema = makeSchema(
      new Map([['User', makeNodeDef('User', 'users')]]),
      new Map([['Entity', makeInterfaceDef('Entity')]]),
    );
    const output = emitModelDeclarations(schema);

    expect(output).toContain(
      'export type EntityModel = InterfaceModelInterface<',
    );
    expect(output).toContain('Entity,');
    expect(output).toContain('EntityWhere');
  });

  it('should sort declarations alphabetically', () => {
    const schema = makeSchema(
      new Map([
        ['Zebra', makeNodeDef('Zebra', 'zebras')],
        ['Apple', makeNodeDef('Apple', 'apples')],
      ]),
    );
    const output = emitModelDeclarations(schema);

    const appleIdx = output.indexOf('AppleModel');
    const zebraIdx = output.indexOf('ZebraModel');
    expect(appleIdx).toBeLessThan(zebraIdx);
  });

  describe('per-node typed fulltext', () => {
    it('nodes without fulltext indexes keep the plain ModelInterface alias', () => {
      const schema = makeSchema(
        new Map([['Category', makeNodeDef('Category', 'categories')]]),
      );
      const output = emitModelDeclarations(schema);

      expect(output).toContain('export type CategoryModel = ModelInterface<');
      // Plain alias ends with the closing angle bracket + semicolon;
      // no `Omit<` wrapper is introduced for this node.
      expect(output).not.toContain('export type CategoryModel = Omit<');
    });

    it('nodes with fulltext indexes get Omit<ModelInterface<...>> + typed fulltext overrides', () => {
      const schema = makeSchema(
        new Map([
          [
            'Drug',
            makeNodeDef('Drug', 'drugs', {
              fulltextIndexes: [
                { name: 'IndicationsFullSearch', fields: ['indications'] },
              ],
            }),
          ],
        ]),
      );
      const output = emitModelDeclarations(schema);

      expect(output).toContain('export type DrugModel = Omit<');
      expect(output).toContain('ModelInterface<');
      expect(output).toContain(
        "'find' | 'findFirst' | 'findFirstOrThrow' | 'count' | 'aggregate'",
      );

      // All five fulltext-accepting methods are re-declared with the
      // per-node input type.
      expect(output).toContain('fulltext?: DrugFulltextInput;');
      expect(output).toMatch(/find\(params\?:/);
      expect(output).toMatch(/findFirst\(params\?:/);
      expect(output).toMatch(/findFirstOrThrow\(params\?:/);
      expect(output).toMatch(/count\(params\?:/);
      expect(output).toMatch(/aggregate\(params:/);

      // The generated signatures should NOT use the loose global FulltextInput.
      expect(output).not.toContain('fulltext?: FulltextInput;');
    });

    it('nodes with only relationship-level fulltext also get the typed override', () => {
      const relationships = new Map([
        [
          'categories',
          {
            fieldName: 'categories',
            type: 'IN_CATEGORY',
            direction: 'OUT' as const,
            target: 'Category',
            properties: 'InCategory',
            isArray: true,
            isRequired: false,
          },
        ],
      ]);

      const schema: SchemaMetadata = {
        nodes: new Map([
          ['Article', makeNodeDef('Article', 'articles', { relationships })],
          ['Category', makeNodeDef('Category', 'categories')],
        ]),
        interfaces: new Map(),
        relationshipProperties: new Map([
          [
            'InCategory',
            {
              typeName: 'InCategory',
              properties: new Map(),
              fulltextIndexes: [
                { name: 'CategoryLabelSearch', fields: ['label'] },
              ],
            },
          ],
        ]),
        enums: new Map(),
        unions: new Map(),
      };

      const output = emitModelDeclarations(schema);

      expect(output).toContain('export type ArticleModel = Omit<');
      expect(output).toContain('fulltext?: ArticleFulltextInput;');

      // Category has no fulltext anywhere → stays plain.
      expect(output).toContain('export type CategoryModel = ModelInterface<');
    });
  });
});

describe('emitModelMap', () => {
  it('should emit ModelMap with node entries', () => {
    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', 'books')]]),
    );
    const output = emitModelMap(schema);

    expect(output).toContain('export type ModelMap = {');
    expect(output).toContain('Book: {');
    expect(output).toContain('Type: Book;');
    expect(output).toContain('Where: BookWhere;');
    expect(output).toContain("PluralKey: 'books';");
  });

  it('should include MutationSelectFields in ModelMap entries', () => {
    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', 'books')]]),
    );
    const output = emitModelMap(schema);

    expect(output).toContain('MutationSelectFields: BookMutationSelectFields;');
  });

  it('should include Sort in ModelMap entries for nodes', () => {
    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', 'books')]]),
    );
    const output = emitModelMap(schema);

    expect(output).toContain('Sort: BookSort;');
  });

  it('should include Sort in ModelMap entries for interfaces', () => {
    const schema = makeSchema(
      new Map([['User', makeNodeDef('User', 'users')]]),
      new Map([['Entity', makeInterfaceDef('Entity')]]),
    );
    const output = emitModelMap(schema);

    expect(output).toContain('Sort: EntitySort;');
  });

  it('should include interfaces in ModelMap with correct type references', () => {
    const schema = makeSchema(
      new Map([['User', makeNodeDef('User', 'users')]]),
      new Map([['Entity', makeInterfaceDef('Entity')]]),
    );
    const output = emitModelMap(schema);

    expect(output).toContain('User: {');
    expect(output).toContain('Entity: {');
    expect(output).toContain('Type: Entity;');
    expect(output).toContain('SelectFields: EntitySelectFields;');
    expect(output).toContain('Where: EntityWhere;');
    expect(output).toContain('CreateInput: Record<string, never>;');
    expect(output).toContain('PluralKey: never;');
  });
});

describe('emitInterfaceModelMap', () => {
  it('should emit InterfaceModelMap with interface entries', () => {
    const schema = makeSchema(
      new Map([['User', makeNodeDef('User', 'users')]]),
      new Map([['Entity', makeInterfaceDef('Entity')]]),
    );
    const output = emitInterfaceModelMap(schema);

    expect(output).toContain('export type InterfaceModelMap = {');
    expect(output).toContain('Entity: {');
    expect(output).toContain('Type: Entity;');
    expect(output).toContain('Where: EntityWhere;');
    expect(output).toContain('Sort: EntitySort;');
  });

  it('should NOT include nodes in InterfaceModelMap', () => {
    const schema = makeSchema(
      new Map([['User', makeNodeDef('User', 'users')]]),
      new Map([['Entity', makeInterfaceDef('Entity')]]),
    );
    const output = emitInterfaceModelMap(schema);

    expect(output).not.toContain('User: {');
  });

  it('should emit empty InterfaceModelMap when no interfaces', () => {
    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', 'books')]]),
    );
    const output = emitInterfaceModelMap(schema);

    expect(output).toBe('export type InterfaceModelMap = {};');
  });

  it('should sort interface entries alphabetically', () => {
    const schema = makeSchema(
      new Map(),
      new Map([
        ['Zebra', makeInterfaceDef('Zebra')],
        ['Alpha', makeInterfaceDef('Alpha')],
      ]),
    );
    const output = emitInterfaceModelMap(schema);

    const alphaIdx = output.indexOf('Alpha: {');
    const zebraIdx = output.indexOf('Zebra: {');
    expect(alphaIdx).toBeLessThan(zebraIdx);
  });
});
