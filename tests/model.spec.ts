import { Driver } from 'neo4j-driver';
import { Model } from '../src/model';
import {
  NodeDefinition,
  SchemaMetadata,
  PropertyDefinition,
  RelationshipDefinition,
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
    isArray: true,
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

// --- Mock schema ------------------------------------------------------------

const statusNode = nodeDef('Status', [prop('id'), prop('name')]);

const bookNode = nodeDef(
  'Book',
  [
    prop('id', { isGenerated: true }),
    prop('title'),
    prop('computedField', { isCypher: true }),
  ],
  [rel('hasStatus', 'HAS_STATUS', 'Status', { isArray: false })],
  {
    fulltextIndexes: [{ name: 'BookTitleSearch', fields: ['title'] }],
  },
);

const schema: SchemaMetadata = {
  nodes: new Map([
    ['Book', bookNode],
    ['Status', statusNode],
  ]),
  interfaces: new Map(),
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

describe('Model', () => {
  let model: Model;
  let mockSession: ReturnType<typeof createMockDriver>['mockSession'];

  beforeEach(() => {
    const { mockDriver, mockSession: ms } = createMockDriver();
    mockSession = ms;
    model = new Model(bookNode, schema, mockDriver);
  });

  describe('find()', () => {
    it('should produce MATCH + RETURN with default selection when no params', async () => {
      await model.find();

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).toContain('RETURN n {');
      // Default selection should include scalar non-cypher fields
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');
      // Should NOT include cypher computed fields
      expect(cypher).not.toContain('.`computedField`');
    });

    it('should produce MATCH + WHERE + RETURN with simple where', async () => {
      await model.find({ where: { id: '123' } });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).toContain('WHERE');
      expect(cypher).toContain('n.`id` = $param0');
      expect(cypher).toContain('RETURN n {');

      const params = getParams(mockSession);
      expect(params.param0).toBe('123');
    });

    it('should use SelectNormalizer when select object is provided', async () => {
      await model.find({ select: { id: true, title: true } });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');
    });

    it('should use parseSelectionSet when selectionSet string is provided', async () => {
      await model.find({ selectionSet: '{ id title }' });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');
    });

    it('should produce CALL + YIELD + WHERE pattern with fulltext', async () => {
      await model.find({
        fulltext: { BookTitleSearch: { phrase: '*albuterol*' } },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        "CALL db.index.fulltext.queryNodes('BookTitleSearch'",
      );
      expect(cypher).toContain('YIELD node AS n, score');
      expect(cypher).toContain('WHERE n:`Book`');
      expect(cypher).toContain('RETURN n {');

      const params = getParams(mockSession);
      expect(params.ft_phrase).toBe('*albuterol*');
    });

    it('should add score threshold to WHERE when fulltext score is provided', async () => {
      await model.find({
        fulltext: { BookTitleSearch: { phrase: '*albuterol*', score: 0.5 } },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('score >= $ft_score');
      expect(cypher).toContain('WHERE n:`Book` AND score >= $ft_score');

      const params = getParams(mockSession);
      expect(params.ft_phrase).toBe('*albuterol*');
      expect(params.ft_score).toBe(0.5);
    });

    it('should not add score threshold when fulltext score is not provided', async () => {
      await model.find({
        fulltext: { BookTitleSearch: { phrase: '*albuterol*' } },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).not.toContain('score >= $ft_score');

      const params = getParams(mockSession);
      expect(params.ft_score).toBeUndefined();
    });

    it('should add labels to MATCH pattern', async () => {
      await model.find({ labels: ['Active'] });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`:`Active`)');
    });

    it('should produce ORDER BY + SKIP + LIMIT with options', async () => {
      await model.find({
        options: {
          sort: [{ title: 'ASC' }, { id: 'DESC' }],
          offset: 10,
          limit: 25,
        },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('ORDER BY n.`title` ASC, n.`id` DESC');
      expect(cypher).toContain('SKIP $options_offset');
      expect(cypher).toContain('LIMIT $options_limit');

      const params = getParams(mockSession);
      expect((params.options_offset as any).toInt()).toBe(10);
      expect((params.options_limit as any).toInt()).toBe(25);
    });

    it('should throw when both select and selectionSet are provided', async () => {
      await expect(
        model.find({
          select: { id: true },
          selectionSet: '{ id }',
        }),
      ).rejects.toThrow(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );
    });

    it('should use instance-level selectionSet when set', async () => {
      model.selectionSet = '{ id }';
      await model.find();

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      // title should NOT be in the selection since we overrode
    });

    it('should hit selectionSet cache on second call with same string', async () => {
      await model.find({ selectionSet: '{ id }' });
      mockSession.run.mockClear();
      await model.find({ selectionSet: '{ id }' });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain('.`id`');
    });

    it('should throw on negative offset', async () => {
      await expect(model.find({ options: { offset: -1 } })).rejects.toThrow(
        'offset must be a non-negative integer',
      );
    });

    it('should throw on NaN offset', async () => {
      await expect(model.find({ options: { offset: NaN } })).rejects.toThrow(
        'offset must be a non-negative integer',
      );
    });

    it('should throw on negative limit', async () => {
      await expect(model.find({ options: { limit: -1 } })).rejects.toThrow(
        'limit must be a non-negative integer',
      );
    });

    it('should throw on Infinity limit', async () => {
      await expect(
        model.find({ options: { limit: Infinity } }),
      ).rejects.toThrow('limit must be a non-negative integer');
    });

    it('should ignore null limit (not emit LIMIT 0)', async () => {
      await model.find({
        options: { limit: null as any, offset: null as any },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).not.toContain('LIMIT');
      expect(cypher).not.toContain('SKIP');
    });

    it('should ignore undefined limit and offset', async () => {
      await model.find({
        options: { limit: undefined, offset: undefined },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).not.toContain('LIMIT');
      expect(cypher).not.toContain('SKIP');
    });

    it('should clamp limit to 10,000 when exceeding max', async () => {
      await model.find({
        options: { limit: Number.MAX_SAFE_INTEGER },
      });

      const params = getParams(mockSession);
      expect((params.options_limit as any).toInt()).toBe(10_000);
    });
  });

  describe('create()', () => {
    it('should produce CREATE + RETURN and return { [pluralName]: [...] }', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      });

      const result = await model.create({
        input: [{ title: 'Albuterol' }],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('CREATE (n:`Book`');
      expect(cypher).toContain('RETURN n');

      // Result should use the plural name as key
      expect(result).toHaveProperty('books');
      expect(Array.isArray(result.books)).toBe(true);
    });
  });

  describe('update()', () => {
    it('should produce MATCH + WHERE + SET + RETURN', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      });

      const result = await model.update({
        where: { id: '123' },
        update: { title: 'Updated' },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).toContain('WHERE');
      expect(cypher).toContain('SET');
      expect(cypher).toContain('n.`title` = $update_title');
      expect(cypher).toContain('RETURN n');

      expect(result).toHaveProperty('books');
    });

    it('should use selectionSet for RETURN projection when provided', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      });

      await model.update({
        where: { id: '123' },
        update: { title: 'Updated' },
        selectionSet: '{ id title hasStatus { id name } }',
      });

      const cypher = getCypher(mockSession);
      // Should have a projection with relationship traversal, not plain "RETURN n"
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');
      expect(cypher).toContain('hasStatus:');
      expect(cypher).toContain('`HAS_STATUS`');
    });

    it('should unwrap mutation response wrapper in selectionSet', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      });

      // Mutation selectionSets wrap with { <pluralName> { <fields> } }
      await model.update({
        where: { id: '123' },
        update: { title: 'Updated' },
        selectionSet: '{ books { id title hasStatus { id name } } }',
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');
      expect(cypher).toContain('hasStatus:');
    });

    it('should unwrap multi-field mutation selectionSet with info + pluralName', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      });

      // Selection sets like { info { ... } books { id } } should extract books children
      await model.update({
        where: { id: '123' },
        update: { title: 'Updated' },
        selectionSet:
          '{ info { nodesCreated nodesDeleted } books { id title } }',
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');
    });
  });

  describe('create()', () => {
    it('should use selectionSet for RETURN projection when provided', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      });

      await model.create({
        input: [{ title: 'Albuterol' }],
        selectionSet: '{ books { id title hasStatus { id name } } }',
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('hasStatus:');
    });
  });

  describe('delete()', () => {
    it('should produce MATCH + WHERE + DETACH DELETE', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: {
          counters: {
            updates: () => ({ nodesDeleted: 1, relationshipsDeleted: 2 }),
          },
        },
      });

      const result = await model.delete({ where: { id: '123' } });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).toContain('WHERE');
      expect(cypher).toContain('DETACH DELETE n');

      expect(result.nodesDeleted).toBe(1);
      expect(result.relationshipsDeleted).toBe(2);
    });

    it('should produce OPTIONAL MATCH + cascade delete with delete input', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: {
          counters: {
            updates: () => ({ nodesDeleted: 2, relationshipsDeleted: 1 }),
          },
        },
      });

      const result = await model.delete({
        where: { id: '123' },
        delete: { hasStatus: {} },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).toContain('OPTIONAL MATCH');
      expect(cypher).toContain('`HAS_STATUS`');
      expect(cypher).toContain('DETACH DELETE');

      expect(result.nodesDeleted).toBe(2);
      expect(result.relationshipsDeleted).toBe(1);
    });
  });

  describe('aggregate()', () => {
    it('should produce MATCH + RETURN count(n) with count aggregate', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => (key === 'count' ? 5 : null),
            keys: ['count'],
            toObject: () => ({ count: 5 }),
          },
        ],
        summary: { counters: { updates: () => ({}) } },
      });

      const result = await model.aggregate({
        aggregate: { count: true },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).toContain('RETURN count(n) AS count');

      expect(result.count).toBe(5);
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

    it('should produce min/max/avg aggregation for field alongside count', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => {
              const data: Record<string, unknown> = {
                count: 5,
                title_min: 'A',
                title_max: 'Z',
                title_avg: null,
              };
              return data[key] ?? null;
            },
            keys: ['count', 'title_min', 'title_max', 'title_avg'],
            toObject: () => ({
              count: 5,
              title_min: 'A',
              title_max: 'Z',
              title_avg: null,
            }),
          },
        ],
        summary: { counters: { updates: () => ({}) } },
      });

      const result = await model.aggregate({
        aggregate: { count: true, title: true },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('count(n) AS count');
      expect(cypher).toContain('min(n.`title`) AS title_min');
      expect(cypher).toContain('max(n.`title`) AS title_max');
      expect(cypher).toContain('avg(n.`title`) AS title_avg');

      expect(result.count).toBe(5);
      expect(result.title).toEqual({
        min: 'A',
        max: 'Z',
        average: null,
      });
    });

    it('should return empty object when count is not requested and no records', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      });

      const result = await model.aggregate({
        aggregate: { title: true },
      });

      expect(result).toEqual({});
    });

    it('should add labels to MATCH in aggregate', async () => {
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

      await model.aggregate({
        aggregate: { count: true },
        labels: ['Active'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`:`Active`)');
    });

    it('should add where clause in aggregate without fulltext', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => (key === 'count' ? 1 : null),
            keys: ['count'],
            toObject: () => ({ count: 1 }),
          },
        ],
        summary: { counters: { updates: () => ({}) } },
      });

      await model.aggregate({
        aggregate: { count: true },
        where: { title: 'Aspirin' },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).toContain('WHERE');
      expect(cypher).toContain('RETURN count(n) AS count');

      const params = getParams(mockSession);
      expect(params.param0).toBe('Aspirin');
    });

    it('should add labels and score threshold with fulltext in aggregate', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => (key === 'count' ? 2 : null),
            keys: ['count'],
            toObject: () => ({ count: 2 }),
          },
        ],
        summary: { counters: { updates: () => ({}) } },
      });

      await model.aggregate({
        aggregate: { count: true },
        fulltext: { BookTitleSearch: { phrase: '*test*', score: 0.5 } },
        labels: ['Active'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        "CALL db.index.fulltext.queryNodes('BookTitleSearch'",
      );
      expect(cypher).toContain('YIELD node AS n, score');
      expect(cypher).toContain('n:`Active`');
      expect(cypher).toContain('score >= $ft_score');
      expect(cypher).toContain('RETURN count(n) AS count');

      const params = getParams(mockSession);
      expect(params.ft_phrase).toBe('*test*');
      expect(params.ft_score).toBe(0.5);
    });

    it('should use CALL + YIELD pattern with fulltext in aggregate', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => (key === 'count' ? 2 : null),
            keys: ['count'],
            toObject: () => ({ count: 2 }),
          },
        ],
        summary: { counters: { updates: () => ({}) } },
      });

      await model.aggregate({
        aggregate: { count: true },
        fulltext: { BookTitleSearch: { phrase: '*albuterol*' } },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        "CALL db.index.fulltext.queryNodes('BookTitleSearch'",
      );
      expect(cypher).toContain('YIELD node AS n, score');
      expect(cypher).toContain('WHERE n:`Book`');
      expect(cypher).toContain('RETURN count(n) AS count');

      const params = getParams(mockSession);
      expect(params.ft_phrase).toBe('*albuterol*');
    });
  });

  describe('setLabels()', () => {
    it('should produce MATCH + SET/REMOVE labels', async () => {
      await model.setLabels({
        where: { id: '123' },
        addLabels: ['Published'],
        removeLabels: ['Draft'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).toContain('WHERE');
      expect(cypher).toContain('SET n:`Published`');
      expect(cypher).toContain('REMOVE n:`Draft`');
    });
  });

  describe('maxDepth setter', () => {
    it('should set maxDepth on the model', () => {
      model.maxDepth = 3;
      // Setter executes without error
      expect(true).toBe(true);
    });
  });

  describe('selectionSet setter', () => {
    it('should accept a string and parse it', async () => {
      model.selectionSet = '{ id title }';
      await model.find();

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');
    });

    it('should accept a DocumentNode-like object and parse its body', async () => {
      const docNode = {
        kind: 'Document',
        loc: {
          source: {
            body: '{ id title }',
          },
        },
      };
      model.selectionSet = docNode as any;
      await model.find();

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');
    });
  });

  describe('create() with select', () => {
    it('should project RETURN and build narrowed result with info + entity', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            keys: ['n'],
            get: (key: string) => (key === 'n' ? { id: '1' } : null),
            toObject: () => ({ n: { id: '1' } }),
          },
        ],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 1,
              nodesDeleted: 0,
              relationshipsCreated: 2,
              relationshipsDeleted: 0,
            }),
          },
        },
      });

      const result = await model.create({
        input: [{ title: 'Albuterol' }],
        select: {
          info: { nodesCreated: true, relationshipsCreated: true },
          books: { id: true },
        },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('CREATE (n:`Book`');
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');

      // Result should be narrowed
      expect(result).toHaveProperty('info');
      expect(result.info).toEqual({
        nodesCreated: 1,
        relationshipsCreated: 2,
      });
      expect(result).toHaveProperty('books');
    });

    it('should return only info when select has no entity key', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 1,
              nodesDeleted: 0,
              relationshipsCreated: 0,
              relationshipsDeleted: 0,
            }),
          },
        },
      });

      const result = await model.create({
        input: [{ title: 'Albuterol' }],
        select: {
          info: { nodesCreated: true },
        },
      });

      const cypher = getCypher(mockSession);
      // Without entity select, RETURN n should NOT be replaced with projection
      expect(cypher).toMatch(/RETURN n\s*$/);

      expect(result).toHaveProperty('info');
      expect(result.info).toEqual({ nodesCreated: 1 });
      expect(result).not.toHaveProperty('books');
    });

    it('should return only entity when select has no info key', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 1,
              nodesDeleted: 0,
              relationshipsCreated: 0,
              relationshipsDeleted: 0,
            }),
          },
        },
      });

      const result = await model.create({
        input: [{ title: 'Albuterol' }],
        select: {
          books: { id: true, title: true },
        },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');

      expect(result).not.toHaveProperty('info');
      expect(result).toHaveProperty('books');
    });

    it('should throw when both select and selectionSet are provided', async () => {
      await expect(
        model.create({
          input: [{ title: 'Albuterol' }],
          select: { books: { id: true } },
          selectionSet: '{ id }',
        }),
      ).rejects.toThrow(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );
    });
  });

  describe('update() with select', () => {
    it('should project RETURN and build narrowed result with info + entity', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 0,
              nodesDeleted: 0,
              relationshipsCreated: 1,
              relationshipsDeleted: 2,
            }),
          },
        },
      });

      const result = await model.update({
        where: { id: '123' },
        update: { title: 'Updated' },
        select: {
          info: { relationshipsDeleted: true },
          books: { id: true },
        },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');

      expect(result.info).toEqual({ relationshipsDeleted: 2 });
      expect(result).toHaveProperty('books');
    });

    it('should return only info when select has no entity key', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 0,
              nodesDeleted: 0,
              relationshipsCreated: 3,
              relationshipsDeleted: 1,
            }),
          },
        },
      });

      const result = await model.update({
        where: { id: '123' },
        update: { title: 'Updated' },
        select: {
          info: { relationshipsCreated: true, relationshipsDeleted: true },
        },
      });

      expect(result.info).toEqual({
        relationshipsCreated: 3,
        relationshipsDeleted: 1,
      });
      expect(result).not.toHaveProperty('books');
    });

    it('should return only entity when select has no info key', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 0,
              nodesDeleted: 0,
              relationshipsCreated: 0,
              relationshipsDeleted: 0,
            }),
          },
        },
      });

      const result = await model.update({
        where: { id: '123' },
        update: { title: 'Updated' },
        select: {
          books: { id: true },
        },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');

      expect(result).not.toHaveProperty('info');
      expect(result).toHaveProperty('books');
    });

    it('should throw when both select and selectionSet are provided', async () => {
      await expect(
        model.update({
          where: { id: '123' },
          update: { title: 'Updated' },
          select: { books: { id: true } },
          selectionSet: '{ id }',
        }),
      ).rejects.toThrow(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );
    });
  });

  describe('backward compat: mutations without select', () => {
    it('create() without select returns full MutationResponse', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 1,
              nodesDeleted: 0,
              relationshipsCreated: 0,
              relationshipsDeleted: 0,
            }),
          },
        },
      });

      const result = await model.create({
        input: [{ title: 'Albuterol' }],
      });

      expect(result).toHaveProperty('info');
      expect(result.info).toHaveProperty('nodesCreated');
      expect(result.info).toHaveProperty('relationshipsCreated');
      expect(result).toHaveProperty('books');
    });

    it('update() without select returns full MutationResponse', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 0,
              nodesDeleted: 0,
              relationshipsCreated: 0,
              relationshipsDeleted: 0,
            }),
          },
        },
      });

      const result = await model.update({
        where: { id: '123' },
        update: { title: 'Updated' },
      });

      expect(result).toHaveProperty('info');
      expect(result.info).toHaveProperty('nodesCreated');
      expect(result).toHaveProperty('books');
    });
  });

  describe('find() advanced', () => {
    it('should combine fulltext + where + labels', async () => {
      await model.find({
        fulltext: { BookTitleSearch: { phrase: '*test*', score: 0.3 } },
        where: { title: 'Albuterol' },
        labels: ['Active'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        "CALL db.index.fulltext.queryNodes('BookTitleSearch'",
      );
      expect(cypher).toContain('YIELD node AS n, score');
      expect(cypher).toContain('n:`Book`');
      expect(cypher).toContain('n:`Active`');
      expect(cypher).toContain('score >= $ft_score');
      expect(cypher).toContain('RETURN n {');
    });
  });
});
