import { Driver, Transaction } from 'neo4j-driver';
import { Model } from '../src/model';
import { InterfaceModel } from '../src/interface-model';
import { OGM } from '../src/ogm';
import { RecordNotFoundError } from '../src/errors';
import { MutationCompiler } from '../src/compilers/mutation.compiler';
import { WhereCompiler } from '../src/compilers/where.compiler';
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
    prop('computedField', { isCypher: true }),
  ],
  [rel('hasStatus', 'HAS_STATUS', 'Status', { isArray: false })],
  {
    fulltextIndexes: [{ name: 'BookTitleSearch', fields: ['title'] }],
  },
);

const entityInterface: InterfaceDefinition = {
  name: 'Entity',
  label: 'Entity',
  properties: new Map([
    ['id', prop('id', { isUnique: true })],
    ['name', prop('name')],
  ]),
  relationships: new Map(),
  implementedBy: ['User', 'Organization'],
};

const schema: SchemaMetadata = {
  nodes: new Map([
    ['Book', bookNode],
    ['Status', statusNode],
  ]),
  interfaces: new Map([['Entity', entityInterface]]),
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

describe('RecordNotFoundError', () => {
  it('should include model name in message', () => {
    const error = new RecordNotFoundError('Book');
    expect(error.message).toBe('No Book record found');
    expect(error.model).toBe('Book');
    expect(error.where).toBeUndefined();
    expect(error.name).toBe('RecordNotFoundError');
    expect(error).toBeInstanceOf(Error);
  });

  it('should include where clause in message', () => {
    const error = new RecordNotFoundError('Book', { id: '123' });
    expect(error.message).toContain('Book');
    expect(error.message).toContain('123');
    expect(error.where).toEqual({ id: '123' });
  });
});

describe('Model.findFirst()', () => {
  it('should return first result with LIMIT 1', async () => {
    const { mockDriver, mockSession } = createMockDriver([
      { n: { id: '1', title: 'Albuterol' } },
    ]);
    const model = new Model(bookNode, schema, mockDriver);

    const result = await model.findFirst({ where: { id: '1' } });

    const cypher = getCypher(mockSession);
    expect(cypher).toContain('LIMIT');
    expect(result).toEqual({ id: '1', title: 'Albuterol' });
  });

  it('should return null when no results', async () => {
    const { mockDriver } = createMockDriver([]);
    const model = new Model(bookNode, schema, mockDriver);

    const result = await model.findFirst({ where: { id: 'nonexistent' } });
    expect(result).toBeNull();
  });

  it('should work without params', async () => {
    const { mockDriver, mockSession } = createMockDriver([
      { n: { id: '1', title: 'Albuterol' } },
    ]);
    const model = new Model(bookNode, schema, mockDriver);

    const result = await model.findFirst();

    const cypher = getCypher(mockSession);
    expect(cypher).toContain('MATCH (n:`Book`)');
    expect(cypher).toContain('LIMIT');
    expect(result).not.toBeNull();
  });

  it('should pass through sort and offset options', async () => {
    const { mockDriver, mockSession } = createMockDriver([]);
    const model = new Model(bookNode, schema, mockDriver);

    await model.findFirst({
      options: { sort: [{ title: 'ASC' }], offset: 5 },
    });

    const cypher = getCypher(mockSession);
    expect(cypher).toContain('ORDER BY n.`title` ASC');
    expect(cypher).toContain('SKIP');
    expect(cypher).toContain('LIMIT');
  });
});

describe('Model.findUnique()', () => {
  it('should return result matching unique field', async () => {
    const { mockDriver } = createMockDriver([
      { n: { id: '1', title: 'Albuterol' } },
    ]);
    const model = new Model(bookNode, schema, mockDriver);

    const result = await model.findUnique({ where: { id: '1' } });
    expect(result).toEqual({ id: '1', title: 'Albuterol' });
  });

  it('should return null when not found', async () => {
    const { mockDriver } = createMockDriver([]);
    const model = new Model(bookNode, schema, mockDriver);

    const result = await model.findUnique({ where: { id: 'nonexistent' } });
    expect(result).toBeNull();
  });
});

describe('Model.findFirstOrThrow()', () => {
  it('should return result when found', async () => {
    const { mockDriver } = createMockDriver([
      { n: { id: '1', title: 'Albuterol' } },
    ]);
    const model = new Model(bookNode, schema, mockDriver);

    const result = await model.findFirstOrThrow({ where: { id: '1' } });
    expect(result).toEqual({ id: '1', title: 'Albuterol' });
  });

  it('should throw RecordNotFoundError when not found', async () => {
    const { mockDriver } = createMockDriver([]);
    const model = new Model(bookNode, schema, mockDriver);

    await expect(
      model.findFirstOrThrow({ where: { id: 'nonexistent' } }),
    ).rejects.toThrow(RecordNotFoundError);
  });

  it('should include model name and where in error', async () => {
    const { mockDriver } = createMockDriver([]);
    const model = new Model(bookNode, schema, mockDriver);

    try {
      await model.findFirstOrThrow({ where: { id: '999' } });
      fail('Expected RecordNotFoundError');
    } catch (error) {
      expect(error).toBeInstanceOf(RecordNotFoundError);
      expect((error as RecordNotFoundError).model).toBe('Book');
      expect((error as RecordNotFoundError).where).toEqual({ id: '999' });
    }
  });

  it('should throw when called with no params and no results', async () => {
    const { mockDriver } = createMockDriver([]);
    const model = new Model(bookNode, schema, mockDriver);

    await expect(model.findFirstOrThrow()).rejects.toThrow(RecordNotFoundError);
  });
});

describe('Model.findUniqueOrThrow()', () => {
  it('should return result when found', async () => {
    const { mockDriver } = createMockDriver([
      { n: { id: '1', title: 'Albuterol' } },
    ]);
    const model = new Model(bookNode, schema, mockDriver);

    const result = await model.findUniqueOrThrow({ where: { id: '1' } });
    expect(result).toEqual({ id: '1', title: 'Albuterol' });
  });

  it('should throw RecordNotFoundError when not found', async () => {
    const { mockDriver } = createMockDriver([]);
    const model = new Model(bookNode, schema, mockDriver);

    await expect(
      model.findUniqueOrThrow({ where: { id: 'nonexistent' } }),
    ).rejects.toThrow(RecordNotFoundError);
  });
});

describe('Model.count()', () => {
  it('should return count as a number', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [
        {
          keys: ['count'],
          get: (key: string) => (key === 'count' ? 42 : null),
          toObject: () => ({ count: 42 }),
        },
      ],
      summary: { counters: { updates: () => ({}) } },
    });

    const model = new Model(bookNode, schema, mockDriver);
    const count = await model.count();

    const cypher = getCypher(mockSession);
    expect(cypher).toContain('RETURN count(n) AS count');
    expect(count).toBe(42);
  });

  it('should return 0 when no records', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [],
      summary: { counters: { updates: () => ({}) } },
    });

    const model = new Model(bookNode, schema, mockDriver);
    const count = await model.count();
    expect(count).toBe(0);
  });

  it('should pass where clause for filtered count', async () => {
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
    const count = await model.count({ where: { title: 'Aspirin' } });

    const cypher = getCypher(mockSession);
    expect(cypher).toContain('WHERE');
    expect(cypher).toContain('RETURN count(n) AS count');
    expect(count).toBe(5);
  });

  it('should pass labels for filtered count', async () => {
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
    const count = await model.count({ labels: ['Active'] });

    const cypher = getCypher(mockSession);
    expect(cypher).toContain('MATCH (n:`Book`:`Active`)');
    expect(count).toBe(3);
  });
});

