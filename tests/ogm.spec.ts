import { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { Model } from '../src/model';
import { InterfaceModel } from '../src/interface-model';

// --- Test schema (minimal but includes nodes and interfaces) ----------------

const testSchema = `
interface Entity {
  id: ID!
  name: String!
}

type User implements Entity @node(labels: ["Entity", "User"]) {
  id: ID! @id @unique
  name: String!
  givenName: String!
  familyName: String!
  email: String
}

type Organization implements Entity @node(labels: ["Entity", "Organization"]) {
  id: ID! @id @unique
  name: String!
}

type Book
  @fulltext(indexes: [{ name: "BookTitleSearch", fields: ["title"] }]) {
  id: ID! @id @unique
  title: String!
}
`;

// --- Mock driver ------------------------------------------------------------

function createMockDriver(): Driver {
  const mockSession = {
    run: jest.fn().mockResolvedValue({ records: [], summary: {} }),
    close: jest.fn().mockResolvedValue(undefined),
  };

  return {
    session: jest.fn().mockReturnValue(mockSession),
  } as unknown as Driver;
}

// --- Tests ------------------------------------------------------------------

describe('OGM', () => {
  let ogm: OGM;
  let mockDriver: Driver;

  beforeEach(() => {
    mockDriver = createMockDriver();
    ogm = new OGM({ typeDefs: testSchema, driver: mockDriver });
  });

  describe('init()', () => {
    it('should parse schema successfully', async () => {
      await expect(ogm.init()).resolves.toBeUndefined();
    });
  });

  describe('model()', () => {
    it('should work without calling init() (schema parsed in constructor)', () => {
      const bookModel = ogm.model('Book');
      expect(bookModel).toBeInstanceOf(Model);
    });

    it('should return a Model instance for a known node type', async () => {
      await ogm.init();
      const bookModel = ogm.model('Book');
      expect(bookModel).toBeInstanceOf(Model);
    });

    it('should return an InterfaceModel when name matches an interface', () => {
      const entityModel = ogm.model('Entity');
      expect(entityModel).toBeInstanceOf(InterfaceModel);
    });

    it('should cache interface model returned via model() fallback', () => {
      const first = ogm.model('Entity');
      const second = ogm.model('Entity');
      expect(first).toBe(second);
    });

    it('should return same instance whether accessed via model() or interfaceModel()', () => {
      const viaModel = ogm.model('Entity');
      const viaInterface = ogm.interfaceModel('Entity');
      expect(viaModel).toBe(viaInterface);
    });

    it('should throw for unknown type with descriptive message', async () => {
      await ogm.init();
      expect(() => ogm.model('NonExistent')).toThrow(
        'Unknown type: NonExistent. Not found in nodes or interfaces.',
      );
    });

    it('should cache model instances (return same object)', async () => {
      await ogm.init();
      const first = ogm.model('Book');
      const second = ogm.model('Book');
      expect(first).toBe(second);
    });

    it('should return different instances for different types', async () => {
      await ogm.init();
      const bookModel = ogm.model('Book');
      const userModel = ogm.model('User');
      expect(bookModel).not.toBe(userModel);
    });
  });

  describe('interfaceModel()', () => {
    it('should work without calling init() (schema parsed in constructor)', () => {
      const entityModel = ogm.interfaceModel('Entity');
      expect(entityModel).toBeInstanceOf(InterfaceModel);
    });

    it('should return an InterfaceModel instance for a known interface', async () => {
      await ogm.init();
      const entityModel = ogm.interfaceModel('Entity');
      expect(entityModel).toBeInstanceOf(InterfaceModel);
    });

    it('should throw for unknown interface type', async () => {
      await ogm.init();
      expect(() => ogm.interfaceModel('NonExistent')).toThrow(
        'Unknown interface type: NonExistent',
      );
    });

    it('should cache interface model instances', async () => {
      await ogm.init();
      const first = ogm.interfaceModel('Entity');
      const second = ogm.interfaceModel('Entity');
      expect(first).toBe(second);
    });
  });

  describe('assertIndexesAndConstraints()', () => {
    it('should work without calling init() (schema parsed in constructor)', async () => {
      await expect(
        ogm.assertIndexesAndConstraints({ options: { create: true } }),
      ).resolves.toBeUndefined();
    });

    it('should be a no-op when create is not true', async () => {
      await ogm.init();
      await ogm.assertIndexesAndConstraints();

      expect(mockDriver.session).not.toHaveBeenCalled();
    });

    it('should create fulltext indexes and constraints when create is true', async () => {
      await ogm.init();
      await ogm.assertIndexesAndConstraints({ options: { create: true } });

      const session = (mockDriver.session as jest.Mock).mock.results[0].value;
      const runCalls = session.run.mock.calls;

      // Should have created at least the BookTitleSearch fulltext index
      const fulltextCalls = runCalls.filter((call: unknown[]) =>
        (call[0] as string).includes('FULLTEXT INDEX'),
      );
      expect(fulltextCalls.length).toBeGreaterThanOrEqual(1);
      expect(fulltextCalls[0][0]).toContain('BookTitleSearch');

      // Should have created uniqueness constraints for @unique fields
      const constraintCalls = runCalls.filter((call: unknown[]) =>
        (call[0] as string).includes('CONSTRAINT'),
      );
      expect(constraintCalls.length).toBeGreaterThanOrEqual(1);

      // Session should be closed
      expect(session.close).toHaveBeenCalled();
    });
  });
});
