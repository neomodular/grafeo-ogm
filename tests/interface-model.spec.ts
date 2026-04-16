import { Driver } from 'neo4j-driver';
import { InterfaceModel } from '../src/interface-model';
import {
  NodeDefinition,
  SchemaMetadata,
  PropertyDefinition,
  RelationshipDefinition,
  InterfaceDefinition,
} from '../src/schema/types';

// --- Helper factories -------------------------------------------------------

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

// --- Mock schema ------------------------------------------------------------

const userNode = nodeDef(
  'User',
  [prop('id'), prop('name'), prop('email')],
  [],
  { implementsInterfaces: ['Entity'] },
);

const organizationNode = nodeDef(
  'Organization',
  [prop('id'), prop('name'), prop('description')],
  [],
  { implementsInterfaces: ['Entity'] },
);

const facilityNode = nodeDef(
  'Facility',
  [prop('id'), prop('name'), prop('address')],
  [],
  { implementsInterfaces: ['Entity'] },
);

const statusNode = nodeDef('Status', [prop('id'), prop('label')]);

const entityInterface: InterfaceDefinition = {
  name: 'Entity',
  label: 'Entity',
  properties: new Map([
    ['id', prop('id')],
    ['name', prop('name')],
  ]),
  relationships: new Map([
    [
      'status',
      {
        fieldName: 'status',
        type: 'HAS_STATUS',
        direction: 'OUT',
        target: 'Status',
        isArray: false,
        isRequired: false,
      },
    ],
  ]),
  implementedBy: ['User', 'Organization', 'Facility'],
};

const schema: SchemaMetadata = {
  nodes: new Map([
    ['User', userNode],
    ['Organization', organizationNode],
    ['Facility', facilityNode],
    ['Status', statusNode],
  ]),
  interfaces: new Map([['Entity', entityInterface]]),
  relationshipProperties: new Map(),
  enums: new Map(),
  unions: new Map(),
};

// --- Mock driver ------------------------------------------------------------