describe('MutationCompiler.compileMerge()', () => {
  let compiler: MutationCompiler;

  beforeEach(() => {
    compiler = new MutationCompiler(schema);
  });

  it('should produce MERGE with key properties from where', () => {
    const result = compiler.compileMerge(
      { externalId: 'ABC-123' },
      { externalId: 'ABC-123', title: 'New Book' },
      { title: 'Updated Book' },
      bookNode,
    );

    expect(result.cypher).toContain('MERGE (n:`Book`');
    expect(result.cypher).toContain('`externalId`: $merge_externalId');
    expect(result.params.merge_externalId).toBe('ABC-123');
  });

  it('should produce ON CREATE SET with create properties', () => {
    const result = compiler.compileMerge(
      { externalId: 'ABC-123' },
      { externalId: 'ABC-123', title: 'New Book' },
      { title: 'Updated Book' },
      bookNode,
    );

    expect(result.cypher).toContain('ON CREATE SET');
    expect(result.cypher).toContain('n.`externalId` = $onCreate_externalId');
    expect(result.cypher).toContain('n.`title` = $onCreate_title');
    expect(result.params.onCreate_externalId).toBe('ABC-123');
    expect(result.params.onCreate_title).toBe('New Book');
  });

  it('should produce ON MATCH SET with update properties', () => {
    const result = compiler.compileMerge(
      { externalId: 'ABC-123' },
      { externalId: 'ABC-123', title: 'New Book' },
      { title: 'Updated Book' },
      bookNode,
    );

    expect(result.cypher).toContain('ON MATCH SET');
    expect(result.cypher).toContain('n.`title` = $onMatch_title');
    expect(result.params.onMatch_title).toBe('Updated Book');
  });

  it('should end with RETURN n', () => {
    const result = compiler.compileMerge(
      { externalId: 'ABC-123' },
      { externalId: 'ABC-123' },
      { title: 'Updated' },
      bookNode,
    );

    expect(result.cypher).toMatch(/RETURN n\s*$/);
  });

  it('should throw when where has no scalar properties', () => {
    expect(() =>
      compiler.compileMerge({}, { title: 'New' }, { title: 'Up' }, bookNode),
    ).toThrow('at least one scalar property');
  });

  it('should skip relationship fields in create and update', () => {
    const result = compiler.compileMerge(
      { externalId: 'ABC-123' },
      { externalId: 'ABC-123', hasStatus: { id: '1' } },
      { hasStatus: { id: '2' } },
      bookNode,
    );

    expect(result.cypher).not.toContain('hasStatus');
    // Only externalId should be in ON CREATE SET
    expect(result.cypher).toContain('ON CREATE SET');
    expect(result.cypher).toContain('n.`externalId` = $onCreate_externalId');
  });

  it('should add extra labels when provided', () => {
    const result = compiler.compileMerge(
      { externalId: 'ABC-123' },
      { externalId: 'ABC-123' },
      { title: 'Updated' },
      bookNode,
      ['Active', 'Published'],
    );

    expect(result.cypher).toContain('SET n:`Active`:`Published`');
  });

  it('should skip undefined values in create and update', () => {
    const result = compiler.compileMerge(
      { externalId: 'ABC-123' },
      { externalId: 'ABC-123', title: undefined },
      { title: undefined },
      bookNode,
    );

    expect(result.params.onCreate_title).toBeUndefined();
    expect(result.params.onMatch_title).toBeUndefined();
  });
});

