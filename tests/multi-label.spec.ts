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
  [prop('id', { isGenerated: true }), prop('title')],
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
          updates: () => ({
            nodesCreated: 0,
            nodesDeleted: 0,
            relationshipsCreated: 0,
            relationshipsDeleted: 0,
          }),
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

// --- Tests ------------------------------------------------------------------

describe('Multi-label query patterns', () => {
  let model: Model;
  let mockSession: ReturnType<typeof createMockDriver>['mockSession'];

  beforeEach(() => {
    const { mockDriver, mockSession: ms } = createMockDriver();
    mockSession = ms;
    model = new Model(bookNode, schema, mockDriver);
  });

  // ---- Multi-label find tests ----------------------------------------------

  describe('find() with labels', () => {
    it('should add a single label to MATCH pattern', async () => {
      await model.find({ labels: ['Active'] });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`:`Active`)');
    });

    it('should add multiple labels to MATCH pattern', async () => {
      await model.find({ labels: ['A', 'B'] });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`:`A`:`B`)');
    });

    it('should produce standard MATCH when no labels are provided', async () => {
      await model.find();

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).not.toMatch(/MATCH \(n:`Book`:/);
    });

    it('should produce standard MATCH when labels array is empty', async () => {
      await model.find({ labels: [] });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).not.toMatch(/MATCH \(n:`Book`:/);
    });

    it('should add label filters in WHERE after fulltext YIELD', async () => {
      await model.find({
        fulltext: { BookTitleSearch: { phrase: '*albuterol*' } },
        labels: ['Active'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        "CALL db.index.fulltext.queryNodes('BookTitleSearch'",
      );
      expect(cypher).toContain('YIELD node AS n, score');
      expect(cypher).toContain('WHERE n:`Book` AND n:`Active`');
      // Should NOT use MATCH pattern for fulltext queries
      expect(cypher).not.toContain('MATCH (n:`Book`:`Active`)');
    });
  });

  // ---- setLabels tests -----------------------------------------------------

  describe('setLabels()', () => {
    it('should produce SET with addLabels', async () => {
      await model.setLabels({
        where: { id: '123' },
        addLabels: ['Active'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).toContain('WHERE');
      expect(cypher).toContain('SET n:`Active`');
    });

    it('should produce REMOVE with removeLabels', async () => {
      await model.setLabels({
        where: { id: '456' },
        removeLabels: ['Draft'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).toContain('WHERE');
      expect(cypher).toContain('REMOVE n:`Draft`');
    });

    it('should produce both SET and REMOVE when add and remove are provided', async () => {
      await model.setLabels({
        where: { id: '789' },
        addLabels: ['Active'],
        removeLabels: ['Draft'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('SET n:`Active`');
      expect(cypher).toContain('REMOVE n:`Draft`');

      // SET should come before REMOVE
      const setIndex = cypher.indexOf('SET n:`Active`');
      const removeIndex = cypher.indexOf('REMOVE n:`Draft`');
      expect(setIndex).toBeLessThan(removeIndex);
    });

    it('should work with only addLabels provided (no removeLabels)', async () => {
      await model.setLabels({
        where: { id: '100' },
        addLabels: ['Published'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('SET n:`Published`');
      expect(cypher).not.toContain('REMOVE');
    });

    it('should work with only removeLabels provided (no addLabels)', async () => {
      await model.setLabels({
        where: { id: '200' },
        removeLabels: ['Archived'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('REMOVE n:`Archived`');
      expect(cypher).not.toMatch(/SET n:/);
    });
  });

  // ---- Multi-label create tests ---------------------------------------------

  describe('create() with labels', () => {
    it('should add SET label after CREATE', async () => {
      await model.create({
        input: [{ title: 'Albuterol' }],
        labels: ['Active'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('CREATE (n:`Book`');
      expect(cypher).toContain('SET n:`Active`');
      // SET label should come before RETURN
      const setIdx = cypher.indexOf('SET n:`Active`');
      const returnIdx = cypher.indexOf('RETURN n');
      expect(setIdx).toBeLessThan(returnIdx);
    });

    it('should add multiple labels after CREATE', async () => {
      await model.create({
        input: [{ title: 'Albuterol' }],
        labels: ['Active', 'Approved'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('SET n:`Active`:`Approved`');
    });

    it('should not add SET label when no labels provided', async () => {
      await model.create({
        input: [{ title: 'Albuterol' }],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).not.toMatch(/SET n:/);
    });

    it('should not add SET label when labels array is empty', async () => {
      await model.create({
        input: [{ title: 'Albuterol' }],
        labels: [],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).not.toMatch(/SET n:/);
    });
  });

  // ---- Multi-label update tests ---------------------------------------------

  describe('update() with labels', () => {
    it('should add labels to MATCH pattern in update', async () => {
      await model.update({
        where: { id: '123' },
        update: { title: 'Albuterol Sulfate' },
        labels: ['Active'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`:`Active`)');
    });

    it('should add multiple labels to MATCH pattern in update', async () => {
      await model.update({
        where: { id: '123' },
        update: { title: 'Albuterol Sulfate' },
        labels: ['Active', 'Approved'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`:`Active`:`Approved`)');
    });

    it('should produce standard MATCH when no labels provided', async () => {
      await model.update({
        where: { id: '123' },
        update: { title: 'Albuterol Sulfate' },
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).not.toMatch(/MATCH \(n:`Book`:/);
    });

    it('should produce standard MATCH when labels array is empty', async () => {
      await model.update({
        where: { id: '123' },
        update: { title: 'Albuterol Sulfate' },
        labels: [],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`)');
      expect(cypher).not.toMatch(/MATCH \(n:`Book`:/);
    });
  });

  // ---- Multi-label + aggregate tests ---------------------------------------

  describe('aggregate() with labels', () => {
    it('should add labels to MATCH pattern in aggregate queries', async () => {
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

      await model.aggregate({
        aggregate: { count: true },
        labels: ['Active'],
      });

      const cypher = getCypher(mockSession);
      expect(cypher).toContain('MATCH (n:`Book`:`Active`)');
      expect(cypher).toContain('RETURN count(n) AS count');
    });
  });
});
