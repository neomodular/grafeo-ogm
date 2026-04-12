import {
  emitConnectionWhereTypes,
  emitConnectionEdgeTypes,
} from '../../src/generator/type-emitters/connection-emitter';
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

function makeInterfaceDef(
  name: string,
  props: PropertyDefinition[],
  rels: RelationshipDefinition[],
  implementedBy: string[],
): InterfaceDefinition {
  return {
    name,
    label: name,
    properties: new Map(props.map((p) => [p.name, p])),
    relationships: new Map(rels.map((r) => [r.fieldName, r])),
    implementedBy,
  };
}

function makeSchema(
  nodes: Map<string, NodeDefinition>,
  interfaces: Map<string, InterfaceDefinition> = new Map(),
  unions: Map<string, string[]> = new Map(),
): SchemaMetadata {
  return {
    nodes,
    interfaces,
    relationshipProperties: new Map(),
    enums: new Map(),
    unions,
  };
}

// ---------------------------------------------------------------------------
// emitConnectionWhereTypes
// ---------------------------------------------------------------------------

describe('emitConnectionWhereTypes', () => {
  it('should emit ConnectionWhere for a simple relationship (no edge props)', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef(
            'Book',
            [makeProp('id')],
            [
              makeRel({
                fieldName: 'hasStatus',
                type: 'HAS_STATUS',
                target: 'Status',
              }),
            ],
          ),
        ],
      ]),
    );

    const output = emitConnectionWhereTypes(schema);

    expect(output).toContain('export type BookHasStatusConnectionWhere = {');
    expect(output).toContain('node?: InputMaybe<StatusWhere>;');
    expect(output).toContain('node_NOT?: InputMaybe<StatusWhere>;');
    expect(output).not.toContain('edge?:');
    expect(output).not.toContain('edge_NOT?:');
    expect(output).toContain(
      'AND?: InputMaybe<Array<BookHasStatusConnectionWhere>>;',
    );
    expect(output).toContain(
      'OR?: InputMaybe<Array<BookHasStatusConnectionWhere>>;',
    );
    expect(output).toContain('NOT?: InputMaybe<BookHasStatusConnectionWhere>;');
  });

  it('should emit ConnectionWhere with edge filters when relationship has properties', () => {
    const schema = makeSchema(
      new Map([
        [
          'Author',
          makeNodeDef(
            'Author',
            [makeProp('id')],
            [
              makeRel({
                fieldName: 'books',
                type: 'WRITTEN_BY_AUTHOR',
                target: 'Book',
                properties: 'AuthorBookProps',
              }),
            ],
          ),
        ],
      ]),
    );

    const output = emitConnectionWhereTypes(schema);

    expect(output).toContain('export type AuthorBooksConnectionWhere = {');
    expect(output).toContain('edge?: InputMaybe<AuthorBookPropsWhere>;');
    expect(output).toContain('edge_NOT?: InputMaybe<AuthorBookPropsWhere>;');
  });

  it('should sort nodes and relationships alphabetically', () => {
    const schema = makeSchema(
      new Map([
        [
          'Zebra',
          makeNodeDef(
            'Zebra',
            [makeProp('id')],
            [makeRel({ fieldName: 'beta', type: 'REL_B', target: 'Beta' })],
          ),
        ],
        [
          'Alpha',
          makeNodeDef(
            'Alpha',
            [makeProp('id')],
            [
              makeRel({
                fieldName: 'alpha',
                type: 'REL_A',
                target: 'AlphaTarget',
              }),
            ],
          ),
        ],
      ]),
    );

    const output = emitConnectionWhereTypes(schema);

    const alphaIdx = output.indexOf('AlphaAlphaConnectionWhere');
    const zebraIdx = output.indexOf('ZebraBetaConnectionWhere');
    expect(alphaIdx).toBeLessThan(zebraIdx);
  });

  // -------------------------------------------------------------------------
  // Union-target relationships
  // -------------------------------------------------------------------------

  describe('union-target relationships', () => {
    it('should emit per-member ConnectionWhere types for union targets', () => {
      const schema = makeSchema(
        new Map([
          [
            'Chapter',
            makeNodeDef(
              'Chapter',
              [makeProp('id')],
              [
                makeRel({
                  fieldName: 'chapters',
                  type: 'HAS_CHAPTER_TYPE',
                  target: 'ChapterType',
                }),
              ],
            ),
          ],
        ]),
        new Map(),
        new Map([['ChapterType', ['StandardChapter', 'RangeChapter']]]),
      );

      const output = emitConnectionWhereTypes(schema);

      // Top-level ConnectionWhere (uses union target name)
      expect(output).toContain(
        'export type ChapterChaptersConnectionWhere = {',
      );
      expect(output).toContain('node?: InputMaybe<ChapterTypeWhere>;');

      // Per-member ConnectionWhere types (sorted alphabetically)
      expect(output).toContain(
        'export type ChapterChaptersRangeChapterConnectionWhere = {',
      );
      expect(output).toContain('node?: InputMaybe<RangeChapterWhere>;');

      expect(output).toContain(
        'export type ChapterChaptersStandardChapterConnectionWhere = {',
      );
      expect(output).toContain('node?: InputMaybe<StandardChapterWhere>;');
    });

    it('should include edge filters in per-member types when relationship has properties', () => {
      const schema = makeSchema(
        new Map([
          [
            'Chapter',
            makeNodeDef(
              'Chapter',
              [makeProp('id')],
              [
                makeRel({
                  fieldName: 'chapters',
                  type: 'HAS_CHAPTER_TYPE',
                  target: 'ChapterType',
                  properties: 'ChapterTypeEdgeProps',
                }),
              ],
            ),
          ],
        ]),
        new Map(),
        new Map([['ChapterType', ['StandardChapter', 'RangeChapter']]]),
      );

      const output = emitConnectionWhereTypes(schema);

      // Top-level has edge filters
      expect(output).toContain(
        'export type ChapterChaptersConnectionWhere = {',
      );
      expect(output).toMatch(
        /ChapterChaptersConnectionWhere[\s\S]*?edge\?: InputMaybe<ChapterTypeEdgePropsWhere>/,
      );

      // Per-member types also have edge filters
      expect(output).toMatch(
        /ChapterChaptersStandardChapterConnectionWhere[\s\S]*?edge\?: InputMaybe<ChapterTypeEdgePropsWhere>/,
      );
      expect(output).toMatch(
        /ChapterChaptersRangeChapterConnectionWhere[\s\S]*?edge\?: InputMaybe<ChapterTypeEdgePropsWhere>/,
      );
    });

    it('should emit per-member logical operators', () => {
      const schema = makeSchema(
        new Map([
          [
            'Chapter',
            makeNodeDef(
              'Chapter',
              [makeProp('id')],
              [
                makeRel({
                  fieldName: 'chapters',
                  type: 'HAS_CHAPTER_TYPE',
                  target: 'ChapterType',
                }),
              ],
            ),
          ],
        ]),
        new Map(),
        new Map([['ChapterType', ['StandardChapter']]]),
      );

      const output = emitConnectionWhereTypes(schema);

      expect(output).toContain(
        'AND?: InputMaybe<Array<ChapterChaptersStandardChapterConnectionWhere>>;',
      );
      expect(output).toContain(
        'OR?: InputMaybe<Array<ChapterChaptersStandardChapterConnectionWhere>>;',
      );
      expect(output).toContain(
        'NOT?: InputMaybe<ChapterChaptersStandardChapterConnectionWhere>;',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Interface relationships
  // -------------------------------------------------------------------------

  describe('interface relationships', () => {
    it('should emit ConnectionWhere for interface relationships without edge props', () => {
      const resourcesRel = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
      });

      const schema = makeSchema(
        new Map([
          [
            'Organization',
            makeNodeDef('Organization', [makeProp('id')], [resourcesRel]),
          ],
        ]),
        new Map([
          [
            'Entity',
            makeInterfaceDef(
              'Entity',
              [makeProp('id')],
              [resourcesRel],
              ['Organization'],
            ),
          ],
        ]),
      );

      const output = emitConnectionWhereTypes(schema);

      expect(output).toContain(
        'export type EntityResourcesConnectionWhere = {',
      );
      expect(output).toContain('node?: InputMaybe<ResourceWhere>;');
      expect(output).toContain('node_NOT?: InputMaybe<ResourceWhere>;');
      expect(output).toContain(
        'AND?: InputMaybe<Array<EntityResourcesConnectionWhere>>;',
      );
      expect(output).toContain(
        'OR?: InputMaybe<Array<EntityResourcesConnectionWhere>>;',
      );
      expect(output).toContain(
        'NOT?: InputMaybe<EntityResourcesConnectionWhere>;',
      );
      // No edge filters since no implementor has edge props
      expect(output).not.toContain('EntityResourcesEdgeWhere');
    });

    it('should emit EdgeWhere when implementors have edge properties', () => {
      const ifaceRel = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
      });
      const implRel = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
        properties: 'ResourceProps',
      });

      const schema = makeSchema(
        new Map([
          [
            'Organization',
            makeNodeDef('Organization', [makeProp('id')], [implRel]),
          ],
        ]),
        new Map([
          [
            'Entity',
            makeInterfaceDef(
              'Entity',
              [makeProp('id')],
              [ifaceRel],
              ['Organization'],
            ),
          ],
        ]),
      );

      const output = emitConnectionWhereTypes(schema);

      // ConnectionWhere with edge filters
      expect(output).toContain('edge?: InputMaybe<EntityResourcesEdgeWhere>;');
      expect(output).toContain(
        'edge_NOT?: InputMaybe<EntityResourcesEdgeWhere>;',
      );

      // Intermediate EdgeWhere type
      expect(output).toContain('export type EntityResourcesEdgeWhere = {');
      expect(output).toContain(
        'ResourceProps?: InputMaybe<ResourcePropsWhere>;',
      );
    });

    it('should sort interface relationships alphabetically', () => {
      const relA = makeRel({
        fieldName: 'alpha',
        type: 'ALPHA',
        target: 'AlphaTarget',
      });
      const relB = makeRel({
        fieldName: 'beta',
        type: 'BETA',
        target: 'BetaTarget',
      });

      const schema = makeSchema(
        new Map([
          ['Impl', makeNodeDef('Impl', [makeProp('id')], [relA, relB])],
        ]),
        new Map([
          [
            'Entity',
            makeInterfaceDef(
              'Entity',
              [makeProp('id')],
              [relB, relA],
              ['Impl'],
            ),
          ],
        ]),
      );

      const output = emitConnectionWhereTypes(schema);

      const alphaIdx = output.indexOf('EntityAlphaConnectionWhere');
      const betaIdx = output.indexOf('EntityBetaConnectionWhere');
      expect(alphaIdx).toBeGreaterThan(-1);
      expect(betaIdx).toBeGreaterThan(-1);
      expect(alphaIdx).toBeLessThan(betaIdx);
    });

    it('should sort interfaces alphabetically', () => {
      const rel = makeRel({
        fieldName: 'items',
        type: 'HAS_ITEM',
        target: 'Item',
      });

      const schema = makeSchema(
        new Map([['Impl', makeNodeDef('Impl', [makeProp('id')])]]),
        new Map([
          ['Zeta', makeInterfaceDef('Zeta', [makeProp('id')], [rel], ['Impl'])],
          [
            'Alpha',
            makeInterfaceDef('Alpha', [makeProp('id')], [rel], ['Impl']),
          ],
        ]),
      );

      const output = emitConnectionWhereTypes(schema);

      const alphaIdx = output.indexOf('AlphaItemsConnectionWhere');
      const zetaIdx = output.indexOf('ZetaItemsConnectionWhere');
      expect(alphaIdx).toBeGreaterThan(-1);
      expect(zetaIdx).toBeGreaterThan(-1);
      expect(alphaIdx).toBeLessThan(zetaIdx);
    });
  });

  it('should return empty string for schema with no relationships', () => {
    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', [makeProp('id')])]]),
    );

    const output = emitConnectionWhereTypes(schema);
    expect(output).toBe('');
  });
});