describe('Model.upsert()', () => {
  it('should produce MERGE cypher and return mapped result', async () => {
    const { mockDriver, mockSession } = createMockDriver([
      { n: { id: '1', externalId: 'ABC-123', title: 'Updated Book' } },
    ]);
    const model = new Model(bookNode, schema, mockDriver);

    const result = await model.upsert({
      where: { externalId: 'ABC-123' },
      create: { externalId: 'ABC-123', title: 'New Book' },
      update: { title: 'Updated Book' },
    });

    const cypher = getCypher(mockSession);
    expect(cypher).toContain('MERGE (n:`Book`');
    expect(cypher).toContain('ON CREATE SET');
    expect(cypher).toContain('ON MATCH SET');
    expect(result).toEqual({
      id: '1',
      externalId: 'ABC-123',
      title: 'Updated Book',
    });
  });

  it('should apply selectionSet to RETURN clause', async () => {
    const { mockDriver, mockSession } = createMockDriver([{ n: { id: '1' } }]);
    const model = new Model(bookNode, schema, mockDriver);

    await model.upsert({
      where: { externalId: 'ABC-123' },
      create: { externalId: 'ABC-123', title: 'New' },
      update: { title: 'Updated' },
      selectionSet: '{ id title }',
    });

    const cypher = getCypher(mockSession);
    expect(cypher).toContain('RETURN n {');
    expect(cypher).toContain('.`id`');
    expect(cypher).toContain('.`title`');
  });

  it('should apply select object to RETURN clause', async () => {
    const { mockDriver, mockSession } = createMockDriver([{ n: { id: '1' } }]);
    const model = new Model(bookNode, schema, mockDriver);

    await model.upsert({
      where: { externalId: 'ABC-123' },
      create: { externalId: 'ABC-123', title: 'New' },
      update: { title: 'Updated' },
      select: { id: true },
    });

    const cypher = getCypher(mockSession);
    expect(cypher).toContain('RETURN n {');
    expect(cypher).toContain('.`id`');
  });

  it('should throw when both select and selectionSet are provided', async () => {
    const { mockDriver } = createMockDriver([]);
    const model = new Model(bookNode, schema, mockDriver);

    await expect(
      model.upsert({
        where: { externalId: 'ABC-123' },
        create: { externalId: 'ABC-123' },
        update: { title: 'Updated' },
        select: { id: true },
        selectionSet: '{ id }',
      }),
    ).rejects.toThrow(
      'Cannot provide both "select" and "selectionSet". They are mutually exclusive.',
    );
  });
});

