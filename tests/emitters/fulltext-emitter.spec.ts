import { emitFulltextTypes } from '../../src/generator/type-emitters/fulltext-emitter';
import type {
  SchemaMetadata,
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  RelationshipPropertiesDefinition,
  FulltextIndex,
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

function makeRel(
  fieldName: string,
  target: string,
  propertiesType?: string,
): RelationshipDefinition {
  return {
    fieldName,
    type: fieldName.toUpperCase(),
    direction: 'OUT',
    target,
    properties: propertiesType,
    isArray: true,
    isRequired: false,
  };
}

function makeNodeDef(
  typeName: string,
  fulltextIndexes: FulltextIndex[] = [],
  relationships: Map<string, RelationshipDefinition> = new Map(),
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [typeName],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map([['id', makeProp('id', 'ID', true)]]),
    relationships,
    fulltextIndexes,
    implementsInterfaces: [],
  };
}

function makeRelProps(
  typeName: string,
  fulltextIndexes: FulltextIndex[] = [],
): RelationshipPropertiesDefinition {
  return {
    typeName,
    properties: new Map(),
    fulltextIndexes,
  };
}

function makeSchema(
  nodes: Map<string, NodeDefinition>,
  relationshipProperties: Map<
    string,
    RelationshipPropertiesDefinition
  > = new Map(),
): SchemaMetadata {
  return {
    nodes,
    interfaces: new Map(),
    relationshipProperties,
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

describe('emitFulltextTypes — per-node typed inputs', () => {
  it('emits <Node>FulltextLeaf with one optional key per node-level index', () => {
    const schema = makeSchema(
      new Map([
        [
          'Drug',
          makeNodeDef('Drug', [
            { name: 'IndicationsFullSearch', fields: ['indications'] },
            { name: 'DrugNameSearch', fields: ['name'] },
          ]),
        ],
      ]),
    );

    const output = emitFulltextTypes(schema);

    expect(output).toContain('export type DrugFulltextLeaf = {');
    expect(output).toContain('IndicationsFullSearch?: FulltextIndexEntry;');
    expect(output).toContain('DrugNameSearch?: FulltextIndexEntry;');
  });

  it('emits <Node>FulltextInput union with OR/AND/NOT composition', () => {
    const schema = makeSchema(
      new Map([
        [
          'Drug',
          makeNodeDef('Drug', [
            { name: 'IndicationsFullSearch', fields: ['indications'] },
          ]),
        ],
      ]),
    );

    const output = emitFulltextTypes(schema);

    expect(output).toContain('export type DrugFulltextInput =');
    expect(output).toContain('| DrugFulltextLeaf');
    expect(output).toContain('| { OR: DrugFulltextInput[] }');
    expect(output).toContain('| { AND: DrugFulltextInput[] }');
    expect(output).toContain('| { NOT: DrugFulltextInput };');
  });

  it('emits the shared FulltextIndexEntry type once', () => {
    const schema = makeSchema(
      new Map([
        [
          'Drug',
          makeNodeDef('Drug', [
            { name: 'IndicationsFullSearch', fields: ['indications'] },
          ]),
        ],
      ]),
    );

    const output = emitFulltextTypes(schema);

    expect(output).toContain('export type FulltextIndexEntry = {');
    expect(output).toContain('phrase: string;');
    expect(output).toContain('score?: number;');

    // Should be declared exactly once even with multiple nodes.
    const matches = output.match(/export type FulltextIndexEntry/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('lifts relationship-level fulltext indexes into nested leaf keys', () => {
    const relationships = new Map<string, RelationshipDefinition>([
      ['categories', makeRel('categories', 'Category', 'InCategory')],
    ]);
    const schema = makeSchema(
      new Map([
        ['Article', makeNodeDef('Article', [], relationships)],
        ['Category', makeNodeDef('Category')],
      ]),
      new Map([
        [
          'InCategory',
          makeRelProps('InCategory', [
            { name: 'CategoryLabelSearch', fields: ['label'] },
          ]),
        ],
      ]),
    );

    const output = emitFulltextTypes(schema);

    expect(output).toContain('export type ArticleFulltextLeaf = {');
    expect(output).toContain(
      'categories?: { CategoryLabelSearch?: FulltextIndexEntry };',
    );
    expect(output).toContain('export type ArticleFulltextInput =');
  });

  it('emits a leaf containing only relationship keys for nodes with no node-level fulltext', () => {
    const relationships = new Map<string, RelationshipDefinition>([
      ['categories', makeRel('categories', 'Category', 'InCategory')],
    ]);
    const schema = makeSchema(
      new Map([
        ['Article', makeNodeDef('Article', [], relationships)],
        ['Category', makeNodeDef('Category')],
      ]),
      new Map([
        [
          'InCategory',
          makeRelProps('InCategory', [
            { name: 'CategoryLabelSearch', fields: ['label'] },
          ]),
        ],
      ]),
    );

    const output = emitFulltextTypes(schema);

    // No node-level index → no ArticleFulltextResult
    expect(output).not.toContain('ArticleFulltextResult');
    // But we DO emit the input types so find() gets typed autocomplete.
    expect(output).toContain('export type ArticleFulltextLeaf = {');
    expect(output).toContain('export type ArticleFulltextInput =');
    expect(output).toContain(
      'categories?: { CategoryLabelSearch?: FulltextIndexEntry };',
    );
  });

  it('omits emission entirely for nodes with no node-level or relationship-level fulltext', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef('Book', [{ name: 'BookSearch', fields: ['title'] }]),
        ],
        ['Category', makeNodeDef('Category')],
      ]),
    );

    const output = emitFulltextTypes(schema);

    expect(output).toContain('BookFulltextLeaf');
    expect(output).toContain('BookFulltextInput');
    expect(output).not.toContain('CategoryFulltextLeaf');
    expect(output).not.toContain('CategoryFulltextInput');
  });

  it('handles non-identifier index names as quoted keys', () => {
    const schema = makeSchema(
      new Map([
        [
          'Weird',
          makeNodeDef('Weird', [
            { name: 'my-dashed-index', fields: ['title'] },
            { name: 'good_name', fields: ['title'] },
          ]),
        ],
      ]),
    );

    const output = emitFulltextTypes(schema);

    expect(output).toContain("'my-dashed-index'?: FulltextIndexEntry;");
    expect(output).toContain('good_name?: FulltextIndexEntry;');
  });

  it('emits valid TypeScript that parses without syntax errors', () => {
    const relationships = new Map<string, RelationshipDefinition>([
      ['categories', makeRel('categories', 'Category', 'InCategory')],
    ]);
    const schema = makeSchema(
      new Map([
        [
          'Drug',
          makeNodeDef(
            'Drug',
            [
              { name: 'IndicationsFullSearch', fields: ['indications'] },
              { name: 'DrugNameSearch', fields: ['name'] },
            ],
            relationships,
          ),
        ],
        ['Category', makeNodeDef('Category')],
      ]),
      new Map([
        [
          'InCategory',
          makeRelProps('InCategory', [
            { name: 'CategoryLabelSearch', fields: ['label'] },
          ]),
        ],
      ]),
    );

    const emitted = emitFulltextTypes(schema);

    // Stub referenced types + mimic what emitUtilityTypes/emitImports provide.
    const source = `type Drug = { id: string };
type Category = { id: string };
type DrugWhere = { id?: string };
type DrugSort = { id?: 'ASC' | 'DESC' };
type SortDirection = 'ASC' | 'DESC';
type Maybe<T> = T | null;
type InputMaybe<T> = Maybe<T>;
type Scalars = { Float: { input: number; output: number } };
${emitted}
`;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ts = require('typescript') as typeof import('typescript');

    const diagnostics: import('typescript').Diagnostic[] = [];
    const host: import('typescript').CompilerHost = {
      fileExists: (fileName: string) => fileName === 'test.ts',
      readFile: (fileName: string) =>
        fileName === 'test.ts' ? source : undefined,
      getSourceFile: (fileName: string, languageVersion) =>
        fileName === 'test.ts'
          ? ts.createSourceFile(fileName, source, languageVersion, true)
          : undefined,
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile: () => undefined,
      getCurrentDirectory: () => '',
      getCanonicalFileName: (fileName: string) => fileName,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
    };

    const program = ts.createProgram(
      ['test.ts'],
      {
        noResolve: true,
        noLib: true,
        strict: true,
        target: ts.ScriptTarget.ES2020,
      },
      host,
    );

    const syntacticDiagnostics = program.getSyntacticDiagnostics(
      program.getSourceFile('test.ts'),
    );
    diagnostics.push(...syntacticDiagnostics);

    expect(diagnostics).toHaveLength(0);
  });
});
