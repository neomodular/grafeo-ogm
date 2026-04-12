import { Driver } from 'neo4j-driver';
import { Model } from '../src/model';
import { OGM } from '../src/ogm';
import { MutationCompiler } from '../src/compilers/mutation.compiler';
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
    prop('id', { isGenerated: true, isUnique: true }),
    prop('title'),
    prop('externalId', { isUnique: true }),
  ],
  [rel('hasStatus', 'HAS_STATUS', 'Status', { isArray: false })],
);

const authorNode = nodeDef('Author', [
  prop('id', { isGenerated: true, isUnique: true }),
  prop('name'),
]);

const schema: SchemaMetadata = {
  nodes: new Map([
    ['Book', bookNode],
    ['Status', statusNode],
    ['Author', authorNode],
  ]),
  interfaces: new Map(),
  relationshipProperties: new Map(),
  enums: new Map(),
  unions: new Map(),
};

// --- Mock driver ------------------------------------------------------------

function createMockDriver(records: Record<string, unknown>[] = []) {
  const mockSession = {
    run: jest.fn().mockResolvedValue({
      records: records.map((rec) => ({
        keys: Object.keys(rec),
        get: (key: string) => rec[key] ?? null,
        toObject: () => rec,
      })),
      summary: {
        counters: {
          updates: () => ({
            nodesCreated: 0,
            nodesDeleted: 0,
            relationshipsCreated: 0,
            relationshipsDeleted: 0,
            propertiesSet: 0,
          }),
        },
      },
    }),
    close: jest.fn().mockResolvedValue(undefined),
    beginTransaction: jest.fn(),
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

// =============================================================================
// Tests
// =============================================================================

describe('MutationCompiler.compileCreateMany()', () => {
  let compiler: MutationCompiler;

  beforeEach(() => {
    compiler = new MutationCompiler(schema);
  });

  it('should produce UNWIND + CREATE cypher', () => {
    const result = compiler.compileCreateMany(
      [{ title: 'Book A' }, { title: 'Book B' }],
      bookNode,
    );

    expect(result.cypher).toContain('UNWIND $items AS item');
    expect(result.cypher).toContain('CREATE (n:`Book`');
    expect(result.cypher).toContain('item.`title`');
    expect(result.cypher).toContain('RETURN count(n) AS count');
    expect(result.params.items).toHaveLength(2);
  });

  it('should auto-generate UUIDs for @id fields not in data', () => {
    const result = compiler.compileCreateMany([{ title: 'Book A' }], bookNode);

    // id is isGenerated and not in data, so randomUUID() should appear
    expect(result.cypher).toContain('`id`: randomUUID()');
  });

  it('should not auto-generate UUID when @id field is provided in data', () => {
    const result = compiler.compileCreateMany(
      [{ id: 'custom-id', title: 'Book A' }],
      bookNode,
    );

    // id IS in data, so no randomUUID() — use item.id instead
    expect(result.cypher).toContain('item.`id`');
    expect(result.cypher).not.toContain('randomUUID()');
  });

  it('should throw on relationship fields in data', () => {
    expect(() =>
      compiler.compileCreateMany(
        [{ title: 'Book A', hasStatus: { id: '1' } }],
        bookNode,
      ),
    ).toThrow('createMany does not support relationship fields');
  });

  it('should use MERGE for skipDuplicates with unique fields', () => {
    const result = compiler.compileCreateMany(
      [{ externalId: 'EXT-1', title: 'Book A' }],
      bookNode,
      true, // skipDuplicates
    );

    expect(result.cypher).toContain('MERGE (n:`Book`');
    expect(result.cypher).toContain('`externalId`: item.`externalId`');
    expect(result.cypher).toContain('ON CREATE SET');
    expect(result.cypher).toContain('item.`title`');
    expect(result.cypher).not.toContain('CREATE (n:');
  });

  it('should throw skipDuplicates without unique fields', () => {
    // statusNode has no unique or generated fields
    expect(() =>
      compiler.compileCreateMany([{ name: 'Active' }], statusNode, true),
    ).toThrow('skipDuplicates requires at least one @id or @unique field');
  });

  it('should return empty count cypher for empty data', () => {
    const result = compiler.compileCreateMany([], bookNode);
    expect(result.cypher).toBe('RETURN 0 AS count');
  });

  it('should apply extra labels', () => {
    const result = compiler.compileCreateMany(
      [{ title: 'Book A' }],
      bookNode,
      false,
      ['Active', 'Reviewed'],
    );

    expect(result.cypher).toContain('SET n:`Active`:`Reviewed`');
  });
});

describe('Model.createMany()', () => {
  it('should create nodes and return count', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [
        {
          keys: ['count'],
          get: (key: string) => (key === 'count' ? 3 : null),
          toObject: () => ({ count: 3 }),
        },
      ],
      summary: { counters: { updates: () => ({}) } },
    });

    const model = new Model(bookNode, schema, mockDriver);
    const result = await model.createMany({
      data: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
    });

    expect(result).toEqual({ count: 3 });
    const cypher = getCypher(mockSession);
    expect(cypher).toContain('UNWIND $items AS item');
    expect(cypher).toContain('CREATE');
  });

  it('should pass through transaction context', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [
        {
          keys: ['count'],
          get: (key: string) => (key === 'count' ? 1 : null),
          toObject: () => ({ count: 1 }),
        },
      ],
      summary: { counters: { updates: () => ({}) } },
    });

    const mockTx = { run: mockSession.run } as any;
    const model = new Model(bookNode, schema, mockDriver);

    await model.createMany({
      data: [{ title: 'A' }],
      context: { transaction: mockTx },
    });

    // Verify the model executed against the provided context
    expect(mockSession.run).toHaveBeenCalled();
  });
});