describe('InterfaceModel.findFirst()', () => {
  it('should return first result with __typename', async () => {
    const { mockDriver, mockSession } = createMockDriver([
      { n: { id: '1', name: 'Test', __typename: 'User' } },
    ]);
    const model = new InterfaceModel(entityInterface, schema, mockDriver);

    const result = await model.findFirst({ where: { id: '1' } });

    const cypher = getCypher(mockSession);
    expect(cypher).toContain('LIMIT');
    expect(result).not.toBeNull();
  });

  it('should return null when no results', async () => {
    const { mockDriver } = createMockDriver([]);
    const model = new InterfaceModel(entityInterface, schema, mockDriver);

    const result = await model.findFirst({ where: { id: 'nonexistent' } });
    expect(result).toBeNull();
  });
});

describe('InterfaceModel.findFirstOrThrow()', () => {
  it('should throw RecordNotFoundError when not found', async () => {
    const { mockDriver } = createMockDriver([]);
    const model = new InterfaceModel(entityInterface, schema, mockDriver);

    await expect(
      model.findFirstOrThrow({ where: { id: 'nonexistent' } }),
    ).rejects.toThrow(RecordNotFoundError);

    try {
      await model.findFirstOrThrow({ where: { id: '999' } });
      fail('Expected RecordNotFoundError');
    } catch (error) {
      expect((error as RecordNotFoundError).model).toBe('Entity');
    }
  });
});

describe('InterfaceModel.count()', () => {
  it('should return count as a number', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [
        {
          keys: ['count'],
          get: (key: string) => (key === 'count' ? 15 : null),
          toObject: () => ({ count: 15 }),
        },
      ],
      summary: { counters: { updates: () => ({}) } },
    });

    const model = new InterfaceModel(entityInterface, schema, mockDriver);
    const count = await model.count();

    const cypher = getCypher(mockSession);
    expect(cypher).toContain('RETURN count(n) AS count');
    expect(count).toBe(15);
  });
});

