import { emitInputTypes } from '../../src/generator/type-emitters/input-emitter';
import type {
  SchemaMetadata,
  NodeDefinition,
  InterfaceDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  RelationshipPropertiesDefinition,
} from '../../src/schema/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeRel(
  overrides: Partial<RelationshipDefinition>,
): RelationshipDefinition {
  return {
    fieldName: 'items',
    type: 'HAS_ITEM',
    direction: 'OUT',
    target: 'Item',
    isArray: true,
    isRequired: false,
    ...overrides,
  };
}

function makeNodeDef(
  typeName: string,
  props: Map<string, PropertyDefinition> = new Map([['id', makeProp('id')]]),
  rels: Map<string, RelationshipDefinition> = new Map(),
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [],
    pluralName: typeName.toLowerCase() + 's',
    properties: props,
    relationships: rels,
    fulltextIndexes: [],
    implementsInterfaces: [],
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emitInputTypes', () => {
  // -----------------------------------------------------------------------
  // Basic scalar properties
  // -----------------------------------------------------------------------

  describe('basic node with scalar properties', () => {
    const schema = makeSchema({
      nodes: new Map([
        [
          'Book',
          makeNodeDef(
            'Book',
            new Map<string, PropertyDefinition>([
              ['id', makeProp('id', { type: 'ID', isGenerated: true })],
              ['name', makeProp('name', { type: 'String', required: true })],
              ['description', makeProp('description', { type: 'String' })],
              ['tags', makeProp('tags', { type: 'String', isArray: true })],
              ['computedField', makeProp('computedField', { isCypher: true })],
            ]),
          ),
        ],
      ]),
    });

    it('should emit CreateInput excluding generated and cypher fields', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type BookCreateInput = {');
      // required scalar
      expect(output).toContain('  name: Scalars["String"]["input"];');
      // optional scalar
      expect(output).toContain(
        '  description?: InputMaybe<Scalars["String"]["input"]>;',
      );
      // array scalar
      expect(output).toContain(
        '  tags?: InputMaybe<Array<Scalars["String"]["input"]>>;',
      );
      // excluded generated
      expect(output).not.toMatch(/BookCreateInput[^}]*\bid\b/);
      // excluded cypher
      expect(output).not.toMatch(/BookCreateInput[^}]*computedField/);
    });

    it('should emit UpdateInput with all scalar fields optional', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type BookUpdateInput = {');
      expect(output).toContain(
        '  name?: InputMaybe<Scalars["String"]["input"]>;',
      );
      expect(output).toContain(
        '  description?: InputMaybe<Scalars["String"]["input"]>;',
      );
      expect(output).toContain(
        '  tags?: InputMaybe<Array<Scalars["String"]["input"]>>;',
      );
    });

    it('should NOT emit ConnectInput, DisconnectInput, DeleteInput for node with no relationships', () => {
      const output = emitInputTypes(schema);

      expect(output).not.toContain('BookConnectInput');
      expect(output).not.toContain('BookDisconnectInput');
      expect(output).not.toContain('BookDeleteInput');
    });
  });

  // -----------------------------------------------------------------------
  // Enum scalar mapping
  // -----------------------------------------------------------------------

  describe('enum scalar mapping', () => {
    it('should map enum type names directly (not as Scalars)', () => {
      const schema = makeSchema({
        nodes: new Map([
          [
            'Book',
            makeNodeDef(
              'Book',
              new Map<string, PropertyDefinition>([
                [
                  'status',
                  makeProp('status', { type: 'Status', required: true }),
                ],
                ['priority', makeProp('priority', { type: 'Priority' })],
              ]),
            ),
          ],
        ]),
        enums: new Map([
          ['Status', ['ACTIVE', 'INACTIVE']],
          ['Priority', ['HIGH', 'LOW']],
        ]),
      });

      const output = emitInputTypes(schema);

      // Required enum
      expect(output).toContain('  status: Status;');
      // Optional enum
      expect(output).toContain('  priority?: InputMaybe<Priority>;');
    });
  });

  // -----------------------------------------------------------------------
  // Singular relationship (isArray: false)
  // -----------------------------------------------------------------------

  describe('singular relationship (isArray: false)', () => {
    const schema = makeSchema({
      nodes: new Map([
        [
          'Book',
          makeNodeDef(
            'Book',
            new Map([['id', makeProp('id')]]),
            new Map([
              [
                'hasStatus',
                makeRel({
                  fieldName: 'hasStatus',
                  type: 'HAS_STATUS',
                  target: 'Status',
                  isArray: false,
                }),
              ],
            ]),
          ),
        ],
        ['Status', makeNodeDef('Status')],
      ]),
    });

    it('should emit FieldInput with singular connect/create', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type BookHasStatusFieldInput = {');
      expect(output).toContain(
        '  connect?: InputMaybe<BookHasStatusConnectFieldInput>;',
      );
      expect(output).toContain(
        '  create?: InputMaybe<BookHasStatusCreateFieldInput>;',
      );
    });

    it('should emit CreateInput referencing FieldInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        '  hasStatus?: InputMaybe<BookHasStatusFieldInput>;',
      );
    });

    it('should emit UpdateInput with singular UpdateFieldInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        '  hasStatus?: InputMaybe<BookHasStatusUpdateFieldInput>;',
      );
      // Should NOT be wrapped in Array
      expect(output).not.toContain('Array<BookHasStatusUpdateFieldInput>');
    });

    it('should emit ConnectInput with singular ConnectFieldInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type BookConnectInput = {');
      expect(output).toContain(
        '  hasStatus?: InputMaybe<BookHasStatusConnectFieldInput>;',
      );
    });

    it('should emit DisconnectInput with singular DisconnectFieldInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type BookDisconnectInput = {');
      expect(output).toContain(
        '  hasStatus?: InputMaybe<BookHasStatusDisconnectFieldInput>;',
      );
    });

    it('should emit DeleteInput with singular DeleteFieldInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type BookDeleteInput = {');
      expect(output).toContain(
        '  hasStatus?: InputMaybe<BookHasStatusDeleteFieldInput>;',
      );
    });

    it('should emit UpdateFieldInput with singular connect/disconnect/create/delete', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type BookHasStatusUpdateFieldInput = {');
      expect(output).toContain(
        '  connect?: InputMaybe<BookHasStatusConnectFieldInput>;',
      );
      expect(output).toContain(
        '  disconnect?: InputMaybe<BookHasStatusDisconnectFieldInput>;',
      );
      expect(output).toContain(
        '  create?: InputMaybe<BookHasStatusCreateFieldInput>;',
      );
      expect(output).toContain(
        '  delete?: InputMaybe<BookHasStatusDeleteFieldInput>;',
      );
    });

    it('should emit ConnectFieldInput without connect field when target has no relationships', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type BookHasStatusConnectFieldInput = {',
      );
      expect(output).toContain('  where?: InputMaybe<StatusConnectWhere>;');
      expect(output).toContain('  overwrite?: Scalars["Boolean"]["input"];');
      // Status has no relationships → no connect field
      expect(output).not.toContain(
        '  connect?: InputMaybe<StatusConnectInput>;',
      );
    });

    it('should emit ConnectWhere for target node', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type StatusConnectWhere = {');
      expect(output).toContain('  node: StatusWhere;');
    });

    it('should emit DisconnectFieldInput without disconnect field when target has no relationships', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type BookHasStatusDisconnectFieldInput = {',
      );
      expect(output).toContain(
        '  where?: InputMaybe<BookHasStatusConnectionWhere>;',
      );
      // Status has no relationships → no disconnect field
      expect(output).not.toContain(
        '  disconnect?: InputMaybe<StatusDisconnectInput>;',
      );
    });

    it('should emit DeleteFieldInput without delete field when target has no relationships', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type BookHasStatusDeleteFieldInput = {');
      expect(output).toContain(
        '  where?: InputMaybe<BookHasStatusConnectionWhere>;',
      );
      // Status has no relationships → no delete field
      expect(output).not.toContain('  delete?: InputMaybe<StatusDeleteInput>;');
    });

    it('should emit UpdateConnectionInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type BookHasStatusUpdateConnectionInput = {',
      );
      expect(output).toContain('  node?: InputMaybe<StatusUpdateInput>;');
    });
  });

  // -----------------------------------------------------------------------
  // Array relationship (isArray: true)
  // -----------------------------------------------------------------------

  describe('array relationship (isArray: true)', () => {
    const schema = makeSchema({
      nodes: new Map([
        [
          'Author',
          makeNodeDef(
            'Author',
            new Map([['id', makeProp('id')]]),
            new Map([
              [
                'books',
                makeRel({
                  fieldName: 'books',
                  type: 'HAS_DRUG',
                  target: 'Book',
                  isArray: true,
                }),
              ],
            ]),
          ),
        ],
        ['Book', makeNodeDef('Book')],
      ]),
    });

    it('should emit FieldInput with Array-wrapped connect/create', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type AuthorBooksFieldInput = {');
      expect(output).toContain(
        '  connect?: InputMaybe<Array<AuthorBooksConnectFieldInput>>;',
      );
      expect(output).toContain(
        '  create?: InputMaybe<Array<AuthorBooksCreateFieldInput>>;',
      );
    });

    it('should emit UpdateInput with Array-wrapped UpdateFieldInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        '  books?: InputMaybe<Array<AuthorBooksUpdateFieldInput>>;',
      );
    });

    it('should emit ConnectInput with Array-wrapped ConnectFieldInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type AuthorConnectInput = {');
      expect(output).toContain(
        '  books?: InputMaybe<Array<AuthorBooksConnectFieldInput>>;',
      );
    });

    it('should emit DisconnectInput with Array-wrapped DisconnectFieldInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        '  books?: InputMaybe<Array<AuthorBooksDisconnectFieldInput>>;',
      );
    });

    it('should emit DeleteInput with Array-wrapped DeleteFieldInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        '  books?: InputMaybe<Array<AuthorBooksDeleteFieldInput>>;',
      );
    });

    it('should emit UpdateFieldInput with Array-wrapped sub-fields', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type AuthorBooksUpdateFieldInput = {');
      expect(output).toContain(
        '  connect?: InputMaybe<Array<AuthorBooksConnectFieldInput>>;',
      );
      expect(output).toContain(
        '  disconnect?: InputMaybe<Array<AuthorBooksDisconnectFieldInput>>;',
      );
      expect(output).toContain(
        '  create?: InputMaybe<Array<AuthorBooksCreateFieldInput>>;',
      );
      expect(output).toContain(
        '  delete?: InputMaybe<Array<AuthorBooksDeleteFieldInput>>;',
      );
    });

    it('should emit ConnectFieldInput without connect field when target has no relationships', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type AuthorBooksConnectFieldInput = {');
      // Book has no relationships → no connect field
      expect(output).not.toContain(
        '  connect?: InputMaybe<Array<BookConnectInput>>;',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Relationship with edge properties
  // -----------------------------------------------------------------------

  describe('relationship with edge properties', () => {
    const schema = makeSchema({
      nodes: new Map([
        [
          'Author',
          makeNodeDef(
            'Author',
            new Map([['id', makeProp('id')]]),
            new Map([
              [
                'books',
                makeRel({
                  fieldName: 'books',
                  type: 'HAS_DRUG',
                  target: 'Book',
                  isArray: true,
                  properties: 'AuthorBookProps',
                }),
              ],
            ]),
          ),
        ],
        ['Book', makeNodeDef('Book')],
      ]),
      relationshipProperties: new Map([
        [
          'AuthorBookProps',
          {
            typeName: 'AuthorBookProps',
            properties: new Map<string, PropertyDefinition>([
              ['order', makeProp('order', { type: 'Int', required: true })],
              ['note', makeProp('note', { type: 'String' })],
              ['computed', makeProp('computed', { isCypher: true })],
              ['autoId', makeProp('autoId', { isGenerated: true })],
            ]),
          },
        ],
      ]),
    });

    it('should emit CreateFieldInput with edge property', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type AuthorBooksCreateFieldInput = {');
      expect(output).toContain(
        '  edge?: InputMaybe<AuthorBookPropsCreateInput>;',
      );
      expect(output).toContain('  node: BookCreateInput;');
    });

    it('should emit ConnectFieldInput with edge property', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type AuthorBooksConnectFieldInput = {');
      expect(output).toContain(
        '  edge?: InputMaybe<AuthorBookPropsCreateInput>;',
      );
    });

    it('should emit UpdateConnectionInput with edge property', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type AuthorBooksUpdateConnectionInput = {',
      );
      expect(output).toContain('  node?: InputMaybe<BookUpdateInput>;');
      expect(output).toContain(
        '  edge?: InputMaybe<AuthorBookPropsUpdateInput>;',
      );
    });

    it('should emit RelPropCreateInput excluding generated and cypher fields', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type AuthorBookPropsCreateInput = {');
      expect(output).toContain('  order: Scalars["Int"]["input"];');
      expect(output).toContain(
        '  note?: InputMaybe<Scalars["String"]["input"]>;',
      );
      // Should not include cypher or generated
      expect(output).not.toMatch(/AuthorBookPropsCreateInput[^}]*computed/);
      expect(output).not.toMatch(/AuthorBookPropsCreateInput[^}]*autoId/);
    });

    it('should emit RelPropUpdateInput with all fields optional', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type AuthorBookPropsUpdateInput = {');
      expect(output).toContain(
        '  order?: InputMaybe<Scalars["Int"]["input"]>;',
      );
      expect(output).toContain(
        '  note?: InputMaybe<Scalars["String"]["input"]>;',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Union-target relationship (per-member keyed types)
  // -----------------------------------------------------------------------

  describe('union-target relationship', () => {
    const schema = makeSchema({
      nodes: new Map([
        [
          'Chapter',
          makeNodeDef(
            'Chapter',
            new Map([['id', makeProp('id')]]),
            new Map([
              [
                'chapters',
                makeRel({
                  fieldName: 'chapters',
                  type: 'HAS_CHAPTER_TYPE',
                  target: 'ChapterType',
                  isArray: true,
                }),
              ],
            ]),
          ),
        ],
        ['StandardChapter', makeNodeDef('StandardChapter')],
        ['RangeChapter', makeNodeDef('RangeChapter')],
      ]),
      unions: new Map([['ChapterType', ['StandardChapter', 'RangeChapter']]]),
    });

    it('should emit per-member keyed CreateInput for union rel', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type ChapterChaptersCreateInput = {');
      expect(output).toContain(
        '  RangeChapter?: InputMaybe<ChapterChaptersRangeChapterFieldInput>;',
      );
      expect(output).toContain(
        '  StandardChapter?: InputMaybe<ChapterChaptersStandardChapterFieldInput>;',
      );
    });

    it('should emit CreateFieldInput alias', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterChaptersCreateFieldInput = ChapterChaptersCreateInput;',
      );
    });

    it('should emit per-member FieldInput sub-types with Array wrapping', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterChaptersRangeChapterFieldInput = {',
      );
      expect(output).toContain(
        '  connect?: InputMaybe<Array<ChapterChaptersRangeChapterConnectFieldInput>>;',
      );
      expect(output).toContain(
        '  create?: InputMaybe<Array<ChapterChaptersRangeChapterCreateFieldInput>>;',
      );

      expect(output).toContain(
        'export type ChapterChaptersStandardChapterFieldInput = {',
      );
    });

    it('should emit per-member CreateFieldInput sub-types', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterChaptersRangeChapterCreateFieldInput = {',
      );
      expect(output).toContain('  node: RangeChapterCreateInput;');

      expect(output).toContain(
        'export type ChapterChaptersStandardChapterCreateFieldInput = {',
      );
      expect(output).toContain('  node: StandardChapterCreateInput;');
    });

    it('should emit per-member ConnectInput top-level and sub-types without connect for leaf targets', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type ChapterChaptersConnectInput = {');
      expect(output).toContain(
        '  RangeChapter?: InputMaybe<Array<ChapterChaptersRangeChapterConnectFieldInput>>;',
      );

      expect(output).toContain(
        'export type ChapterChaptersRangeChapterConnectFieldInput = {',
      );
      expect(output).toContain(
        '  where?: InputMaybe<RangeChapterConnectWhere>;',
      );
      expect(output).toContain('  overwrite?: Scalars["Boolean"]["input"];');
      // RangeChapter has no relationships → no connect field
      expect(output).not.toContain(
        '  connect?: InputMaybe<Array<RangeChapterConnectInput>>;',
      );
    });

    it('should emit per-member DisconnectInput top-level and sub-types without disconnect for leaf targets', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterChaptersDisconnectInput = {',
      );
      expect(output).toContain(
        '  RangeChapter?: InputMaybe<Array<ChapterChaptersRangeChapterDisconnectFieldInput>>;',
      );

      expect(output).toContain(
        'export type ChapterChaptersRangeChapterDisconnectFieldInput = {',
      );
      expect(output).toContain(
        '  where?: InputMaybe<ChapterChaptersRangeChapterConnectionWhere>;',
      );
      // RangeChapter has no relationships → no disconnect field
      expect(output).not.toContain(
        '  disconnect?: InputMaybe<RangeChapterDisconnectInput>;',
      );
    });

    it('should emit per-member DeleteInput top-level and sub-types without delete for leaf targets', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type ChapterChaptersDeleteInput = {');
      expect(output).toContain(
        '  RangeChapter?: InputMaybe<Array<ChapterChaptersRangeChapterDeleteFieldInput>>;',
      );

      expect(output).toContain(
        'export type ChapterChaptersRangeChapterDeleteFieldInput = {',
      );
      expect(output).toContain(
        '  where?: InputMaybe<ChapterChaptersRangeChapterConnectionWhere>;',
      );
      // RangeChapter has no relationships → no delete field
      expect(output).not.toContain(
        '  delete?: InputMaybe<RangeChapterDeleteInput>;',
      );
    });

    it('should emit per-member UpdateFieldInput top-level, alias, and sub-types', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterChaptersUpdateFieldInput = {',
      );
      expect(output).toContain(
        '  RangeChapter?: InputMaybe<Array<ChapterChaptersRangeChapterUpdateFieldInput>>;',
      );

      // Backward compat alias
      expect(output).toContain(
        'export type ChapterChaptersUpdateInput = ChapterChaptersUpdateFieldInput;',
      );

      // Per-member sub-type
      expect(output).toContain(
        'export type ChapterChaptersRangeChapterUpdateFieldInput = {',
      );
      expect(output).toContain(
        '  where?: InputMaybe<ChapterChaptersRangeChapterConnectionWhere>;',
      );
      expect(output).toContain(
        '  connect?: InputMaybe<Array<ChapterChaptersRangeChapterConnectFieldInput>>;',
      );
      expect(output).toContain(
        '  disconnect?: InputMaybe<Array<ChapterChaptersRangeChapterDisconnectFieldInput>>;',
      );
      expect(output).toContain(
        '  create?: InputMaybe<Array<ChapterChaptersRangeChapterCreateFieldInput>>;',
      );
      expect(output).toContain(
        '  update?: InputMaybe<ChapterChaptersRangeChapterUpdateConnectionInput>;',
      );
      expect(output).toContain(
        '  delete?: InputMaybe<Array<ChapterChaptersRangeChapterDeleteFieldInput>>;',
      );
    });

    it('should emit per-member UpdateConnectionInput sub-types', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterChaptersRangeChapterUpdateConnectionInput = {',
      );
      expect(output).toContain('  node?: InputMaybe<RangeChapterUpdateInput>;');

      expect(output).toContain(
        'export type ChapterChaptersStandardChapterUpdateConnectionInput = {',
      );
      expect(output).toContain(
        '  node?: InputMaybe<StandardChapterUpdateInput>;',
      );
    });

    it('should emit per-member ConnectWhere for union targets', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type RangeChapterConnectWhere = {');
      expect(output).toContain('  node: RangeChapterWhere;');
      expect(output).toContain('export type StandardChapterConnectWhere = {');
      expect(output).toContain('  node: StandardChapterWhere;');
    });

    it('should reference union CreateInput in node CreateInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type ChapterCreateInput = {');
      expect(output).toContain(
        '  chapters?: InputMaybe<ChapterChaptersCreateInput>;',
      );
    });

    it('should reference union UpdateFieldInput in node UpdateInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type ChapterUpdateInput = {');
      expect(output).toContain(
        '  chapters?: InputMaybe<ChapterChaptersUpdateFieldInput>;',
      );
    });

    it('should reference union ConnectInput in node ConnectInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type ChapterConnectInput = {');
      expect(output).toContain(
        '  chapters?: InputMaybe<ChapterChaptersConnectInput>;',
      );
    });

    it('should reference union DisconnectInput in node DisconnectInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type ChapterDisconnectInput = {');
      expect(output).toContain(
        '  chapters?: InputMaybe<ChapterChaptersDisconnectInput>;',
      );
    });

    it('should reference union DeleteInput in node DeleteInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type ChapterDeleteInput = {');
      expect(output).toContain(
        '  chapters?: InputMaybe<ChapterChaptersDeleteInput>;',
      );
    });

    it('should NOT emit schema-level union CRUD if already emitted by relationship', () => {
      const output = emitInputTypes(schema);

      // The ChapterChapters* types are emitted by the relationship handler.
      // The schema-level union handler should skip them since they share names.
      // But ChapterType union CRUD at schema level uses "ChapterType" prefix, not "ChapterChapters".
      // So ChapterTypeCreateInput should still be emitted.
      expect(output).toContain('export type ChapterTypeCreateInput = {');
      expect(output).toContain(
        '  RangeChapter?: InputMaybe<RangeChapterCreateInput>;',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Union-target relationship with edge properties
  // -----------------------------------------------------------------------

  describe('union-target relationship with edge properties', () => {
    const schema = makeSchema({
      nodes: new Map([
        [
          'Chapter',
          makeNodeDef(
            'Chapter',
            new Map([['id', makeProp('id')]]),
            new Map([
              [
                'chapters',
                makeRel({
                  fieldName: 'chapters',
                  type: 'HAS_CHAPTER_TYPE',
                  target: 'ChapterType',
                  isArray: true,
                  properties: 'ChapterTypeEdge',
                }),
              ],
            ]),
          ),
        ],
        ['StandardChapter', makeNodeDef('StandardChapter')],
        ['RangeChapter', makeNodeDef('RangeChapter')],
      ]),
      unions: new Map([['ChapterType', ['StandardChapter', 'RangeChapter']]]),
      relationshipProperties: new Map([
        [
          'ChapterTypeEdge',
          {
            typeName: 'ChapterTypeEdge',
            properties: new Map<string, PropertyDefinition>([
              ['order', makeProp('order', { type: 'Int' })],
            ]),
          },
        ],
      ]),
    });

    it('should include edge in per-member CreateFieldInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterChaptersRangeChapterCreateFieldInput = {',
      );
      expect(output).toContain(
        '  edge?: InputMaybe<ChapterTypeEdgeCreateInput>;',
      );
      expect(output).toContain('  node: RangeChapterCreateInput;');
    });

    it('should include edge in per-member ConnectFieldInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterChaptersRangeChapterConnectFieldInput = {',
      );
      expect(output).toContain(
        '  edge?: InputMaybe<ChapterTypeEdgeCreateInput>;',
      );
    });

    it('should include edge in per-member UpdateConnectionInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterChaptersRangeChapterUpdateConnectionInput = {',
      );
      expect(output).toContain('  node?: InputMaybe<RangeChapterUpdateInput>;');
      expect(output).toContain(
        '  edge?: InputMaybe<ChapterTypeEdgeUpdateInput>;',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Union-target relationship with singular (isArray: false)
  // -----------------------------------------------------------------------

  describe('union-target relationship with isArray: false', () => {
    const schema = makeSchema({
      nodes: new Map([
        [
          'Chapter',
          makeNodeDef(
            'Chapter',
            new Map([['id', makeProp('id')]]),
            new Map([
              [
                'mainType',
                makeRel({
                  fieldName: 'mainType',
                  type: 'HAS_MAIN_TYPE',
                  target: 'ChapterType',
                  isArray: false,
                }),
              ],
            ]),
          ),
        ],
        ['StandardChapter', makeNodeDef('StandardChapter')],
        ['RangeChapter', makeNodeDef('RangeChapter')],
      ]),
      unions: new Map([['ChapterType', ['StandardChapter', 'RangeChapter']]]),
    });

    it('should emit per-member FieldInput without Array wrapping', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterMainTypeRangeChapterFieldInput = {',
      );
      expect(output).toContain(
        '  connect?: InputMaybe<ChapterMainTypeRangeChapterConnectFieldInput>;',
      );
      expect(output).toContain(
        '  create?: InputMaybe<ChapterMainTypeRangeChapterCreateFieldInput>;',
      );
    });

    it('should emit ConnectInput without Array wrapping for members', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type ChapterMainTypeConnectInput = {');
      expect(output).toContain(
        '  RangeChapter?: InputMaybe<ChapterMainTypeRangeChapterConnectFieldInput>;',
      );
    });

    it('should omit connect field in ConnectFieldInput when target has no relationships', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterMainTypeRangeChapterConnectFieldInput = {',
      );
      // RangeChapter has no relationships → no connect field
      expect(output).not.toContain(
        '  connect?: InputMaybe<RangeChapterConnectInput>;',
      );
    });

    it('should emit DisconnectInput without Array wrapping', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterMainTypeDisconnectInput = {',
      );
      expect(output).toContain(
        '  RangeChapter?: InputMaybe<ChapterMainTypeRangeChapterDisconnectFieldInput>;',
      );
    });

    it('should emit DeleteInput without Array wrapping', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type ChapterMainTypeDeleteInput = {');
      expect(output).toContain(
        '  RangeChapter?: InputMaybe<ChapterMainTypeRangeChapterDeleteFieldInput>;',
      );
    });

    it('should emit UpdateFieldInput with singular members', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterMainTypeUpdateFieldInput = {',
      );
      expect(output).toContain(
        '  RangeChapter?: InputMaybe<ChapterMainTypeRangeChapterUpdateFieldInput>;',
      );
    });

    it('should emit per-member UpdateFieldInput with singular connect/disconnect/create', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain(
        'export type ChapterMainTypeRangeChapterUpdateFieldInput = {',
      );
      expect(output).toContain(
        '  connect?: InputMaybe<ChapterMainTypeRangeChapterConnectFieldInput>;',
      );
      expect(output).toContain(
        '  disconnect?: InputMaybe<ChapterMainTypeRangeChapterDisconnectFieldInput>;',
      );
      expect(output).toContain(
        '  create?: InputMaybe<ChapterMainTypeRangeChapterCreateFieldInput>;',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Schema-level union types (not emitted by relationship handling)
  // -----------------------------------------------------------------------

  describe('schema-level union CRUD inputs', () => {
    const schema = makeSchema({
      nodes: new Map([
        ['Cat', makeNodeDef('Cat')],
        ['Dog', makeNodeDef('Dog')],
      ]),
      unions: new Map([['Pet', ['Cat', 'Dog']]]),
    });

    it('should emit union CreateInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type PetCreateInput = {');
      expect(output).toContain('  Cat?: InputMaybe<CatCreateInput>;');
      expect(output).toContain('  Dog?: InputMaybe<DogCreateInput>;');
    });

    it('should emit union UpdateInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type PetUpdateInput = {');
      expect(output).toContain('  Cat?: InputMaybe<CatUpdateInput>;');
      expect(output).toContain('  Dog?: InputMaybe<DogUpdateInput>;');
    });

    it('should NOT emit union ConnectInput when all members have zero relationships', () => {
      const output = emitInputTypes(schema);

      expect(output).not.toContain('PetConnectInput');
    });

    it('should NOT emit union DisconnectInput when all members have zero relationships', () => {
      const output = emitInputTypes(schema);

      expect(output).not.toContain('PetDisconnectInput');
    });

    it('should NOT emit union DeleteInput when all members have zero relationships', () => {
      const output = emitInputTypes(schema);

      expect(output).not.toContain('PetDeleteInput');
    });

    it('should sort union members alphabetically', () => {
      const output = emitInputTypes(schema);

      const catIdx = output.indexOf('  Cat?: InputMaybe<CatCreateInput>;');
      const dogIdx = output.indexOf('  Dog?: InputMaybe<DogCreateInput>;');
      expect(catIdx).toBeLessThan(dogIdx);
    });
  });

  // -----------------------------------------------------------------------
  // Interface CRUD inputs (per-implementor keyed)
  // -----------------------------------------------------------------------

  describe('interface CRUD inputs', () => {
    const schema = makeSchema({
      nodes: new Map([
        ['User', makeNodeDef('User')],
        ['Organization', makeNodeDef('Organization')],
      ]),
      interfaces: new Map<string, InterfaceDefinition>([
        [
          'Entity',
          {
            name: 'Entity',
            label: 'Entity',
            properties: new Map([['id', makeProp('id')]]),
            relationships: new Map(),
            implementedBy: ['User', 'Organization'],
          },
        ],
      ]),
    });

    it('should emit interface CreateInput with per-implementor keys', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type EntityCreateInput = {');
      expect(output).toContain(
        '  Organization?: InputMaybe<OrganizationCreateInput>;',
      );
      expect(output).toContain('  User?: InputMaybe<UserCreateInput>;');
    });

    it('should emit interface UpdateInput', () => {
      const output = emitInputTypes(schema);

      expect(output).toContain('export type EntityUpdateInput = {');
      expect(output).toContain(
        '  Organization?: InputMaybe<OrganizationUpdateInput>;',
      );
      expect(output).toContain('  User?: InputMaybe<UserUpdateInput>;');
    });

    it('should NOT emit interface ConnectInput when all implementors have zero relationships', () => {
      const output = emitInputTypes(schema);

      expect(output).not.toContain('EntityConnectInput');
    });

    it('should NOT emit interface DisconnectInput when all implementors have zero relationships', () => {
      const output = emitInputTypes(schema);

      expect(output).not.toContain('EntityDisconnectInput');
    });

    it('should NOT emit interface DeleteInput when all implementors have zero relationships', () => {
      const output = emitInputTypes(schema);

      expect(output).not.toContain('EntityDeleteInput');
    });

    it('should skip interface CRUD when implementedBy is empty', () => {
      const emptySchema = makeSchema({
        nodes: new Map([['User', makeNodeDef('User')]]),
        interfaces: new Map<string, InterfaceDefinition>([
          [
            'EmptyIface',
            {
              name: 'EmptyIface',
              label: 'EmptyIface',
              properties: new Map(),
              relationships: new Map(),
              implementedBy: [],
            },
          ],
        ]),
      });

      const output = emitInputTypes(emptySchema);

      expect(output).not.toContain('EmptyIfaceCreateInput');
      expect(output).not.toContain('EmptyIfaceUpdateInput');
    });
  });

  // -----------------------------------------------------------------------
  // ConnectWhere deduplication
  // -----------------------------------------------------------------------

  describe('ConnectWhere deduplication', () => {
    it('should emit ConnectWhere only once per target', () => {
      const schema = makeSchema({
        nodes: new Map([
          [
            'A',
            makeNodeDef(
              'A',
              new Map([['id', makeProp('id')]]),
              new Map([
                [
                  'relOne',
                  makeRel({ fieldName: 'relOne', target: 'B', isArray: true }),
                ],
                [
                  'relTwo',
                  makeRel({ fieldName: 'relTwo', target: 'B', isArray: false }),
                ],
              ]),
            ),
          ],
          ['B', makeNodeDef('B')],
        ]),
      });

      const output = emitInputTypes(schema);

      const matches = output.match(/export type BConnectWhere/g);
      expect(matches).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Sorting
  // -----------------------------------------------------------------------

  describe('sorting', () => {
    it('should sort nodes alphabetically', () => {
      const schema = makeSchema({
        nodes: new Map([
          ['Zebra', makeNodeDef('Zebra')],
          ['Apple', makeNodeDef('Apple')],
        ]),
      });

      const output = emitInputTypes(schema);

      const appleIdx = output.indexOf('AppleCreateInput');
      const zebraIdx = output.indexOf('ZebraCreateInput');
      expect(appleIdx).toBeLessThan(zebraIdx);
    });

    it('should sort relationship properties alphabetically', () => {
      const schema = makeSchema({
        nodes: new Map([['A', makeNodeDef('A')]]),
        relationshipProperties: new Map<
          string,
          RelationshipPropertiesDefinition
        >([
          [
            'ZProps',
            {
              typeName: 'ZProps',
              properties: new Map([['val', makeProp('val')]]),
            },
          ],
          [
            'AProps',
            {
              typeName: 'AProps',
              properties: new Map([['val', makeProp('val')]]),
            },
          ],
        ]),
      });

      const output = emitInputTypes(schema);

      const aIdx = output.indexOf('APropsCreateInput');
      const zIdx = output.indexOf('ZPropsCreateInput');
      expect(aIdx).toBeLessThan(zIdx);
    });
  });

  // -----------------------------------------------------------------------
  // Empty schema
  // -----------------------------------------------------------------------

  describe('empty schema', () => {
    it('should return empty string for schema with no nodes', () => {
      const schema = makeSchema();
      const output = emitInputTypes(schema);

      expect(output).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // mapInputScalar fallback for non-builtin, non-enum types (line 159)
  // -----------------------------------------------------------------------

  describe('mapInputScalar fallback for unknown types', () => {
    it('should pass through unknown type names as-is', () => {
      const schema = makeSchema({
        nodes: new Map([
          [
            'Node',
            makeNodeDef(
              'Node',
              new Map<string, PropertyDefinition>([
                [
                  'custom',
                  makeProp('custom', { type: 'CustomScalar', required: true }),
                ],
              ]),
            ),
          ],
        ]),
        // 'CustomScalar' is NOT in enums and NOT a built-in scalar
        enums: new Map(),
      });

      const output = emitInputTypes(schema);

      // Should use the type name directly (not Scalars["CustomScalar"])
      expect(output).toContain('  custom: CustomScalar;');
    });
  });

  // -----------------------------------------------------------------------
  // Sort comparator coverage for unions and interfaces with multiple entries
  // -----------------------------------------------------------------------

  describe('union and interface sorting with multiple entries', () => {
    it('should sort multiple schema-level unions alphabetically', () => {
      const schema = makeSchema({
        nodes: new Map([
          ['A', makeNodeDef('A')],
          ['B', makeNodeDef('B')],
          ['C', makeNodeDef('C')],
        ]),
        unions: new Map([
          ['Zeta', ['A', 'B']],
          ['Alpha', ['B', 'C']],
        ]),
      });

      const output = emitInputTypes(schema);

      const alphaIdx = output.indexOf('AlphaCreateInput');
      const zetaIdx = output.indexOf('ZetaCreateInput');
      expect(alphaIdx).toBeLessThan(zetaIdx);
    });

    it('should sort multiple interfaces alphabetically', () => {
      const schema = makeSchema({
        nodes: new Map([
          ['X', makeNodeDef('X')],
          ['Y', makeNodeDef('Y')],
        ]),
        interfaces: new Map<string, InterfaceDefinition>([
          [
            'Zulu',
            {
              name: 'Zulu',
              label: 'Zulu',
              properties: new Map(),
              relationships: new Map(),
              implementedBy: ['X'],
            },
          ],
          [
            'Bravo',
            {
              name: 'Bravo',
              label: 'Bravo',
              properties: new Map(),
              relationships: new Map(),
              implementedBy: ['Y'],
            },
          ],
        ]),
      });

      const output = emitInputTypes(schema);

      const bravoIdx = output.indexOf('BravoCreateInput');
      const zuluIdx = output.indexOf('ZuluCreateInput');
      expect(bravoIdx).toBeLessThan(zuluIdx);
    });
  });

  // -----------------------------------------------------------------------
  // wrapArray helper (lines 11-13)
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Skip empty ConnectInput/DisconnectInput/DeleteInput for leaf nodes
  // -----------------------------------------------------------------------

  describe('skip empty Connect/Disconnect/Delete for nodes with zero relationships', () => {
    it('should NOT emit ConnectInput/DisconnectInput/DeleteInput for a node with zero relationships', () => {
      const schema = makeSchema({
        nodes: new Map([['Leaf', makeNodeDef('Leaf')]]),
      });

      const output = emitInputTypes(schema);

      // CreateInput and UpdateInput should still be emitted
      expect(output).toContain('export type LeafCreateInput = {');
      expect(output).toContain('export type LeafUpdateInput = {');
      // Connect/Disconnect/Delete should NOT be emitted
      expect(output).not.toContain('LeafConnectInput');
      expect(output).not.toContain('LeafDisconnectInput');
      expect(output).not.toContain('LeafDeleteInput');
    });

    it('should still emit ConnectInput/DisconnectInput/DeleteInput for a node with relationships', () => {
      const schema = makeSchema({
        nodes: new Map([
          [
            'Parent',
            makeNodeDef(
              'Parent',
              new Map([['id', makeProp('id')]]),
              new Map([
                [
                  'children',
                  makeRel({
                    fieldName: 'children',
                    target: 'Child',
                    isArray: true,
                  }),
                ],
              ]),
            ),
          ],
          ['Child', makeNodeDef('Child')],
        ]),
      });

      const output = emitInputTypes(schema);

      expect(output).toContain('export type ParentConnectInput = {');
      expect(output).toContain('export type ParentDisconnectInput = {');
      expect(output).toContain('export type ParentDeleteInput = {');
    });

    it('should omit connect/disconnect/delete fields in FieldInputs when target has no relationships', () => {
      const schema = makeSchema({
        nodes: new Map([
          [
            'Parent',
            makeNodeDef(
              'Parent',
              new Map([['id', makeProp('id')]]),
              new Map([
                [
                  'items',
                  makeRel({
                    fieldName: 'items',
                    target: 'Leaf',
                    isArray: true,
                  }),
                ],
              ]),
            ),
          ],
          ['Leaf', makeNodeDef('Leaf')],
        ]),
      });

      const output = emitInputTypes(schema);

      // ConnectFieldInput should exist but without connect field
      expect(output).toContain('export type ParentItemsConnectFieldInput = {');
      expect(output).not.toContain(
        '  connect?: InputMaybe<Array<LeafConnectInput>>;',
      );

      // DisconnectFieldInput should exist but without disconnect field
      expect(output).toContain(
        'export type ParentItemsDisconnectFieldInput = {',
      );
      expect(output).not.toContain(
        '  disconnect?: InputMaybe<LeafDisconnectInput>;',
      );

      // DeleteFieldInput should exist but without delete field
      expect(output).toContain('export type ParentItemsDeleteFieldInput = {');
      expect(output).not.toContain('  delete?: InputMaybe<LeafDeleteInput>;');
    });

    it('should filter union members in standalone union ConnectInput/DisconnectInput/DeleteInput', () => {
      const schema = makeSchema({
        nodes: new Map([
          [
            'WithRels',
            makeNodeDef(
              'WithRels',
              new Map([['id', makeProp('id')]]),
              new Map([
                [
                  'sub',
                  makeRel({
                    fieldName: 'sub',
                    target: 'Leaf',
                    isArray: true,
                  }),
                ],
              ]),
            ),
          ],
          ['Leaf', makeNodeDef('Leaf')],
        ]),
        unions: new Map([['MixedUnion', ['WithRels', 'Leaf']]]),
      });

      const output = emitInputTypes(schema);

      // ConnectInput should only include WithRels (has rels), not Leaf (no rels)
      expect(output).toContain('export type MixedUnionConnectInput = {');
      expect(output).toContain(
        '  WithRels?: InputMaybe<Array<WithRelsConnectInput>>;',
      );
      expect(output).not.toContain(
        '  Leaf?: InputMaybe<Array<LeafConnectInput>>;',
      );

      // DisconnectInput same
      expect(output).toContain('export type MixedUnionDisconnectInput = {');
      expect(output).toContain(
        '  WithRels?: InputMaybe<Array<WithRelsDisconnectInput>>;',
      );
      expect(output).not.toContain(
        '  Leaf?: InputMaybe<Array<LeafDisconnectInput>>;',
      );

      // DeleteInput same
      expect(output).toContain('export type MixedUnionDeleteInput = {');
      expect(output).toContain(
        '  WithRels?: InputMaybe<Array<WithRelsDeleteInput>>;',
      );
      expect(output).not.toContain(
        '  Leaf?: InputMaybe<Array<LeafDeleteInput>>;',
      );
    });
  });

  // -----------------------------------------------------------------------
  // wrapArray helper (lines 11-13)
  // -----------------------------------------------------------------------

  describe('wrapArray via union-target singular vs array', () => {
    it('should wrap in Array<> for isArray: true relationships in union targets', () => {
      const schema = makeSchema({
        nodes: new Map([
          [
            'Parent',
            makeNodeDef(
              'Parent',
              new Map([['id', makeProp('id')]]),
              new Map([
                [
                  'children',
                  makeRel({
                    fieldName: 'children',
                    target: 'ChildUnion',
                    isArray: true,
                  }),
                ],
              ]),
            ),
          ],
          ['TypeA', makeNodeDef('TypeA')],
          ['TypeB', makeNodeDef('TypeB')],
        ]),
        unions: new Map([['ChildUnion', ['TypeA', 'TypeB']]]),
      });

      const output = emitInputTypes(schema);

      // FieldInput sub-types should use Array<>
      expect(output).toContain(
        '  connect?: InputMaybe<Array<ParentChildrenTypeAConnectFieldInput>>;',
      );
      expect(output).toContain(
        '  create?: InputMaybe<Array<ParentChildrenTypeACreateFieldInput>>;',
      );
    });

    it('should NOT wrap in Array<> for isArray: false relationships in union targets', () => {
      const schema = makeSchema({
        nodes: new Map([
          [
            'Parent',
            makeNodeDef(
              'Parent',
              new Map([['id', makeProp('id')]]),
              new Map([
                [
                  'child',
                  makeRel({
                    fieldName: 'child',
                    target: 'ChildUnion',
                    isArray: false,
                  }),
                ],
              ]),
            ),
          ],
          ['TypeA', makeNodeDef('TypeA')],
          ['TypeB', makeNodeDef('TypeB')],
        ]),
        unions: new Map([['ChildUnion', ['TypeA', 'TypeB']]]),
      });

      const output = emitInputTypes(schema);

      // FieldInput sub-types should NOT use Array<>
      expect(output).toContain(
        '  connect?: InputMaybe<ParentChildTypeAConnectFieldInput>;',
      );
      expect(output).toContain(
        '  create?: InputMaybe<ParentChildTypeACreateFieldInput>;',
      );
    });
  });
});