describe('Model.updateMany()', () => {
  it('should update matching nodes and return count', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [
        {
          keys: ['count'],
          get: (key: string) => (key === 'count' ? 5 : null),
          toObject: () => ({ count: 5 }),
        },
      ],
      summary: { counters: { updates: () => ({}) } },
    });

    const model = new Model(bookNode, schema, mockDriver);
    const result = await model.updateMany({
      where: { title: 'OldName' },
      data: { title: 'NewName' },
    });

    expect(result).toEqual({ count: 5 });
    const cypher = getCypher(mockSession);
    expect(cypher).toContain('MATCH (n:`Book`)');
    expect(cypher).toContain('WHERE');
    expect(cypher).toContain('SET');
    expect(cypher).toContain('RETURN count(n) AS count');
    // Should NOT have "RETURN n" at the end
    expect(cypher).not.toMatch(/RETURN n\s*$/);
  });

  it('should return count 0 when no nodes match', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [
        {
          keys: ['count'],
          get: (key: string) => (key === 'count' ? 0 : null),
          toObject: () => ({ count: 0 }),
        },
      ],
      summary: { counters: { updates: () => ({}) } },
    });

    const model = new Model(bookNode, schema, mockDriver);
    const result = await model.updateMany({
      where: { title: 'Nonexistent' },
      data: { title: 'NewName' },
    });

    expect(result).toEqual({ count: 0 });
  });

  it('should apply extra labels to MATCH pattern', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [
        {
          keys: ['count'],
          get: (key: string) => (key === 'count' ? 2 : null),
          toObject: () => ({ count: 2 }),
        },
      ],
      summary: { counters: { updates: () => ({}) } },
    });

    const model = new Model(bookNode, schema, mockDriver);
    await model.updateMany({
      data: { title: 'Updated' },
      labels: ['Active'],
    });

    const cypher = getCypher(mockSession);
    expect(cypher).toContain('`Active`');
  });
});

describe('Model.deleteMany()', () => {
  it('should delete matching nodes and return count', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [],
      summary: {
        counters: {
          updates: () => ({
            nodesCreated: 0,
            nodesDeleted: 7,
            relationshipsCreated: 0,
            relationshipsDeleted: 3,
            propertiesSet: 0,
          }),
        },
      },
    });

    const model = new Model(bookNode, schema, mockDriver);
    const result = await model.deleteMany({
      where: { title: 'Archived' },
    });

    expect(result).toEqual({ count: 7 });
    const cypher = getCypher(mockSession);
    expect(cypher).toContain('MATCH (n:`Book`)');
    expect(cypher).toContain('WHERE');
    expect(cypher).toContain('DETACH DELETE n');
  });

  it('should return count 0 when no nodes match', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [],
      summary: {
        counters: {
          updates: () => ({
            nodesCreated: 0,
            nodesDeleted: 0,
            relationshipsCreated: 0,
            relationshipsDeleted: 0,
            propertiesSet: 0,
          }),
        },
      },
    });

    const model = new Model(bookNode, schema, mockDriver);
    const result = await model.deleteMany({
      where: { title: 'Nonexistent' },
    });

    expect(result).toEqual({ count: 0 });
  });

  it('should not support cascade (no delete input)', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [],
      summary: {
        counters: {
          updates: () => ({
            nodesCreated: 0,
            nodesDeleted: 1,
            relationshipsCreated: 0,
            relationshipsDeleted: 0,
            propertiesSet: 0,
          }),
        },
      },
    });

    const model = new Model(bookNode, schema, mockDriver);
    await model.deleteMany({ where: { id: '1' } });

    const cypher = getCypher(mockSession);
    // Simple DETACH DELETE without OPTIONAL MATCH cascade
    expect(cypher).not.toContain('OPTIONAL MATCH');
    expect(cypher).toContain('DETACH DELETE n');
  });
});