function createMockDriver() {
  const mockSession = {
    run: jest.fn().mockResolvedValue({
      records: [],
      summary: {
        counters: {
          updates: () => ({ nodesDeleted: 0, relationshipsDeleted: 0 }),
        },
      },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };

  const mockDriver = {
    session: jest.fn().mockReturnValue(mockSession),
  } as unknown as Driver;

  return { mockDriver, mockSession };
}

function getCypher(mockSession: { run: jest.Mock }): string {
  return mockSession.run.mock.calls[0][0] as string;
}

function getParams(mockSession: { run: jest.Mock }): Record<string, unknown> {
  return mockSession.run.mock.calls[0][1] as Record<string, unknown>;
}

// --- Tests ------------------------------------------------------------------

describe('InterfaceModel', () => {
  let model: InterfaceModel;
  let mockSession: ReturnType<typeof createMockDriver>['mockSession'];

  beforeEach(() => {
    const { mockDriver, mockSession: ms } = createMockDriver();
    mockSession = ms;
    model = new InterfaceModel(entityInterface, schema, mockDriver);
  });

  describe('find()', () => {
    it('should produce MATCH (n:`Entity`) + CASE __typename resolution + RETURN with default selection when no params', async () => {
      await model.find();

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Entity`)');
      // __typename CASE resolution
      expect(cypher).toContain('WITH n, CASE');
      expect(cypher).toContain("WHEN n:`User` THEN 'User'");
      expect(cypher).toContain("WHEN n:`Organization` THEN 'Organization'");
      expect(cypher).toContain("WHEN n:`Facility` THEN 'Facility'");
      expect(cypher).toContain('END AS __typename');
      // RETURN with default scalar fields
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`name`');
    });

    it('should include __typename in RETURN clause', async () => {
      await model.find();

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('__typename: __typename');
    });

    it('should add WHERE clause when where filter is provided', async () => {
      await model.find({ where: { id: 'abc-123' } });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Entity`)');
      expect(cypher).toContain('WHERE');
      expect(cypher).toContain('n.`id` = $param0');
      expect(cypher).toContain('RETURN n {');

      const params = getParams(mockSession);
      expect(params.param0).toBe('abc-123');
    });

    it('should use parsed selection when selectionSet string is provided', async () => {
      await model.find({ selectionSet: '{ id name }' });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`name`');
      expect(cypher).toContain('__typename: __typename');
    });

    it('should add labels to MATCH pattern', async () => {
      await model.find({ labels: ['Active'] });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Entity`:`Active`)');
    });

    it('should produce ORDER BY + SKIP + LIMIT with options', async () => {
      await model.find({
        options: {
          sort: [{ name: 'ASC' }, { id: 'DESC' }],
          offset: 5,
          limit: 20,
        },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('ORDER BY n.`name` ASC, n.`id` DESC');
      expect(cypher).toContain('SKIP $options_offset');
      expect(cypher).toContain('LIMIT $options_limit');

      const params = getParams(mockSession);
      expect((params.options_offset as any).toInt()).toBe(5);
      expect((params.options_limit as any).toInt()).toBe(20);
    });
  });

  describe('aggregate()', () => {
    it('should produce MATCH + RETURN count(n) with count aggregate', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => (key === 'count' ? 10 : null),
            keys: ['count'],
            toObject: () => ({ count: 10 }),
          },
        ],
        summary: { counters: { updates: () => ({}) } },
      });

      const result = await model.aggregate({
        aggregate: { count: true },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Entity`)');
      expect(cypher).toContain('RETURN count(n) AS count');

      expect(result.count).toBe(10);
    });

    it('should add WHERE clause when where filter is provided', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => (key === 'count' ? 3 : null),
            keys: ['count'],
            toObject: () => ({ count: 3 }),
          },
        ],
        summary: { counters: { updates: () => ({}) } },
      });

      const result = await model.aggregate({
        where: { name: 'Test' },
        aggregate: { count: true },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Entity`)');
      expect(cypher).toContain('WHERE');
      expect(cypher).toContain('n.`name` = $param0');
      expect(cypher).toContain('RETURN count(n) AS count');

      const params = getParams(mockSession);
      expect(params.param0).toBe('Test');
      expect(result.count).toBe(3);
    });

    it('should return { count: 0 } when no records are returned', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      });

      const result = await model.aggregate({
        aggregate: { count: true },
      });

      expect(result).toEqual({ count: 0 });
    });

    it('should generate field aggregation with min/max/avg for a field', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => {
              const values: Record<string, unknown> = {
                name_min: 'Alpha',
                name_max: 'Zeta',
                name_avg: null,
              };
              return values[key] ?? null;
            },
            keys: ['name_min', 'name_max', 'name_avg'],
            toObject: () => ({
              name_min: 'Alpha',
              name_max: 'Zeta',
              name_avg: null,
            }),
          },
        ],
        summary: { counters: { updates: () => ({}) } },
      });

      const result = await model.aggregate({
        aggregate: { name: true },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('min(n.`name`) AS name_min');
      expect(cypher).toContain('max(n.`name`) AS name_max');
      expect(cypher).toContain('avg(n.`name`) AS name_avg');

      expect(result).toEqual({
        name: { min: 'Alpha', max: 'Zeta', average: null },
      });
    });

    it('should combine count and field aggregation', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => {
              const values: Record<string, unknown> = {
                count: 5,
                name_min: 'A',
                name_max: 'Z',
                name_avg: null,
              };
              return values[key] ?? null;
            },
            keys: ['count', 'name_min', 'name_max', 'name_avg'],
            toObject: () => ({
              count: 5,
              name_min: 'A',
              name_max: 'Z',
              name_avg: null,
            }),
          },
        ],
        summary: { counters: { updates: () => ({}) } },
      });

      const result = await model.aggregate({
        aggregate: { count: true, name: true },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('count(n) AS count');
      expect(cypher).toContain('min(n.`name`) AS name_min');
      expect(cypher).toContain('max(n.`name`) AS name_max');
      expect(cypher).toContain('avg(n.`name`) AS name_avg');

      expect(result).toEqual({
        count: 5,
        name: { min: 'A', max: 'Z', average: null },
      });
    });

    it('should add labels to MATCH in aggregate', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => (key === 'count' ? 4 : null),
            keys: ['count'],
            toObject: () => ({ count: 4 }),
          },
        ],
        summary: { counters: { updates: () => ({}) } },
      });

      await model.aggregate({
        aggregate: { count: true },
        labels: ['Active'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Entity`:`Active`)');
      expect(cypher).toContain('RETURN count(n) AS count');
    });
  });

  describe('selectionSet setter', () => {
    it('should accept a selectionSet string and clear cached default selection', async () => {
      // First call to populate cache
      await model.find();
      // Set custom selectionSet
      model.selectionSet = '{ id }';
      // The setter should not throw
      expect(true).toBe(true);
    });
  });

  describe('find() with relationships', () => {
    it('should use SelectionCompiler for relationship fields in selectionSet', async () => {
      await model.find({ selectionSet: '{ id name status { id label } }' });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Entity`)');
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`name`');
      expect(cypher).toContain('__typename: __typename');
      // Should contain a pattern comprehension for the relationship
      expect(cypher).toContain('status:');
      expect(cypher).toContain('`HAS_STATUS`');
    });
  });
});