describe('OGM.$queryRaw()', () => {
  it('should execute raw cypher and return mapped records', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [
        {
          keys: ['n'],
          get: (key: string) =>
            key === 'n' ? { id: '1', title: 'Test' } : null,
          toObject: () => ({ n: { id: '1', title: 'Test' } }),
        },
      ],
      summary: { counters: { updates: () => ({}) } },
    });

    const ogm = new OGM({
      typeDefs: `type Book @node { id: ID! @id title: String! }`,
      driver: mockDriver,
    });

    const results = await ogm.$queryRaw<{ n: { id: string } }>(
      'MATCH (n:Book) WHERE n.name =~ $pattern RETURN n',
      { pattern: '.*test.*' },
    );

    expect(mockSession.run).toHaveBeenCalledWith(
      'MATCH (n:Book) WHERE n.name =~ $pattern RETURN n',
      { pattern: '.*test.*' },
    );
    expect(mockSession.close).toHaveBeenCalled();
    expect(results).toHaveLength(1);
  });

  it('should close session even on error', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockRejectedValueOnce(new Error('DB error'));

    const ogm = new OGM({
      typeDefs: `type Book @node { id: ID! @id }`,
      driver: mockDriver,
    });

    await expect(ogm.$queryRaw('BAD CYPHER')).rejects.toThrow('DB error');
    expect(mockSession.close).toHaveBeenCalled();
  });
});

describe('OGM.$executeRaw()', () => {
  it('should execute raw cypher and return recordsAffected', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockResolvedValueOnce({
      records: [],
      summary: {
        counters: {
          updates: () => ({
            nodesDeleted: 3,
            nodesCreated: 0,
            relationshipsCreated: 0,
            relationshipsDeleted: 1,
            propertiesSet: 0,
          }),
        },
      },
    });

    const ogm = new OGM({
      typeDefs: `type Book @node { id: ID! @id }`,
      driver: mockDriver,
    });

    const result = await ogm.$executeRaw(
      'MATCH (n:Book) WHERE n.archived = true DETACH DELETE n',
    );

    expect(result.recordsAffected).toBe(4); // 3 deleted + 1 rel deleted
    expect(mockSession.close).toHaveBeenCalled();
  });

  it('should close session even on error', async () => {
    const { mockDriver, mockSession } = createMockDriver();
    mockSession.run.mockRejectedValueOnce(new Error('Write error'));

    const ogm = new OGM({
      typeDefs: `type Book @node { id: ID! @id }`,
      driver: mockDriver,
    });

    await expect(ogm.$executeRaw('BAD WRITE')).rejects.toThrow('Write error');
    expect(mockSession.close).toHaveBeenCalled();
  });
});

describe('OGM.$transaction()', () => {
  it('should commit transaction on success', async () => {
    const mockTx = {
      run: jest.fn().mockResolvedValue({
        records: [],
        summary: { counters: { updates: () => ({}) } },
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

    const ogm = new OGM({
      typeDefs: `type Book @node { id: ID! @id title: String! }`,
      driver: mockDriver,
    });

    const result = await ogm.$transaction(async (ctx) => {
      // The callback receives a transaction context
      expect(ctx.transaction).toBe(mockTx);
      return 'success';
    });

    expect(result).toBe('success');
    expect(mockTx.commit).toHaveBeenCalled();
    expect(mockTx.rollback).not.toHaveBeenCalled();
    expect(mockSession.close).toHaveBeenCalled();
  });

  it('should rollback transaction on error', async () => {
    const mockTx = {
      run: jest.fn(),
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

    const ogm = new OGM({
      typeDefs: `type Book @node { id: ID! @id }`,
      driver: mockDriver,
    });

    await expect(
      ogm.$transaction(async () => {
        throw new Error('Transaction failed');
      }),
    ).rejects.toThrow('Transaction failed');

    expect(mockTx.rollback).toHaveBeenCalled();
    expect(mockTx.commit).not.toHaveBeenCalled();
    expect(mockSession.close).toHaveBeenCalled();
  });

  it('should close session even when rollback fails', async () => {
    const mockTx = {
      run: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn().mockRejectedValue(new Error('Rollback failed')),
    };

    const mockSession = {
      run: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      beginTransaction: jest.fn().mockReturnValue(mockTx),
    };

    const mockDriver = {
      session: jest.fn().mockReturnValue(mockSession),
    } as unknown as Driver;

    const ogm = new OGM({
      typeDefs: `type Book @node { id: ID! @id }`,
      driver: mockDriver,
    });

    // The rollback error should propagate (not the original error)
    await expect(
      ogm.$transaction(async () => {
        throw new Error('Original error');
      }),
    ).rejects.toThrow();

    expect(mockSession.close).toHaveBeenCalled();
  });
});