describe('OGM.$transaction() (sequential)', () => {
  function createTxMocks() {
    let callCount = 0;
    const mockTx = {
      run: jest.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          records: [
            {
              keys: ['result'],
              get: (key: string) =>
                key === 'result' ? `result-${callCount}` : null,
              toObject: () => ({ result: `result-${callCount}` }),
            },
          ],
          summary: { counters: { updates: () => ({}) } },
        });
      }),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    };

    const mockSession = {
      run: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      beginTransaction: jest.fn().mockReturnValue(mockTx),
    };

    const mockDriver = {
      session: jest.fn().mockReturnValue(mockSession),
    } as unknown as Driver;

    return { mockDriver, mockSession, mockTx };
  }

  it('should execute operations sequentially in one transaction', async () => {
    const { mockDriver, mockSession, mockTx } = createTxMocks();

    const ogm = new OGM({
      typeDefs: `type Book @node { id: ID! @id title: String! }`,
      driver: mockDriver,
    });

    const executionOrder: number[] = [];

    const results = await ogm.$transaction([
      async (ctx) => {
        expect(ctx.transaction).toBe(mockTx);
        executionOrder.push(1);
        return 'first';
      },
      async (ctx) => {
        expect(ctx.transaction).toBe(mockTx);
        executionOrder.push(2);
        return 'second';
      },
      async (ctx) => {
        expect(ctx.transaction).toBe(mockTx);
        executionOrder.push(3);
        return 'third';
      },
    ]);

    expect(results).toEqual(['first', 'second', 'third']);
    expect(executionOrder).toEqual([1, 2, 3]);
    expect(mockTx.commit).toHaveBeenCalledTimes(1);
    expect(mockTx.rollback).not.toHaveBeenCalled();
    expect(mockSession.close).toHaveBeenCalled();
  });

  it('should return results as tuple matching input order', async () => {
    const { mockDriver } = createTxMocks();

    const ogm = new OGM({
      typeDefs: `type Book @node { id: ID! @id }`,
      driver: mockDriver,
    });

    const [a, b] = await ogm.$transaction([
      async () => 42,
      async () => 'hello',
    ]);

    expect(a).toBe(42);
    expect(b).toBe('hello');
  });

  it('should rollback all operations if any fails', async () => {
    const { mockDriver, mockSession, mockTx } = createTxMocks();

    const ogm = new OGM({
      typeDefs: `type Book @node { id: ID! @id }`,
      driver: mockDriver,
    });

    await expect(
      ogm.$transaction([
        async () => 'ok',
        async () => {
          throw new Error('Operation 2 failed');
        },
        async () => 'should not run',
      ]),
    ).rejects.toThrow('Operation 2 failed');

    expect(mockTx.rollback).toHaveBeenCalledTimes(1);
    expect(mockTx.commit).not.toHaveBeenCalled();
    expect(mockSession.close).toHaveBeenCalled();
  });

  it('should still work with callback-based transaction (existing API)', async () => {
    const { mockDriver, mockTx } = createTxMocks();

    const ogm = new OGM({
      typeDefs: `type Book @node { id: ID! @id }`,
      driver: mockDriver,
    });

    const result = await ogm.$transaction(async (ctx) => {
      expect(ctx.transaction).toBe(mockTx);
      return 'callback-result';
    });

    expect(result).toBe('callback-result');
    expect(mockTx.commit).toHaveBeenCalled();
  });
});
