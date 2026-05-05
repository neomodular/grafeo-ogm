import { MutationCompiler } from '../src/compilers/mutation.compiler';
import {
  NodeDefinition,
  SchemaMetadata,
  PropertyDefinition,
  RelationshipDefinition,
} from '../src/schema/types';

// ─── Helper factories ────────────────────────────────────────────

function prop(
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

function rel(
  fieldName: string,
  type: string,
  target: string,
  overrides: Partial<RelationshipDefinition> = {},
): RelationshipDefinition {
  return {
    fieldName,
    type,
    direction: 'OUT',
    target,
    isArray: false,
    isRequired: false,
    ...overrides,
  };
}

function nodeDef(
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

// ─── Mock schema ─────────────────────────────────────────────────

const statusNode = nodeDef('Status', [
  prop('id', { isGenerated: true }),
  prop('name'),
]);

const resourceNode = nodeDef('Resource', [
  prop('id', { isGenerated: true }),
  prop('title'),
]);

const publisherNode = nodeDef('Publisher', [
  prop('id', { isGenerated: true }),
  prop('name'),
]);

const shelfRowNode = nodeDef('ShelfRow', [
  prop('id', { isGenerated: true }),
  prop('label'),
]);

const authorTradeNameNode = nodeDef('AuthorPenName', [
  prop('id', { isGenerated: true }),
  prop('name'),
]);

const authorSimilarNameNode = nodeDef('AuthorAlias', [
  prop('id', { isGenerated: true }),
  prop('name'),
]);

const bookNode = nodeDef(
  'Book',
  [prop('id', { isGenerated: true }), prop('title'), prop('isbn')],
  [rel('hasStatus', 'DRUG_HAS_STATUS', 'Status')],
);

const equipmentNode = nodeDef(
  'Equipment',
  [prop('id', { isGenerated: true }), prop('name')],
  [
    rel('resource', 'IS_RESOURCE_OF', 'Resource'),
    rel('publishers', 'HAS_PUBLISHERS', 'Publisher', { isArray: true }),
    rel('shelfRows', 'GRID_ROWS', 'ShelfRow', {
      isArray: true,
      properties: 'ShelfRowEdgeProps',
    }),
  ],
);

const authorNode = nodeDef(
  'Author',
  [prop('id', { isGenerated: true }), prop('authorName')],
  [
    rel('hasStatus', 'CHART_HAS_STATUS', 'Status'),
    rel('hasBooks', 'CHART_HAS_BOOKS', 'Book', { isArray: true }),
  ],
);

const resourceNodeWithRel = nodeDef(
  'Resource',
  [prop('id', { isGenerated: true }), prop('title')],
  [
    rel('showsForEntities', 'RESOURCE_SHOWS_FOR', 'Department', {
      isArray: true,
    }),
  ],
);

const departmentNode = nodeDef('Department', [
  prop('id', { isGenerated: true }),
  prop('name'),
]);

const bookDetailsOverrideNode = nodeDef(
  'BookDetailsOverride',
  [prop('id', { isGenerated: true })],
  [
    rel('brandedAs', 'CHART_BRANDED_AS', 'AuthorPenName'),
    rel('alsoKnownAs', 'CHART_ALSO_KNOWN_AS', 'AuthorAlias'),
  ],
);

// Node with NO isGenerated properties (for buildGeneratedIdClause fallback)
const tagNode = nodeDef('Tag', [prop('label')]);

const parentWithTagRel = nodeDef(
  'Article',
  [prop('id', { isGenerated: true }), prop('title')],
  [rel('tags', 'HAS_TAG', 'Tag', { isArray: true })],
);

const inboundRelNode = nodeDef(
  'Category',
  [prop('id', { isGenerated: true }), prop('name')],
  [
    rel('parentCategory', 'HAS_SUBCATEGORY', 'Category', {
      direction: 'IN',
    }),
  ],
);

// Nodes for relationship filter tests (_SOME, _NONE, _ALL)
const wzConfigNode = nodeDef('WeightZoneConfiguration', [
  prop('id', { isGenerated: true }),
  prop('name'),
]);

const weightZoneNode = nodeDef(
  'WeightZone',
  [
    prop('id', { isGenerated: true }),
    prop('midpoint', { type: 'Float' }),
    prop('lowerLimit', { type: 'Float' }),
    prop('upperLimit', { type: 'Float' }),
  ],
  [
    rel('configurations', 'BELONGS_TO_CONFIG', 'WeightZoneConfiguration', {
      isArray: true,
    }),
  ],
);

const publisherWithWzNode = nodeDef(
  'PublisherWz',
  [prop('id', { isGenerated: true }), prop('name')],
  [
    rel('isDefinedByWeightZones', 'DEFINES_POPULATION_SCOPE', 'WeightZone', {
      isArray: true,
    }),
  ],
);

// Nodes for array connect with relationship filter tests (Category → Resource → Author)
const resourceWithAuthorNode = nodeDef(
  'ResourceWithAuthor',
  [prop('id', { isGenerated: true })],
  [
    rel('author', 'IS_RESOURCE_OF', 'Author', { direction: 'IN' }),
    rel('algorithm', 'IS_RESOURCE_OF', 'Algorithm', { direction: 'IN' }),
  ],
);

const algorithmNode = nodeDef('Algorithm', [
  prop('id', { isGenerated: true }),
  prop('name'),
]);

const bookCategoryNode = nodeDef(
  'BookCategory',
  [prop('id', { isGenerated: true }), prop('name')],
  [
    rel(
      'contentResources',
      'RESOURCE_BELONGS_TO_BOOK_CATEGORY',
      'ResourceWithAuthor',
      {
        isArray: true,
        direction: 'IN',
        properties: 'ResourceCategoryEdgeProps',
      },
    ),
  ],
);

// Nodes for connection-level NOT/AND/OR tests
const tierNode = nodeDef('Tier', [
  prop('id', { isGenerated: true }),
  prop('name'),
]);

const concentrationNode = nodeDef(
  'Edition',
  [prop('id', { isGenerated: true }), prop('value', { type: 'Float' })],
  [
    rel('tiers', 'GRANTS_ACCESS_TO_CONCENTRATION', 'Tier', {
      isArray: true,
      direction: 'IN',
    }),
  ],
);

const schema: SchemaMetadata = {
  nodes: new Map([
    ['Book', bookNode],
    ['Status', statusNode],
    ['Resource', resourceNode],
    ['Publisher', publisherNode],
    ['ShelfRow', shelfRowNode],
    ['Equipment', equipmentNode],
    ['Author', authorNode],
    ['Department', departmentNode],
    ['AuthorPenName', authorTradeNameNode],
    ['AuthorAlias', authorSimilarNameNode],
    ['WeightZoneConfiguration', wzConfigNode],
    ['WeightZone', weightZoneNode],
    ['PublisherWz', publisherWithWzNode],
    ['BookDetailsOverride', bookDetailsOverrideNode],
    ['Category', inboundRelNode],
    ['Tag', tagNode],
    ['Article', parentWithTagRel],
    ['Tier', tierNode],
    ['Edition', concentrationNode],
    ['ResourceWithAuthor', resourceWithAuthorNode],
    ['Algorithm', algorithmNode],
    ['BookCategory', bookCategoryNode],
  ]),
  interfaces: new Map(),
  relationshipProperties: new Map([
    [
      'ShelfRowEdgeProps',
      {
        typeName: 'ShelfRowEdgeProps',
        properties: new Map([['position', prop('position', { type: 'Int' })]]),
      },
    ],
    [
      'ResourceCategoryEdgeProps',
      {
        typeName: 'ResourceCategoryEdgeProps',
        properties: new Map([['position', prop('position', { type: 'Int' })]]),
      },
    ],
  ]),
  enums: new Map(),
  unions: new Map(),
};

// ─── Tests ───────────────────────────────────────────────────────

describe('MutationCompiler', () => {
  let compiler: MutationCompiler;

  beforeEach(() => {
    compiler = new MutationCompiler(schema);
  });

  // 1. Simple create with scalar properties
  describe('compileCreate', () => {
    it('should create a node with scalar properties', () => {
      const result = compiler.compileCreate(
        [{ title: 'Book A', isbn: 'D001' }],
        bookNode,
      );

      expect(result.cypher).toContain('CREATE (n:\`Book\`');
      expect(result.cypher).toContain('\`id\`: randomUUID()');
      expect(result.cypher).toContain('\`title\`: $create0_title');
      expect(result.cypher).toContain('\`isbn\`: $create0_isbn');
      expect(result.cypher).toContain('RETURN n');
      expect(result.params).toEqual({
        create0_title: 'Book A',
        create0_isbn: 'D001',
      });
    });

    // 2. Create with nested relationship create
    it('should create a node with nested relationship create', () => {
      const result = compiler.compileCreate(
        [{ name: 'Equipment A', resource: { create: { node: {} } } }],
        equipmentNode,
      );

      expect(result.cypher).toContain('CREATE (n:\`Equipment\`');
      expect(result.cypher).toContain('\`name\`: $create0_name');
      expect(result.cypher).toContain('CREATE (n_c0:\`Resource\`');
      expect(result.cypher).toContain('\`id\`: randomUUID()');
      expect(result.cypher).toContain(
        'CREATE (n)-[:\`IS_RESOURCE_OF\`]->(n_c0)',
      );
      expect(result.cypher).toContain('RETURN n');
    });

    // 3. Create with connect
    it('should create a node with connect', () => {
      const result = compiler.compileCreate(
        [
          {
            title: 'Book A',
            hasStatus: {
              connect: { where: { node: { id: 'status1' } } },
            },
          },
        ],
        bookNode,
      );

      expect(result.cypher).toContain('CREATE (n:\`Book\`');
      expect(result.cypher).toContain('WITH n');
      expect(result.cypher).toContain('MATCH (n_cn0:\`Status\`)');
      expect(result.cypher).toContain(
        'n_cn0.\`id\` = $create0_hasStatus_conn0_id',
      );
      expect(result.cypher).toContain(
        'MERGE (n)-[:\`DRUG_HAS_STATUS\`]->(n_cn0)',
      );
      expect(result.params).toMatchObject({
        create0_hasStatus_conn0_id: 'status1',
      });
    });

    // 4. Create with nested relationship where target has no isGenerated properties
    it('should create a nested node with no generated IDs using buildGeneratedIdClause fallback', () => {
      const result = compiler.compileCreate(
        [{ title: 'My Article', tags: { create: { node: {} } } }],
        parentWithTagRel,
      );

      expect(result.cypher).toContain('CREATE (n:\`Article\`');
      expect(result.cypher).toContain('\`title\`: $create0_title');
      expect(result.cypher).toContain('CREATE (n_c0:\`Tag\`');
      // Tag has no isGenerated properties, so buildGeneratedIdClause returns empty
      // The CREATE clause should still work (empty properties block)
      expect(result.cypher).toContain('CREATE (n)-[:\`HAS_TAG\`]->(n_c0)');
    });
  });

  describe('compileUpdate', () => {
    const baseWhere = { id: 'node1' };
    const baseWhereResult = {
      cypher: 'n.id = $param0',
      params: { param0: 'node1' },
    };

    // 4. Simple property update (SET)
    it('should generate SET for property updates', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        { title: 'Updated Book' },
        undefined,
        undefined,
        bookNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain('MATCH (n:\`Book\`)');
      expect(result.cypher).toContain('WHERE n.id = $param0');
      expect(result.cypher).toContain('SET n.\`title\` = $update_title');
      expect(result.cypher).toContain('RETURN n');
      expect(result.params).toMatchObject({
        param0: 'node1',
        update_title: 'Updated Book',
      });
    });

    // 5. Connect single by ID
    it('should connect a single relationship by ID', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        {
          hasStatus: {
            where: { node: { id: 'status1' } },
          },
        },
        undefined,
        authorNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain('MATCH (n:\`Author\`)');
      expect(result.cypher).toContain('WITH n');
      expect(result.cypher).toContain('MATCH (target:\`Status\`)');
      expect(result.cypher).toContain(
        'WHERE target.\`id\` = $connect_hasStatus_id',
      );
      expect(result.cypher).toContain(
        'MERGE (n)-[:\`CHART_HAS_STATUS\`]->(target)',
      );
      expect(result.params).toMatchObject({
        connect_hasStatus_id: 'status1',
      });
    });

    // 6. Connect single by name property
    it('should connect a single relationship by name property', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        {
          hasStatus: {
            where: { node: { name: 'Active' } },
          },
        },
        undefined,
        authorNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain('MATCH (target:\`Status\`)');
      expect(result.cypher).toContain(
        'WHERE target.\`name\` = $connect_hasStatus_name',
      );
      expect(result.params).toMatchObject({
        connect_hasStatus_name: 'Active',
      });
    });

    // 7. Connect array with UNWIND
    it('should connect array relationships using UNWIND', () => {
      const connectItems = [
        { where: { node: { id: 'pop1' } } },
        { where: { node: { id: 'pop2' } } },
      ];

      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        { publishers: connectItems },
        undefined,
        equipmentNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain('UNWIND $connect_publishers AS connItem');
      expect(result.cypher).toContain('MATCH (target:\`Publisher\`)');
      expect(result.cypher).toContain(
        'WHERE target.\`id\` = connItem.where.node.id',
      );
      expect(result.cypher).toContain(
        'MERGE (n)-[:\`HAS_PUBLISHERS\`]->(target)',
      );
      expect(result.params).toMatchObject({
        connect_publishers: connectItems,
      });
    });

    // 7b. Array connect with _IN operator suffix
    it('should handle _IN operator in array connect WHERE', () => {
      const connectItems = [{ where: { node: { id_IN: ['tier1', 'tier2'] } } }];

      const result = compiler.compileUpdate(
        { id: 'conc1' },
        undefined,
        { tiers: connectItems },
        undefined,
        concentrationNode,
        { cypher: 'n.id = $param0', params: { param0: 'conc1' } },
      );

      expect(result.cypher).toContain('UNWIND $connect_tiers AS connItem');
      expect(result.cypher).toContain('MATCH (target:\`Tier\`)');
      expect(result.cypher).toContain(
        'WHERE target.\`id\` IN connItem.where.node.id_IN',
      );
      expect(result.cypher).toContain(
        'MERGE (n)<-[:\`GRANTS_ACCESS_TO_CONCENTRATION\`]-(target)',
      );
    });

    // 8. Connect with edge properties
    it('should connect with edge properties', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        {
          shelfRows: {
            where: { node: { id: 'row1' } },
            edge: { position: 3 },
          },
        },
        undefined,
        equipmentNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain('MATCH (target:\`ShelfRow\`)');
      expect(result.cypher).toContain(
        'WHERE target.\`id\` = $connect_shelfRows_id',
      );
      expect(result.cypher).toContain('MERGE (n)-[r:\`GRID_ROWS\`]->(target)');
      expect(result.cypher).toContain(
        'SET r.\`position\` = $connect_shelfRows_edge_position',
      );
      expect(result.params).toMatchObject({
        connect_shelfRows_id: 'row1',
        connect_shelfRows_edge_position: 3,
      });
    });

    // 8b. Connect array with edge properties using UNWIND
    it('should connect array relationships with edge properties using UNWIND', () => {
      const connectItems = [
        { where: { node: { id: 'row1' } }, edge: { position: 0 } },
        { where: { node: { id: 'row2' } }, edge: { position: 1 } },
      ];

      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        { shelfRows: connectItems },
        undefined,
        equipmentNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain('UNWIND $connect_shelfRows AS connItem');
      expect(result.cypher).toContain('MATCH (target:\`ShelfRow\`)');
      expect(result.cypher).toContain(
        'WHERE target.\`id\` = connItem.where.node.id',
      );
      expect(result.cypher).toContain(
        'SET r.\`position\` = connItem.edge.position',
      );
      expect(result.params).toMatchObject({
        connect_shelfRows: connectItems,
      });
    });

    // 8c. Connect with undefined edge properties should skip them
    it('should skip undefined edge properties in single connect', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        {
          shelfRows: {
            where: { node: { id: 'row1' } },
            edge: { position: 3, optionalProp: undefined },
          },
        },
        undefined,
        equipmentNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain(
        'SET r.\`position\` = $connect_shelfRows_edge_position',
      );
      expect(result.cypher).not.toContain('optionalProp');
      expect(result.params).toMatchObject({
        connect_shelfRows_edge_position: 3,
      });
      expect(result.params).not.toHaveProperty(
        'connect_shelfRows_edge_optionalProp',
      );
    });

    // 8d. Connect array with undefined edge properties should strip them
    it('should strip undefined edge properties in array connect', () => {
      const connectItems = [
        {
          where: { node: { id: 'row1' } },
          edge: { position: 0, extra: undefined },
        },
        {
          where: { node: { id: 'row2' } },
          edge: { position: 1, extra: undefined },
        },
      ];

      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        { shelfRows: connectItems },
        undefined,
        equipmentNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain(
        'SET r.\`position\` = connItem.edge.position',
      );
      expect(result.cypher).not.toContain('extra');
      // Verify the stored param array has edge objects without undefined keys
      const storedItems = result.params.connect_shelfRows as Record<
        string,
        unknown
      >[];
      for (const item of storedItems) {
        const edge = (item as Record<string, unknown>).edge as Record<
          string,
          unknown
        >;
        expect(edge).not.toHaveProperty('extra');
      }
    });

    // 9. Disconnect blanket (empty where)
    it('should disconnect all relationships (blanket)', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        undefined,
        { hasStatus: {} },
        authorNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain('WITH n');
      expect(result.cypher).toContain(
        'OPTIONAL MATCH (n)-[r_hasStatus_0:\`CHART_HAS_STATUS\`]->()',
      );
      expect(result.cypher).toContain('DELETE r_hasStatus_0');
    });

    // 10. Disconnect specific with NOT condition
    it('should disconnect with NOT condition', () => {
      // Use resourceNodeWithRel for the Resource node that has showsForEntities
      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        undefined,
        {
          showsForEntities: {
            where: {
              node: {
                NOT: { id_IN: ['dept1', 'dept2'] },
              },
            },
          },
        },
        resourceNodeWithRel,
        baseWhereResult,
      );

      expect(result.cypher).toContain('WITH n');
      expect(result.cypher).toContain(
        'OPTIONAL MATCH (n)-[r_showsForEntities_0:\`RESOURCE_SHOWS_FOR\`]->(target_showsForEntities_0:\`Department\`)',
      );
      expect(result.cypher).toContain(
        'WHERE NOT target_showsForEntities_0.\`id\` IN $disconnect_showsForEntities_0_NOT_id_IN',
      );
      expect(result.cypher).toContain('DELETE r_showsForEntities_0');
      expect(result.params).toMatchObject({
        disconnect_showsForEntities_0_NOT_id_IN: ['dept1', 'dept2'],
      });
    });

    // 16. Direction handling (IN vs OUT)
    it('should handle IN direction for connects', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        {
          parentCategory: {
            where: { node: { id: 'parent1' } },
          },
        },
        undefined,
        inboundRelNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain(
        'MERGE (n)<-[:\`HAS_SUBCATEGORY\`]-(target)',
      );
    });

    it('should handle IN direction for blanket disconnect', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        undefined,
        { parentCategory: {} },
        inboundRelNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain(
        'OPTIONAL MATCH (n)<-[r_parentCategory_0:\`HAS_SUBCATEGORY\`]-()',
      );
      expect(result.cypher).toContain('DELETE r_parentCategory_0');
    });

    // 16b. Disconnect with NOT condition using non-_IN property
    it('should disconnect with NOT condition on simple property', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        undefined,
        {
          showsForEntities: {
            where: {
              node: {
                NOT: { name: 'Engineering' },
              },
            },
          },
        },
        resourceNodeWithRel,
        baseWhereResult,
      );

      expect(result.cypher).toContain(
        'WHERE target_showsForEntities_0.\`name\` <> $disconnect_showsForEntities_0_NOT_name',
      );
      expect(result.params).toMatchObject({
        disconnect_showsForEntities_0_NOT_name: 'Engineering',
      });
    });

    // 16c. Disconnect with simple property condition (not NOT, not _IN)
    it('should disconnect with a simple property where condition', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        undefined,
        undefined,
        {
          showsForEntities: {
            where: {
              node: {
                name: 'Engineering',
              },
            },
          },
        },
        resourceNodeWithRel,
        baseWhereResult,
      );

      expect(result.cypher).toContain('WITH n');
      expect(result.cypher).toContain(
        'OPTIONAL MATCH (n)-[r_showsForEntities_0:\`RESOURCE_SHOWS_FOR\`]->(target_showsForEntities_0:\`Department\`)',
      );
      expect(result.cypher).toContain(
        'WHERE target_showsForEntities_0.\`name\` = $disconnect_showsForEntities_0_name',
      );
      expect(result.cypher).toContain('DELETE r_showsForEntities_0');
      expect(result.params).toMatchObject({
        disconnect_showsForEntities_0_name: 'Engineering',
      });
    });

    // 16d. Disconnect with NOT at connection WHERE level (wrapping node)
    it('should disconnect with NOT wrapping node in connection WHERE', () => {
      const result = compiler.compileUpdate(
        { id: 'conc1' },
        undefined,
        undefined,
        {
          tiers: [
            {
              where: {
                NOT: {
                  node: {
                    id_IN: ['tier1', 'tier2'],
                  },
                },
              },
            },
          ],
        },
        concentrationNode,
        { cypher: 'n.id = $param0', params: { param0: 'conc1' } },
      );

      expect(result.cypher).toContain(
        'OPTIONAL MATCH (n)<-[r_tiers_0:\`GRANTS_ACCESS_TO_CONCENTRATION\`]-(target_tiers_0:\`Tier\`)',
      );
      expect(result.cypher).toContain(
        'WHERE NOT (target_tiers_0.\`id\` IN $disconnect_tiers_0_NOT_id_IN)',
      );
      expect(result.cypher).toContain('DELETE r_tiers_0');
      expect(result.params).toMatchObject({
        disconnect_tiers_0_NOT_id_IN: ['tier1', 'tier2'],
      });
    });

    // 16e. Disconnect with connection-level node key (explicit node: {...})
    it('should disconnect with explicit node key in connection WHERE', () => {
      const result = compiler.compileUpdate(
        { id: 'conc1' },
        undefined,
        undefined,
        {
          tiers: [
            {
              where: {
                node: {
                  id_IN: ['tier3'],
                },
              },
            },
          ],
        },
        concentrationNode,
        { cypher: 'n.id = $param0', params: { param0: 'conc1' } },
      );

      expect(result.cypher).toContain(
        'WHERE target_tiers_0.\`id\` IN $disconnect_tiers_0_id_IN',
      );
      expect(result.params).toMatchObject({
        disconnect_tiers_0_id_IN: ['tier3'],
      });
    });

    // 17. Multiple operations in one update (SET + connect + disconnect)
    it('should combine SET, connect, and disconnect in one update', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        { authorName: 'Updated Author' },
        {
          hasStatus: {
            where: { node: { id: 'status2' } },
          },
        },
        { hasStatus: {} },
        authorNode,
        baseWhereResult,
      );

      // SET should be present
      expect(result.cypher).toContain(
        'SET n.\`authorName\` = $update_authorName',
      );
      // Connect should be present
      expect(result.cypher).toContain(
        'MERGE (n)-[:\`CHART_HAS_STATUS\`]->(target)',
      );
      // Disconnect should be present
      expect(result.cypher).toContain('DELETE r_hasStatus_0');
      expect(result.cypher).toContain('RETURN n');

      // Disconnect must come BEFORE connect so blanket disconnects
      // don't remove newly-connected relationships
      const disconnectIdx = result.cypher.indexOf('DELETE r_hasStatus_0');
      const connectIdx = result.cypher.indexOf(
        'MERGE (n)-[:`CHART_HAS_STATUS`]->(target)',
      );
      expect(disconnectIdx).toBeLessThan(connectIdx);
    });

    // 18. Nested relationship create within update body
    it('should handle nested create within update body', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        {
          authorName: 'Updated',
          hasBooks: [
            {
              create: [
                {
                  node: { title: 'New Book' },
                },
              ],
            },
          ],
        },
        undefined,
        undefined,
        authorNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain(
        'SET n.\`authorName\` = $update_authorName',
      );
      expect(result.cypher).toContain('WITH n');
      expect(result.cypher).toContain('CREATE (n_cr0:\`Book\`');
      expect(result.cypher).toContain(
        'CREATE (n)-[:\`CHART_HAS_BOOKS\`]->(n_cr0)',
      );
    });

    // 19. Nested connect/disconnect within update body
    it('should handle connect and disconnect within update body', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        {
          hasStatus: {
            connect: {
              where: { node: { id: 'status-new' } },
            },
            disconnect: {
              where: { node: { NOT: { id: 'status-new' } } },
            },
          },
        },
        undefined,
        undefined,
        authorNode,
        baseWhereResult,
      );

      // Connect should create a MERGE with the relationship
      expect(result.cypher).toContain('MERGE (n)-[:\`CHART_HAS_STATUS\`]->');
      // Disconnect should delete the relationship
      expect(result.cypher).toContain('DELETE r_disc_hasStatus_0');
    });

    // 20. Nested update within update body
    it('should handle nested update with WHERE within update body', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        {
          hasBooks: [
            {
              update: {
                node: { title: 'Renamed Book' },
              },
              where: {
                node: { id: 'book1' },
              },
            },
          ],
        },
        undefined,
        undefined,
        authorNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain('WITH n');
      expect(result.cypher).toContain(
        'MATCH (n)-[r_hasBooks_0:\`CHART_HAS_BOOKS\`]->(n_u0:\`Book\`)',
      );
      expect(result.cypher).toContain(
        'WHERE n_u0.\`id\` = $update_hasBooks_0_where_id',
      );
      expect(result.cypher).toContain(
        'SET n_u0.\`title\` = $update_hasBooks_0_set_title',
      );
      expect(result.params).toMatchObject({
        update_hasBooks_0_where_id: 'book1',
        update_hasBooks_0_set_title: 'Renamed Book',
      });
    });

    // 21. Edge property update within update body
    it('should SET edge properties on the relationship variable', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        {
          shelfRows: [
            {
              update: {
                edge: { position: 5 },
              },
              where: {
                node: { id: 'row1' },
              },
            },
          ],
        },
        undefined,
        undefined,
        equipmentNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain(
        'MATCH (n)-[r_shelfRows_0:\`GRID_ROWS\`]->(n_u0:\`ShelfRow\`)',
      );
      expect(result.cypher).toContain(
        'WHERE n_u0.\`id\` = $update_shelfRows_0_where_id',
      );
      expect(result.cypher).toContain(
        'SET r_shelfRows_0.\`position\` = $update_shelfRows_0_edge_position',
      );
      expect(result.params).toMatchObject({
        update_shelfRows_0_where_id: 'row1',
        update_shelfRows_0_edge_position: 5,
      });
      // Should NOT set edge as a node property
      expect(result.cypher).not.toContain('n_u0.edge');
    });

    // 22. Edge property update should skip undefined values
    it('should skip undefined edge properties in update', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        {
          shelfRows: [
            {
              update: {
                edge: {
                  position: 3,
                  description: undefined,
                  customSteps: undefined,
                },
              },
              where: {
                node: { id: 'row1' },
              },
            },
          ],
        },
        undefined,
        undefined,
        equipmentNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain(
        'SET r_shelfRows_0.\`position\` = $update_shelfRows_0_edge_position',
      );
      expect(result.params).toMatchObject({
        update_shelfRows_0_edge_position: 3,
      });
      // undefined properties should not appear
      expect(result.cypher).not.toContain('description');
      expect(result.cypher).not.toContain('customSteps');
      expect(result.params).not.toHaveProperty(
        'update_shelfRows_0_edge_description',
      );
      expect(result.params).not.toHaveProperty(
        'update_shelfRows_0_edge_customSteps',
      );
    });

    // 23. Combined node + edge property update
    it('should update both node and edge properties together', () => {
      const result = compiler.compileUpdate(
        baseWhere,
        {
          shelfRows: [
            {
              update: {
                node: { label: 'Updated Row' },
                edge: { position: 10 },
              },
              where: {
                node: { id: 'row1' },
              },
            },
          ],
        },
        undefined,
        undefined,
        equipmentNode,
        baseWhereResult,
      );

      expect(result.cypher).toContain(
        'SET n_u0.\`label\` = $update_shelfRows_0_set_label',
      );
      expect(result.cypher).toContain(
        'SET r_shelfRows_0.\`position\` = $update_shelfRows_0_edge_position',
      );
      expect(result.params).toMatchObject({
        update_shelfRows_0_set_label: 'Updated Row',
        update_shelfRows_0_edge_position: 10,
      });
    });

    // v1.7.2 BLOCKER regression: nested `delete: { where: { node: {...} } }`
    // pre-1.7.2 emitted inline `prop = $param` for every key, ignoring
    // operator suffixes — `name_CONTAINS` would target a non-existent
    // property and silently delete nothing. Verify operator suffixes are
    // now resolved through the same builder used by disconnect.
    it('honors operator suffixes in nested delete.where.node (v1.7.2)', () => {
      const result = compiler.compileUpdate(
        { id: 'a1' },
        {
          hasBooks: [
            {
              delete: {
                where: { node: { title_CONTAINS: 'Draft' } },
              },
            },
          ],
        },
        undefined,
        undefined,
        authorNode,
        { cypher: 'n.id = $param0', params: { param0: 'a1' } },
      );

      // The fix: operator suffix is parsed → emits CONTAINS, not equality
      expect(result.cypher).toContain(
        'OPTIONAL MATCH (n)-[r_del_hasBooks_0_0:\`CHART_HAS_BOOKS\`]->',
      );
      expect(result.cypher).toContain('CONTAINS');
      expect(result.cypher).toContain('DETACH DELETE');
      // Pre-1.7.2 would have emitted `n_del0.\`title_CONTAINS\` = $...`
      // — assert that bug shape never reappears.
      expect(result.cypher).not.toContain('`title_CONTAINS`');
    });
  });

  describe('compileDelete', () => {
    const baseWhereResult = {
      cypher: 'n.id = $param0',
      params: { param0: 'node1' },
    };

    // 11. Delete simple (DETACH DELETE)
    it('should generate simple DETACH DELETE', () => {
      const result = compiler.compileDelete(bookNode, baseWhereResult);

      expect(result.cypher).toContain('MATCH (n:\`Book\`)');
      expect(result.cypher).toContain('WHERE n.id = $param0');
      expect(result.cypher).toContain('DETACH DELETE n');
      expect(result.params).toMatchObject({ param0: 'node1' });
    });

    // 12. Delete with cascade (nested delete)
    it('should generate cascade delete with OPTIONAL MATCH', () => {
      const result = compiler.compileDelete(
        bookDetailsOverrideNode,
        baseWhereResult,
        {
          brandedAs: {},
          alsoKnownAs: {},
        },
      );

      expect(result.cypher).toContain('MATCH (n:\`BookDetailsOverride\`)');
      expect(result.cypher).toContain(
        'OPTIONAL MATCH (n)-[:\`CHART_BRANDED_AS\`]->(cascade_0:\`AuthorPenName\`)',
      );
      expect(result.cypher).toContain(
        'OPTIONAL MATCH (n)-[:\`CHART_ALSO_KNOWN_AS\`]->(cascade_1:\`AuthorAlias\`)',
      );
      expect(result.cypher).toContain('DETACH DELETE cascade_0, cascade_1, n');
    });

    // 12b. Delete with cascade on IN-direction relationship
    it('should generate cascade delete with IN-direction relationship arrow', () => {
      const result = compiler.compileDelete(inboundRelNode, baseWhereResult, {
        parentCategory: {},
      });

      expect(result.cypher).toContain('MATCH (n:\`Category\`)');
      expect(result.cypher).toContain(
        'OPTIONAL MATCH (n)<-[:\`HAS_SUBCATEGORY\`]-(cascade_0:\`Category\`)',
      );
      expect(result.cypher).toContain('DETACH DELETE cascade_0, n');
    });
  });

  describe('compileSetLabels', () => {
    const baseWhereResult = {
      cypher: 'n.id = $param0',
      params: { param0: 'node1' },
    };

    // 13. setLabels — add only
    it('should add labels', () => {
      const result = compiler.compileSetLabels(
        bookNode,
        baseWhereResult,
        ['Active'],
        undefined,
      );

      expect(result.cypher).toContain('MATCH (n:\`Book\`)');
      expect(result.cypher).toContain('WHERE n.id = $param0');
      expect(result.cypher).toContain('SET n:\`Active\`');
    });

    // 14. setLabels — remove only
    it('should remove labels', () => {
      const result = compiler.compileSetLabels(
        bookNode,
        baseWhereResult,
        undefined,
        ['Draft'],
      );

      expect(result.cypher).toContain('MATCH (n:\`Book\`)');
      expect(result.cypher).toContain('REMOVE n:\`Draft\`');
    });

    // 15. setLabels — add and remove
    it('should add and remove labels', () => {
      const result = compiler.compileSetLabels(
        bookNode,
        baseWhereResult,
        ['Active'],
        ['Draft'],
      );

      expect(result.cypher).toContain('SET n:\`Active\`');
      expect(result.cypher).toContain('REMOVE n:\`Draft\`');
    });

    // v1.7.4 regression — addLabels ∩ removeLabels was silently
    // executed left-to-right (SET then REMOVE), leaving the label
    // REMOVED. Now throws so the developer notices the contradiction.
    it('throws on addLabels and removeLabels overlap (v1.7.4)', () => {
      expect(() =>
        compiler.compileSetLabels(
          bookNode,
          baseWhereResult,
          ['Active', 'Premium'],
          ['Draft', 'Active'],
        ),
      ).toThrow(/addLabels and removeLabels overlap on \["Active"\]/);
    });
  });

  // ─── Relationship filter tests (_SOME, _NONE, _ALL) ──────────
  describe('relationship filters in connect WHERE', () => {
    it('should handle _SOME relationship filter in create connect', () => {
      const result = compiler.compileCreate(
        [
          {
            name: 'Pediatric',
            isDefinedByWeightZones: {
              connect: [
                {
                  where: {
                    node: {
                      midpoint_GTE: 2.5,
                      midpoint_LTE: 36.9,
                      configurations_SOME: {
                        name: 'Standard',
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
        publisherWithWzNode,
      );

      // Should generate EXISTS subquery for configurations_SOME
      expect(result.cypher).toContain('EXISTS');
      expect(result.cypher).toContain('\`BELONGS_TO_CONFIG\`');
      expect(result.cypher).toContain('\`WeightZoneConfiguration\`');
      // Should still have the scalar conditions
      expect(result.cypher).toContain('\`midpoint\` >=');
      expect(result.cypher).toContain('\`midpoint\` <=');
      // Should parameterize the config name
      expect(Object.values(result.params)).toContain('Standard');
    });

    it('should handle _NONE relationship filter in create connect', () => {
      const result = compiler.compileCreate(
        [
          {
            name: 'Test',
            isDefinedByWeightZones: {
              connect: [
                {
                  where: {
                    node: {
                      configurations_NONE: {
                        name: 'Excluded',
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
        publisherWithWzNode,
      );

      expect(result.cypher).toContain('NOT EXISTS');
      expect(result.cypher).toContain('\`BELONGS_TO_CONFIG\`');
    });

    it('should handle bare relationship name (defaults to _SOME)', () => {
      const result = compiler.compileCreate(
        [
          {
            name: 'Test',
            isDefinedByWeightZones: {
              connect: [
                {
                  where: {
                    node: {
                      configurations: {
                        name: 'Standard',
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
        publisherWithWzNode,
      );

      // Bare relationship name should default to _SOME
      expect(result.cypher).toContain('EXISTS');
      expect(result.cypher).toContain('\`BELONGS_TO_CONFIG\`');
    });
  });

  describe('array connect with relationship filters (top-level update)', () => {
    it('should use CALL subqueries for array connect with relationship WHERE', () => {
      const whereResult = {
        cypher: 'n.id = $where_id',
        params: { where_id: 'cat-1' },
      };
      const result = compiler.compileUpdate(
        { id: 'cat-1' },
        undefined,
        {
          contentResources: [
            {
              where: { node: { author: { id: 'author-1' } } },
              edge: { position: 0 },
            },
            {
              where: { node: { author: { id: 'author-2' } } },
              edge: { position: 1 },
            },
          ],
        },
        undefined,
        bookCategoryNode,
        whereResult,
      );

      // Should use CALL subqueries (not UNWIND) since author is a relationship
      expect(result.cypher).toContain('CALL {');
      expect(result.cypher).not.toContain('UNWIND');
      // Should generate EXISTS subqueries for author relationship filters
      expect(result.cypher).toContain('EXISTS');
      expect(result.cypher).toContain('\`IS_RESOURCE_OF\`');
      expect(result.cypher).toContain('\`Author\`');
      // Should have edge properties
      expect(result.cypher).toContain('\`position\`');
      // Should have params for both author ids
      const paramValues = Object.values(result.params);
      expect(paramValues).toContain('author-1');
      expect(paramValues).toContain('author-2');
    });

    it('should still use UNWIND for array connect with scalar-only WHERE', () => {
      const whereResult = {
        cypher: 'n.id = $where_id',
        params: { where_id: 'cat-1' },
      };
      const result = compiler.compileUpdate(
        { id: 'cat-1' },
        undefined,
        {
          contentResources: [
            {
              where: { node: { id: 'res-1' } },
              edge: { position: 0 },
            },
            {
              where: { node: { id: 'res-2' } },
              edge: { position: 1 },
            },
          ],
        },
        undefined,
        bookCategoryNode,
        whereResult,
      );

      // Should use UNWIND since id is a scalar property
      expect(result.cypher).toContain('UNWIND');
      expect(result.cypher).not.toContain('CALL {');
    });

    // v1.7.4 regression — heterogeneous array items used to silently
    // drop the diverging keys (only firstItem's keys made it into the
    // WHERE). Now throws to surface the bug at compile time.
    it('throws on heterogeneous connect array shapes (v1.7.4)', () => {
      const whereResult = {
        cypher: 'n.id = $where_id',
        params: { where_id: 'cat-1' },
      };
      expect(() =>
        compiler.compileUpdate(
          { id: 'cat-1' },
          undefined,
          {
            contentResources: [
              { where: { node: { id: 'res-1' } } },
              // Extra `tenantId` key — pre-1.7.4 silently dropped from WHERE
              { where: { node: { id: 'res-2', tenantId: 'X' } } },
            ],
          },
          undefined,
          bookCategoryNode,
          whereResult,
        ),
      ).toThrow(/divergent shapes.*item\[0\].*item\[1\]/);
    });

    it('should handle disconnect with relationship NOT filter before connect', () => {
      const whereResult = {
        cypher: 'n.id = $where_id',
        params: { where_id: 'cat-1' },
      };
      const result = compiler.compileUpdate(
        { id: 'cat-1' },
        undefined,
        {
          contentResources: [
            {
              where: { node: { author: { id: 'author-1' } } },
              edge: { position: 0 },
            },
          ],
        },
        {
          contentResources: [
            {
              where: { node: { NOT: { author: null } } },
            },
          ],
        },
        bookCategoryNode,
        whereResult,
      );

      // Should have both disconnect and connect
      expect(result.cypher).toContain('DELETE');
      expect(result.cypher).toContain('MERGE');
      // Connect should use EXISTS for relationship filter
      expect(result.cypher).toContain('EXISTS');
    });
  });
});
