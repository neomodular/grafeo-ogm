import { Driver } from 'neo4j-driver';
import { WhereCompiler } from '../src/compilers/where.compiler';
import { FulltextCompiler } from '../src/compilers/fulltext.compiler';
import { OGM } from '../src/ogm';
import {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../src/schema/types';

// --- Helper factories (same pattern as model.spec.ts) -----------------------

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

function createSchema(nodes: [string, NodeDefinition][] = []): SchemaMetadata {
  return {
    nodes: new Map(nodes),
    interfaces: new Map(),
    relationshipProperties: new Map(),
    enums: new Map(),
    unions: new Map(),
  };
}

function createMockDriver(): Driver {
  const mockSession = {
    run: jest.fn().mockResolvedValue({ records: [], summary: {} }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    session: jest.fn().mockReturnValue(mockSession),
  } as unknown as Driver;
}

// --- Fixtures ---------------------------------------------------------------

const simpleNode = nodeDef('Book', [prop('id'), prop('name')]);
const simpleSchema = createSchema([['Book', simpleNode]]);

const fulltextNode = nodeDef('Book', [prop('id'), prop('title')], [], {
  fulltextIndexes: [{ name: 'BookTitleSearch', fields: ['title'] }],
});
const fulltextSchema = createSchema([['Book', fulltextNode]]);

// --- Tests ------------------------------------------------------------------

describe('Error Paths', () => {
  describe('WhereCompiler', () => {
    let compiler: WhereCompiler;

    beforeEach(() => {
      compiler = new WhereCompiler(simpleSchema);
    });

    describe('empty/null/undefined where inputs', () => {
      it('should return empty WHERE clause for empty object {}', () => {
        const result = compiler.compile({}, 'n', simpleNode);
        expect(result.cypher).toBe('');
        expect(result.params).toEqual({});
      });

      it('should return empty WHERE clause for null', () => {
        const result = compiler.compile(null, 'n', simpleNode);
        expect(result.cypher).toBe('');
        expect(result.params).toEqual({});
      });

      it('should return empty WHERE clause for undefined', () => {
        const result = compiler.compile(undefined, 'n', simpleNode);
        expect(result.cypher).toBe('');
        expect(result.params).toEqual({});
      });
    });

    describe('injection safety (values are parameterized)', () => {
      it('should parameterize SQL injection attempt, not embed in cypher', () => {
        const result = compiler.compile(
          { name: "'; DROP TABLE--" },
          'n',
          simpleNode,
        );
        expect(result.cypher).toBe('n.`name` = $param0');
        expect(result.params.param0).toBe("'; DROP TABLE--");
        // The malicious string is in params, never in cypher text
        expect(result.cypher).not.toContain('DROP');
      });

      it('should parameterize Cypher injection attempt, not embed in cypher', () => {
        const result = compiler.compile(
          { name: '}) RETURN n //' },
          'n',
          simpleNode,
        );
        expect(result.cypher).toBe('n.`name` = $param0');
        expect(result.params.param0).toBe('}) RETURN n //');
        expect(result.cypher).not.toContain('RETURN');
      });
    });

    describe('depth limit', () => {
      it('should throw when nesting exceeds 10 levels', () => {
        // Build a where object nested 11 levels deep via AND
        let deepWhere: Record<string, unknown> = { name: 'leaf' };
        for (let i = 0; i < 11; i++) deepWhere = { AND: [deepWhere] };

        expect(() => compiler.compile(deepWhere, 'n', simpleNode)).toThrow(
          /WHERE clause nesting depth exceeds maximum/,
        );
      });

      it('should not throw at exactly 10 levels of nesting', () => {
        let deepWhere: Record<string, unknown> = { name: 'leaf' };
        for (let i = 0; i < 10; i++) deepWhere = { AND: [deepWhere] };

        expect(() =>
          compiler.compile(deepWhere, 'n', simpleNode),
        ).not.toThrow();
      });
    });
  });

  describe('FulltextCompiler', () => {
    let compiler: FulltextCompiler;

    beforeEach(() => {
      compiler = new FulltextCompiler(fulltextSchema);
    });

    it('should throw when fulltext index name is unknown', () => {
      expect(() =>
        compiler.compile(
          { NonExistentIndex: { phrase: 'test' } },
          fulltextNode,
        ),
      ).toThrow(/Unknown fulltext index "NonExistentIndex"/);
    });

    it('should not leak index names in error message', () => {
      expect(() =>
        compiler.compile({ BadIndex: { phrase: 'test' } }, fulltextNode),
      ).toThrow(/Unknown fulltext index "BadIndex"/);
      expect(() =>
        compiler.compile({ BadIndex: { phrase: 'test' } }, fulltextNode),
      ).not.toThrow(/BookTitleSearch/);
    });

    it('should throw when phrase is an empty string', () => {
      expect(() =>
        compiler.compile({ BookTitleSearch: { phrase: '' } }, fulltextNode),
      ).toThrow('Fulltext phrase must not be empty');
    });

    it('should throw when phrase is whitespace only', () => {
      expect(() =>
        compiler.compile({ BookTitleSearch: { phrase: '   ' } }, fulltextNode),
      ).toThrow('Fulltext phrase must not be empty');
    });

    it('should throw when fulltext input is empty object', () => {
      expect(() =>
        compiler.compile(
          {} as Record<string, { phrase: string }>,
          fulltextNode,
        ),
      ).toThrow('Fulltext input must contain at least one index entry');
    });
  });

  describe('OGM', () => {
    const minimalTypeDefs = `
      type Book @node {
        id: ID! @id
        name: String
      }
    `;

    describe('before init() (schema parsed in constructor)', () => {
      it('should allow calling model() without init()', () => {
        const ogm = new OGM({
          typeDefs: minimalTypeDefs,
          driver: createMockDriver(),
        });

        const model = ogm.model('Book');
        expect(model).toBeDefined();
      });

      it('should throw "Unknown interface type" for non-existent interface', () => {
        const ogm = new OGM({
          typeDefs: minimalTypeDefs,
          driver: createMockDriver(),
        });

        expect(() => ogm.interfaceModel('Entity')).toThrow(
          'Unknown interface type: Entity',
        );
      });

      it('should allow calling assertIndexesAndConstraints() without init()', async () => {
        const ogm = new OGM({
          typeDefs: minimalTypeDefs,
          driver: createMockDriver(),
        });

        await expect(
          ogm.assertIndexesAndConstraints({ options: { create: true } }),
        ).resolves.toBeUndefined();
      });
    });

    describe('after init() with unknown types', () => {
      it('should throw "Unknown node type" for non-existent node name', async () => {
        const ogm = new OGM({
          typeDefs: minimalTypeDefs,
          driver: createMockDriver(),
        });
        await ogm.init();

        expect(() => ogm.model('NonExistentNode')).toThrow(
          'Unknown type: NonExistentNode. Not found in nodes or interfaces.',
        );
      });

      it('should throw "Unknown interface type" for non-existent interface name', async () => {
        const ogm = new OGM({
          typeDefs: minimalTypeDefs,
          driver: createMockDriver(),
        });
        await ogm.init();

        expect(() => ogm.interfaceModel('NonExistentInterface')).toThrow(
          'Unknown interface type: NonExistentInterface',
        );
      });
    });
  });
});
