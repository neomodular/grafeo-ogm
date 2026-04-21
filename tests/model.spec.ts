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
    vectorIndexes: [
      {
        indexName: 'BookEmbeddingIdx',
        queryName: 'similarBooks',
        embeddingProperty: 'embedding',
      },
      {
        indexName: 'BookPhraseIdx',
        queryName: 'booksLike',
        embeddingProperty: 'embedding',
        provider: 'OpenAI',
      },
    ],
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
    // Clear the static selection-parse cache so cached entries from previous
    // describe blocks cannot leak selection shapes into later tests. Previously
    // only searchByVector/searchByPhrase described this; hoisting it here makes
    // every test independent of ordering.
    Model.clearSelectionCache();
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

    // Regression: the selection compiler used to be invoked with a fresh
    // paramCounter, so a connection-where in the projection would allocate
    // $param0 and clobber the value from the outer WHERE that `compileUpdate`
    // had already merged into mutParams. Both params must survive, under
    // distinct names.
    it('should not overwrite outer WHERE params when selection has a connection-where', async () => {
      await model.update({
        where: { id: 'book-id' },
        update: { title: 'Updated' },
        select: {
          books: {
            id: true,
            hasStatusConnection: {
              where: { node: { id: 'status-id' } },
              select: {
                edges: {
                  node: { select: { id: true } },
                },
              },
            },
          },
        },
      });

      const params = getParams(mockSession);
      // Outer WHERE must retain its value — no param0 collision.
      expect(params.param0).toBe('book-id');
      // Connection-where value must be present under a distinct param name.
      const paramValues = Object.values(params);
      expect(paramValues).toContain('status-id');
      // And the two values must live under different keys.
      const keysPointingToBookId = Object.keys(params).filter(
        (k) => params[k] === 'book-id',
      );
      const keysPointingToStatusId = Object.keys(params).filter(
        (k) => params[k] === 'status-id',
      );
      expect(keysPointingToBookId).toEqual(['param0']);
      expect(keysPointingToStatusId).toHaveLength(1);
      expect(keysPointingToStatusId[0]).not.toBe('param0');
    });

    // Same collision class, via the relationship path (select.where on a
    // non-connection relationship field).
    it('should not overwrite outer WHERE params when selection has a relationship-where', async () => {
      await model.update({
        where: { id: 'book-id' },
        update: { title: 'Updated' },
        select: {
          books: {
            id: true,
            hasStatus: {
              where: { id: 'status-id' },
              select: { id: true },
            },
          },
        },
      });

      const params = getParams(mockSession);
      expect(params.param0).toBe('book-id');
      const statusKeys = Object.keys(params).filter(
        (k) => params[k] === 'status-id',
      );
      expect(statusKeys).toHaveLength(1);
      expect(statusKeys[0]).not.toBe('param0');
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

  // --- searchByVector ------------------------------------------------------

  describe('searchByVector()', () => {
    it('should emit CALL + WHERE label + RETURN with score', async () => {
      await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.1, 0.2, 0.3],
        k: 5,
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        'CALL db.index.vector.queryNodes($v_name_0, $v_k_0, $v_vector_0) YIELD node AS n, score',
      );
      expect(cypher).toContain('WHERE n:`Book`');
      expect(cypher).toMatch(/RETURN n \{[\s\S]*\}, score/);
      expect(cypher).not.toContain('MATCH (n:`Book`)');

      const params = getParams(mockSession);
      expect(params.v_name_0).toBe('BookEmbeddingIdx');
      expect(params.v_k_0).toBe(5);
      expect(params.v_vector_0).toEqual([0.1, 0.2, 0.3]);
    });

    it('should AND user where into the WHERE clause', async () => {
      await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.1, 0.2],
        k: 3,
        where: { title: 'Albuterol' },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('WHERE n:`Book` AND n.`title` =');

      // The vector compiler consumes paramCounter slot 0 (v_name_0, v_k_0,
      // v_vector_0 all share one counter bump), so the user's WHERE param
      // is pinned at param1. Pin the exact key so a regression that
      // overwrites the where param would fail the test.
      const params = getParams(mockSession);
      expect(params.param1).toBe('Albuterol');
    });

    it('should support legacy selectionSet string', async () => {
      await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.9],
        k: 2,
        selectionSet: '{ id title }',
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');
      expect(cypher).toContain(', score');
    });

    it('should support typed select API', async () => {
      await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.5, 0.5],
        k: 4,
        select: { id: true, title: true },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');
    });

    it('should apply custom labels to the WHERE filter', async () => {
      await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.1],
        k: 1,
        labels: ['Active', 'Published'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        'WHERE n:`Book` AND n:`Active` AND n:`Published`',
      );
    });

    it('should thread context through the executor', async () => {
      const fakeTx = {
        run: jest.fn().mockResolvedValue({
          records: [],
          summary: { counters: { updates: () => ({}) } },
        }),
      };

      await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.1],
        k: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        context: { transaction: fakeTx as any },
      });

      expect(fakeTx.run).toHaveBeenCalled();
      expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('should map records into { node, score } pairs', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            keys: ['n', 'score'],
            get: (key: string) => {
              if (key === 'n') return { id: '1', title: 'A' };
              if (key === 'score') return 0.93;
              return null;
            },
            toObject: () => ({ n: { id: '1', title: 'A' }, score: 0.93 }),
          },
          {
            keys: ['n', 'score'],
            get: (key: string) => {
              if (key === 'n') return { id: '2', title: 'B' };
              if (key === 'score') return 0.81;
              return null;
            },
            toObject: () => ({ n: { id: '2', title: 'B' }, score: 0.81 }),
          },
        ],
        summary: { counters: { updates: () => ({}) } },
      });

      const results = await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.1, 0.2],
        k: 10,
      });

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        node: { id: '1', title: 'A' },
        score: 0.93,
      });
      expect(results[1]).toEqual({
        node: { id: '2', title: 'B' },
        score: 0.81,
      });
    });

    it('should propagate VectorCompiler errors for unknown indexName', async () => {
      await expect(
        model.searchByVector({
          indexName: 'NotARealIndex',
          vector: [0.1],
          k: 3,
        }),
      ).rejects.toThrow(/Invalid vector index: "NotARealIndex"/);

      expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('should throw when both select and selectionSet are provided', async () => {
      await expect(
        model.searchByVector({
          indexName: 'BookEmbeddingIdx',
          vector: [0.1],
          k: 1,
          select: { id: true },
          selectionSet: '{ id }',
        }),
      ).rejects.toThrow(
        'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
      );
    });
  });

  // --- searchByPhrase ------------------------------------------------------

  describe('searchByPhrase()', () => {
    it('should emit two-step CALL + WHERE + RETURN with score', async () => {
      await model.searchByPhrase({
        indexName: 'BookPhraseIdx',
        phrase: 'distributed consensus',
        k: 5,
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        'CALL genai.vector.encode($v_phrase_0, $v_provider_0, $v_providerConfig_0) YIELD vector AS __v_encoded_0',
      );
      expect(cypher).toContain(
        'CALL db.index.vector.queryNodes($v_name_0, $v_k_0, __v_encoded_0) YIELD node AS n, score',
      );
      expect(cypher).toContain('WHERE n:`Book`');
      expect(cypher).toMatch(/RETURN n \{[\s\S]*\}, score/);

      const params = getParams(mockSession);
      expect(params.v_phrase_0).toBe('distributed consensus');
      expect(params.v_provider_0).toBe('OpenAI');
      expect(params.v_name_0).toBe('BookPhraseIdx');
      expect(params.v_k_0).toBe(5);
    });

    it('should pass providerConfig as a Cypher parameter, not interpolated', async () => {
      const secret = { token: 'sk-super-secret', model: 'text-embedding-3' };

      await model.searchByPhrase({
        indexName: 'BookPhraseIdx',
        phrase: 'graph databases',
        k: 3,
        providerConfig: secret,
      });

      const cypher = getCypher(mockSession);
      expect(cypher).not.toContain('sk-super-secret');
      expect(cypher).not.toContain('text-embedding-3');
      expect(cypher).toContain('$v_providerConfig_0');

      const params = getParams(mockSession);
      expect(params.v_providerConfig_0).toEqual(secret);
    });

    it('should throw when the index has no provider configured', async () => {
      await expect(
        model.searchByPhrase({
          indexName: 'BookEmbeddingIdx',
          phrase: 'anything',
          k: 3,
        }),
      ).rejects.toThrow(
        /Vector index "BookEmbeddingIdx" is not configured for phrase search/,
      );

      expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('should AND user where into the WHERE clause', async () => {
      await model.searchByPhrase({
        indexName: 'BookPhraseIdx',
        phrase: 'neural networks',
        k: 10,
        where: { title: 'Deep Learning' },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('WHERE n:`Book` AND n.`title` =');

      // VectorCompiler.compileByPhrase bumps paramCounter once (shared slot
      // across v_name/v_k/v_phrase/v_provider/v_providerConfig), so user
      // WHERE starts at param1. Pin the key so regressions surface.
      const params = getParams(mockSession);
      expect(params.param1).toBe('Deep Learning');
    });

    it('should thread context through the executor', async () => {
      const fakeTx = {
        run: jest.fn().mockResolvedValue({
          records: [],
          summary: { counters: { updates: () => ({}) } },
        }),
      };

      await model.searchByPhrase({
        indexName: 'BookPhraseIdx',
        phrase: 'vector search',
        k: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        context: { transaction: fakeTx as any },
      });

      expect(fakeTx.run).toHaveBeenCalled();
      expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('should propagate VectorCompiler errors for unknown indexName', async () => {
      await expect(
        model.searchByPhrase({
          indexName: 'NoSuchIndex',
          phrase: 'something',
          k: 3,
        }),
      ).rejects.toThrow(/Invalid vector index: "NoSuchIndex"/);

      expect(mockSession.run).not.toHaveBeenCalled();
    });
  });

  // --- vector search: integration-seam gap coverage --------------------------

  describe('searchByVector — integration seams', () => {
    it('composes vector params (v_*) and WHERE params (param*) without key collision', async () => {
      await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.1, 0.2],
        k: 3,
        where: { title: 'A', id: '42' },
      });

      const params = getParams(mockSession);
      const keys = Object.keys(params);
      // No two keys should be equal (obvious) — but also: vector and where
      // use disjoint prefix namespaces.
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.some((k) => k.startsWith('v_'))).toBe(true);
      expect(keys.some((k) => k.startsWith('param'))).toBe(true);
      // No v_* key equals any param* key.
      const vKeys = keys.filter((k) => k.startsWith('v_'));
      const pKeys = keys.filter((k) => k.startsWith('param'));
      for (const vk of vKeys) expect(pKeys).not.toContain(vk);
    });

    it('paramCounter is shared: WHERE param indexing continues after vector compile', async () => {
      // VectorCompiler takes paramCounter slot 0 (`v_name_0`, etc.).
      // The WhereCompiler then increments starting at 1, so user filters
      // appear as param1, param2 (NOT param0).
      await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.5],
        k: 1,
        where: { title: 'Hello' },
      });

      const params = getParams(mockSession);
      // param0 should NOT be defined (reserved by the vector compiler slot).
      expect(params).not.toHaveProperty('param0');
      expect(params).toHaveProperty('param1');
      expect(params.param1).toBe('Hello');
    });

    it('falls back to defaultSelection when no select / selectionSet is given', async () => {
      await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.1],
        k: 1,
      });

      const cypher = getCypher(mockSession);
      // Default selection includes non-Cypher scalars of Book (id, title);
      // Cypher-computed properties (computedField) must be excluded.
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');
      expect(cypher).not.toContain('.`computedField`');
    });

    it('falls back to instance-level selectionSet when params has neither select nor selectionSet', async () => {
      model.selectionSet = '{ id }';
      await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.1],
        k: 1,
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('.`id`');
      // title should NOT be in the selection since instance-level narrowed it.
      expect(cypher).not.toContain('.`title`');
    });

    it('accepts an empty labels array without emitting spurious label filters', async () => {
      await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.1],
        k: 1,
        labels: [],
      });

      const cypher = getCypher(mockSession);
      // Only the primary `n:\`Book\`` filter should be present.
      expect(cypher).toContain('WHERE n:`Book`');
      expect(cypher).not.toContain('n:`` '); // no empty label
      // Should NOT have trailing AND from an empty labels array.
      expect(cypher).not.toMatch(/n:`Book` AND\s*$/m);
    });

    it('maps a Neo4j Integer score through convertNeo4jTypes into a JS number', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const neo4j = require('neo4j-driver');
      const intScore = neo4j.int(42);

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            keys: ['n', 'score'],
            get: (key: string) => {
              if (key === 'n') return { id: '1', title: 'A' };
              if (key === 'score') return intScore;
              return null;
            },
            toObject: () => ({ n: { id: '1', title: 'A' }, score: intScore }),
          },
        ],
        summary: { counters: { updates: () => ({}) } },
      });

      const results = await model.searchByVector({
        indexName: 'BookEmbeddingIdx',
        vector: [0.1],
        k: 1,
      });

      expect(results).toHaveLength(1);
      expect(typeof results[0].score).toBe('number');
      expect(results[0].score).toBe(42);
    });

    it('throws without hitting the DB when vector is empty (pre-execute validation)', async () => {
      await expect(
        model.searchByVector({
          indexName: 'BookEmbeddingIdx',
          vector: [],
          k: 1,
        }),
      ).rejects.toThrow(/"vector" must not be empty/);
      expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('throws without hitting the DB when k is 0', async () => {
      await expect(
        model.searchByVector({
          indexName: 'BookEmbeddingIdx',
          vector: [0.1],
          k: 0,
        }),
      ).rejects.toThrow(/"k" must be >= 1/);
      expect(mockSession.run).not.toHaveBeenCalled();
    });
  });

  describe('searchByPhrase — integration seams', () => {
    it('applies custom labels to WHERE in phrase search', async () => {
      await model.searchByPhrase({
        indexName: 'BookPhraseIdx',
        phrase: 'hello',
        k: 1,
        labels: ['Active', 'Published'],
      });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        'WHERE n:`Book` AND n:`Active` AND n:`Published`',
      );
    });

    it('supports the typed select API in phrase search', async () => {
      await model.searchByPhrase({
        indexName: 'BookPhraseIdx',
        phrase: 'hello',
        k: 1,
        select: { id: true, title: true },
      });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain('RETURN n {');
      expect(cypher).toContain('.`id`');
      expect(cypher).toContain('.`title`');
      expect(cypher).toContain(', score');
    });

    it('throws without hitting the DB on whitespace-only phrase', async () => {
      await expect(
        model.searchByPhrase({
          indexName: 'BookPhraseIdx',
          phrase: '   \t\n',
          k: 1,
        }),
      ).rejects.toThrow(/"phrase" must be a non-empty string/);
      expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('rejects unsafe labels without hitting the DB', async () => {
      await expect(
        model.searchByPhrase({
          indexName: 'BookPhraseIdx',
          phrase: 'hello',
          k: 1,
          labels: ['Bad; DROP DATABASE'],
        }),
      ).rejects.toThrow(/Invalid identifier/);
      expect(mockSession.run).not.toHaveBeenCalled();
    });
  });

  // --- Backward compatibility for the global FulltextInput type --------------

  describe('backward compat — global FulltextInput still works at runtime', () => {
    it('accepts a generic FulltextInput shape on find() after F1 typed emission', async () => {
      // Simulates a v1.2.0 user whose code is typed against the loose
      // FulltextInput exported from grafeo-ogm. Runtime behavior is
      // independent of the tighter per-node generated FulltextInput types,
      // so existing queries must continue to work unchanged.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { isFulltextLeaf, isFulltextIndexEntry } = require('../src/model');

      const input = {
        BookTitleSearch: { phrase: '*x*', score: 0.4 },
      };
      // Type guards exported from runtime API — keep working for legacy users.
      expect(isFulltextLeaf(input)).toBe(true);
      expect(
        isFulltextIndexEntry(
          (input as Record<string, { phrase: string }>).BookTitleSearch,
        ),
      ).toBe(true);

      await model.find({ fulltext: input });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        "CALL db.index.fulltext.queryNodes('BookTitleSearch'",
      );
    });

    it('accepts OR/AND/NOT composition on find() as before', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { FulltextInput } = require('../src/model') as {
        FulltextInput: unknown;
      };
      void FulltextInput; // runtime value is undefined (type-only export)
      const input = {
        OR: [
          { BookTitleSearch: { phrase: 'a' } },
          { AND: [{ BookTitleSearch: { phrase: 'b', score: 0.2 } }] },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      await model.find({ fulltext: input });
      // Runtime accepted the structure; the FulltextCompiler handled it.
      const cypher = getCypher(mockSession);
      expect(cypher).toContain('CALL db.index.fulltext.queryNodes(');
    });
  });
});