// ---------------------------------------------------------------------------
// emitConnectionEdgeTypes
// ---------------------------------------------------------------------------

describe('emitConnectionEdgeTypes', () => {
  it('should emit PageInfo type at the top', () => {
    const schema = makeSchema(new Map());

    const output = emitConnectionEdgeTypes(schema);

    expect(output).toContain('export type PageInfo = {');
    expect(output).toContain('hasNextPage: Scalars["Boolean"]["output"];');
    expect(output).toContain('hasPreviousPage: Scalars["Boolean"]["output"];');
    expect(output).toContain(
      'startCursor?: Maybe<Scalars["String"]["output"]>;',
    );
    expect(output).toContain('endCursor?: Maybe<Scalars["String"]["output"]>;');
  });

  it('should emit Connection and Relationship types for a simple relationship', () => {
    const schema = makeSchema(
      new Map([
        [
          'Book',
          makeNodeDef(
            'Book',
            [makeProp('id')],
            [
              makeRel({
                fieldName: 'hasStatus',
                type: 'HAS_STATUS',
                target: 'Status',
              }),
            ],
          ),
        ],
      ]),
    );

    const output = emitConnectionEdgeTypes(schema);

    // Connection type
    expect(output).toContain('export type BookHasStatusConnection = {');
    expect(output).toContain('edges: Array<BookHasStatusRelationship>;');
    expect(output).toContain('totalCount: Scalars["Int"]["output"];');
    expect(output).toContain('pageInfo: PageInfo;');

    // Relationship type
    expect(output).toContain('export type BookHasStatusRelationship = {');
    expect(output).toContain('cursor: Scalars["String"]["output"];');
    expect(output).toContain('node: Status;');
    // No properties line
    expect(output).not.toMatch(/BookHasStatusRelationship[\s\S]*?properties:/);
  });

  it('should include properties in Relationship type when relationship has edge props', () => {
    const schema = makeSchema(
      new Map([
        [
          'Author',
          makeNodeDef(
            'Author',
            [makeProp('id')],
            [
              makeRel({
                fieldName: 'books',
                type: 'WRITTEN_BY_AUTHOR',
                target: 'Book',
                properties: 'AuthorBookProps',
              }),
            ],
          ),
        ],
      ]),
    );

    const output = emitConnectionEdgeTypes(schema);

    expect(output).toContain('export type AuthorBooksRelationship = {');
    expect(output).toContain('properties: AuthorBookProps;');
  });

  it('should sort nodes and relationships alphabetically', () => {
    const schema = makeSchema(
      new Map([
        [
          'Zebra',
          makeNodeDef(
            'Zebra',
            [makeProp('id')],
            [makeRel({ fieldName: 'items', type: 'HAS_ITEM', target: 'Item' })],
          ),
        ],
        [
          'Alpha',
          makeNodeDef(
            'Alpha',
            [makeProp('id')],
            [
              makeRel({
                fieldName: 'things',
                type: 'HAS_THING',
                target: 'Thing',
              }),
            ],
          ),
        ],
      ]),
    );

    const output = emitConnectionEdgeTypes(schema);

    const alphaIdx = output.indexOf('AlphaThingsConnection');
    const zebraIdx = output.indexOf('ZebraItemsConnection');
    expect(alphaIdx).toBeLessThan(zebraIdx);
  });

  // -------------------------------------------------------------------------
  // Union-target relationships
  // -------------------------------------------------------------------------

  describe('union-target relationships', () => {
    it('should emit top-level Connection and Relationship types for union targets', () => {
      const schema = makeSchema(
        new Map([
          [
            'Chapter',
            makeNodeDef(
              'Chapter',
              [makeProp('id')],
              [
                makeRel({
                  fieldName: 'chapters',
                  type: 'HAS_CHAPTER_TYPE',
                  target: 'ChapterType',
                }),
              ],
            ),
          ],
        ]),
        new Map(),
        new Map([['ChapterType', ['StandardChapter', 'RangeChapter']]]),
      );

      const output = emitConnectionEdgeTypes(schema);

      // Top-level Connection type
      expect(output).toContain('export type ChapterChaptersConnection = {');
      expect(output).toContain('edges: Array<ChapterChaptersRelationship>;');
      expect(output).toContain('totalCount: Scalars["Int"]["output"];');
      expect(output).toContain('pageInfo: PageInfo;');

      // Top-level Relationship type
      expect(output).toContain('export type ChapterChaptersRelationship = {');
      expect(output).toContain('cursor: Scalars["String"]["output"];');
      expect(output).toContain('node: ChapterType;');
    });

    it('should include properties in union Relationship when rel has edge props', () => {
      const schema = makeSchema(
        new Map([
          [
            'Chapter',
            makeNodeDef(
              'Chapter',
              [makeProp('id')],
              [
                makeRel({
                  fieldName: 'chapters',
                  type: 'HAS_CHAPTER_TYPE',
                  target: 'ChapterType',
                  properties: 'ChapterTypeEdgeProps',
                }),
              ],
            ),
          ],
        ]),
        new Map(),
        new Map([['ChapterType', ['StandardChapter', 'RangeChapter']]]),
      );

      const output = emitConnectionEdgeTypes(schema);

      expect(output).toContain('export type ChapterChaptersRelationship = {');
      expect(output).toContain('properties: ChapterTypeEdgeProps;');
    });

    it('should not include properties when union rel has no edge props', () => {
      const schema = makeSchema(
        new Map([
          [
            'Chapter',
            makeNodeDef(
              'Chapter',
              [makeProp('id')],
              [
                makeRel({
                  fieldName: 'chapters',
                  type: 'HAS_CHAPTER_TYPE',
                  target: 'ChapterType',
                }),
              ],
            ),
          ],
        ]),
        new Map(),
        new Map([['ChapterType', ['StandardChapter']]]),
      );

      const output = emitConnectionEdgeTypes(schema);

      const relBlock = output.substring(
        output.indexOf('export type ChapterChaptersRelationship'),
      );
      expect(relBlock).not.toContain('properties:');
    });
  });

  // -------------------------------------------------------------------------
  // Interface relationships
  // -------------------------------------------------------------------------

  describe('interface relationships', () => {
    it('should emit Connection and Relationship types for interface rels without edge props', () => {
      const ifaceRel = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
      });

      const schema = makeSchema(
        new Map([
          [
            'Organization',
            makeNodeDef('Organization', [makeProp('id')], [ifaceRel]),
          ],
        ]),
        new Map([
          [
            'Entity',
            makeInterfaceDef(
              'Entity',
              [makeProp('id')],
              [ifaceRel],
              ['Organization'],
            ),
          ],
        ]),
      );

      const output = emitConnectionEdgeTypes(schema);

      // Connection type
      expect(output).toContain('export type EntityResourcesConnection = {');
      expect(output).toContain('edges: Array<EntityResourcesRelationship>;');

      // Relationship type without properties
      expect(output).toContain('export type EntityResourcesRelationship = {');
      expect(output).toContain('cursor: Scalars["String"]["output"];');
      expect(output).toContain('node: Resource;');

      // No RelationshipProperties alias
      expect(output).not.toContain('EntityResourcesRelationshipProperties');
    });

    it('should emit Relationship with properties and RelationshipProperties alias when implementors have edge props', () => {
      const ifaceRel = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
      });
      const implRel = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
        properties: 'ResourceProps',
      });

      const schema = makeSchema(
        new Map([
          [
            'Organization',
            makeNodeDef('Organization', [makeProp('id')], [implRel]),
          ],
        ]),
        new Map([
          [
            'Entity',
            makeInterfaceDef(
              'Entity',
              [makeProp('id')],
              [ifaceRel],
              ['Organization'],
            ),
          ],
        ]),
      );

      const output = emitConnectionEdgeTypes(schema);

      // Relationship type with properties
      expect(output).toContain('export type EntityResourcesRelationship = {');
      expect(output).toContain(
        'properties: EntityResourcesRelationshipProperties;',
      );

      // RelationshipProperties alias
      expect(output).toContain(
        'export type EntityResourcesRelationshipProperties = ResourceProps;',
      );
    });

    it('should sort interface relationships alphabetically', () => {
      const relA = makeRel({
        fieldName: 'alpha',
        type: 'ALPHA',
        target: 'AlphaTarget',
      });
      const relB = makeRel({
        fieldName: 'beta',
        type: 'BETA',
        target: 'BetaTarget',
      });

      const schema = makeSchema(
        new Map([
          ['Impl', makeNodeDef('Impl', [makeProp('id')], [relA, relB])],
        ]),
        new Map([
          [
            'Entity',
            makeInterfaceDef(
              'Entity',
              [makeProp('id')],
              [relB, relA],
              ['Impl'],
            ),
          ],
        ]),
      );

      const output = emitConnectionEdgeTypes(schema);

      const alphaIdx = output.indexOf('EntityAlphaConnection');
      const betaIdx = output.indexOf('EntityBetaConnection');
      expect(alphaIdx).toBeGreaterThan(-1);
      expect(betaIdx).toBeGreaterThan(-1);
      expect(alphaIdx).toBeLessThan(betaIdx);
    });

    it('should sort interfaces alphabetically', () => {
      const rel = makeRel({
        fieldName: 'items',
        type: 'HAS_ITEM',
        target: 'Item',
      });

      const schema = makeSchema(
        new Map([['Impl', makeNodeDef('Impl', [makeProp('id')])]]),
        new Map([
          ['Zeta', makeInterfaceDef('Zeta', [makeProp('id')], [rel], ['Impl'])],
          [
            'Alpha',
            makeInterfaceDef('Alpha', [makeProp('id')], [rel], ['Impl']),
          ],
        ]),
      );

      const output = emitConnectionEdgeTypes(schema);

      const alphaIdx = output.indexOf('AlphaItemsConnection');
      const zetaIdx = output.indexOf('ZetaItemsConnection');
      expect(alphaIdx).toBeGreaterThan(-1);
      expect(zetaIdx).toBeGreaterThan(-1);
      expect(alphaIdx).toBeLessThan(zetaIdx);
    });
  });

  // -------------------------------------------------------------------------
  // findInterfaceRelEdgeProps coverage
  // -------------------------------------------------------------------------

  describe('findInterfaceRelEdgeProps (via interface emissions)', () => {
    it('should return undefined when interface is not found in schema', () => {
      // Interface references a non-existent implementor
      const ifaceRel = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
      });

      const schema = makeSchema(
        new Map(), // No nodes at all
        new Map([
          [
            'Entity',
            makeInterfaceDef(
              'Entity',
              [makeProp('id')],
              [ifaceRel],
              ['NonExistent'],
            ),
          ],
        ]),
      );

      const output = emitConnectionEdgeTypes(schema);

      // Should not emit properties since implementor doesn't exist
      expect(output).not.toContain('EntityResourcesRelationshipProperties');
    });

    it('should return undefined when implementor exists but has no matching rel field', () => {
      const ifaceRel = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
      });

      // Organization node has no 'resources' relationship
      const schema = makeSchema(
        new Map([
          ['Organization', makeNodeDef('Organization', [makeProp('id')])],
        ]),
        new Map([
          [
            'Entity',
            makeInterfaceDef(
              'Entity',
              [makeProp('id')],
              [ifaceRel],
              ['Organization'],
            ),
          ],
        ]),
      );

      const output = emitConnectionEdgeTypes(schema);

      // No edge properties should be emitted
      expect(output).not.toContain('EntityResourcesRelationshipProperties');
      expect(output).not.toContain('EntityResourcesEdgeWhere');
    });

    it('should return undefined when implementor rel has no properties', () => {
      const ifaceRel = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
      });
      // Implementor has the rel field but without properties
      const implRel = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
        // no properties
      });

      const schema = makeSchema(
        new Map([
          [
            'Organization',
            makeNodeDef('Organization', [makeProp('id')], [implRel]),
          ],
        ]),
        new Map([
          [
            'Entity',
            makeInterfaceDef(
              'Entity',
              [makeProp('id')],
              [ifaceRel],
              ['Organization'],
            ),
          ],
        ]),
      );

      const output = emitConnectionEdgeTypes(schema);

      expect(output).not.toContain('EntityResourcesRelationshipProperties');
    });

    it('should find edge props from second implementor when first has none', () => {
      const ifaceRel = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
      });
      const implRelNoProps = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
      });
      const implRelWithProps = makeRel({
        fieldName: 'resources',
        type: 'HAS_RESOURCE',
        target: 'Resource',
        properties: 'ResourceProps',
      });

      const schema = makeSchema(
        new Map([
          [
            'Department',
            makeNodeDef('Department', [makeProp('id')], [implRelNoProps]),
          ],
          [
            'Organization',
            makeNodeDef('Organization', [makeProp('id')], [implRelWithProps]),
          ],
        ]),
        new Map([
          [
            'Entity',
            makeInterfaceDef(
              'Entity',
              [makeProp('id')],
              [ifaceRel],
              ['Department', 'Organization'],
            ),
          ],
        ]),
      );

      const output = emitConnectionEdgeTypes(schema);

      // Should find edge props from Organization (the second implementor)
      expect(output).toContain(
        'EntityResourcesRelationshipProperties = ResourceProps;',
      );
    });
  });

  it('should return only PageInfo for schema with no relationships', () => {
    const schema = makeSchema(
      new Map([['Book', makeNodeDef('Book', [makeProp('id')])]]),
    );

    const output = emitConnectionEdgeTypes(schema);

    expect(output).toContain('export type PageInfo = {');
    expect(output).not.toContain('Connection = {');
    expect(output).not.toContain('Relationship = {');
  });
});
