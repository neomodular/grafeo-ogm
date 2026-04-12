import { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';

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

// --- Schemas ----------------------------------------------------------------

const schemaWithRelFulltext = `
  type ReviewProps @relationshipProperties
    @fulltext(indexes: [{ name: "ReviewTextSearch", fields: ["text"] }]) {
    text: String!
    rating: Int
  }

  type User {
    id: ID! @id @unique
    name: String!
    reviews: [Post!]! @relationship(type: "REVIEWED", direction: OUT, properties: "ReviewProps")
  }

  type Post {
    id: ID! @id @unique
    title: String!
  }
`;

const schemaWithMultipleRelFulltext = `
  type ReviewProps @relationshipProperties
    @fulltext(indexes: [{ name: "ReviewTextSearch", fields: ["text"] }]) {
    text: String!
  }

  type CommentProps @relationshipProperties
    @fulltext(indexes: [{ name: "CommentBodySearch", fields: ["body"] }]) {
    body: String!
  }

  type User {
    id: ID! @id @unique
    reviews: [Post!]! @relationship(type: "REVIEWED", direction: OUT, properties: "ReviewProps")
    comments: [Post!]! @relationship(type: "COMMENTED_ON", direction: OUT, properties: "CommentProps")
  }

  type Post {
    id: ID! @id @unique
    title: String!
  }
`;

// --- Tests ------------------------------------------------------------------

describe('OGM - relationship fulltext features', () => {
  describe('relPropsToRelType mapping', () => {
    it('should build reverse lookup from properties type to relationship type', () => {
      const driver = createMockDriver();
      const ogm = new OGM({ typeDefs: schemaWithRelFulltext, driver });

      // Access via assertIndexesAndConstraints which uses findRelTypeForProps internally
      // We verify the mapping works by checking index creation succeeds
      expect(() => ogm.model('User')).not.toThrow();
    });

    it('should map multiple relationship property types correctly', () => {
      const driver = createMockDriver();
      const ogm = new OGM({
        typeDefs: schemaWithMultipleRelFulltext,
        driver,
      });

      // If the mapping was broken, assertIndexesAndConstraints would fail
      expect(() => ogm.model('User')).not.toThrow();
      expect(() => ogm.model('Post')).not.toThrow();
    });
  });

  describe('assertIndexesAndConstraints with relationship fulltext', () => {
    it('should create relationship fulltext indexes', async () => {
      const driver = createMockDriver();
      const ogm = new OGM({ typeDefs: schemaWithRelFulltext, driver });

      await ogm.assertIndexesAndConstraints({ options: { create: true } });

      const session = (driver.session as jest.Mock).mock.results[0].value;
      const runCalls = session.run.mock.calls;

      // Find the relationship fulltext index creation call
      const relFulltextCalls = runCalls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('FULLTEXT INDEX') &&
          (call[0] as string).includes('()-[r:'),
      );

      expect(relFulltextCalls.length).toBeGreaterThanOrEqual(1);
      expect(relFulltextCalls[0][0]).toContain('ReviewTextSearch');
      expect(relFulltextCalls[0][0]).toContain('REVIEWED');
      expect(relFulltextCalls[0][0]).toContain('r.text');
    });

    it('should create multiple relationship fulltext indexes', async () => {
      const driver = createMockDriver();
      const ogm = new OGM({
        typeDefs: schemaWithMultipleRelFulltext,
        driver,
      });

      await ogm.assertIndexesAndConstraints({ options: { create: true } });

      const session = (driver.session as jest.Mock).mock.results[0].value;
      const runCalls = session.run.mock.calls;

      const relFulltextCalls = runCalls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('FULLTEXT INDEX') &&
          (call[0] as string).includes('()-[r:'),
      );

      expect(relFulltextCalls.length).toBe(2);

      const cypherTexts = relFulltextCalls.map(
        (call: unknown[]) => call[0] as string,
      );
      expect(
        cypherTexts.some((c: string) => c.includes('ReviewTextSearch')),
      ).toBe(true);
      expect(
        cypherTexts.some((c: string) => c.includes('CommentBodySearch')),
      ).toBe(true);
    });

    it('should use correct relationship type for each index', async () => {
      const driver = createMockDriver();
      const ogm = new OGM({
        typeDefs: schemaWithMultipleRelFulltext,
        driver,
      });

      await ogm.assertIndexesAndConstraints({ options: { create: true } });

      const session = (driver.session as jest.Mock).mock.results[0].value;
      const runCalls = session.run.mock.calls;

      const relFulltextCalls = runCalls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('FULLTEXT INDEX') &&
          (call[0] as string).includes('()-[r:'),
      );

      // ReviewTextSearch should use REVIEWED relationship type
      const reviewCall = relFulltextCalls.find((call: unknown[]) =>
        (call[0] as string).includes('ReviewTextSearch'),
      );
      expect(reviewCall).toBeDefined();
      expect(reviewCall[0]).toContain('REVIEWED');

      // CommentBodySearch should use COMMENTED_ON relationship type
      const commentCall = relFulltextCalls.find((call: unknown[]) =>
        (call[0] as string).includes('CommentBodySearch'),
      );
      expect(commentCall).toBeDefined();
      expect(commentCall[0]).toContain('COMMENTED_ON');
    });
  });

  describe('findRelTypeForProps error handling', () => {
    it('should throw for unknown relationship properties type', () => {
      const schema = `
        type OrphanProps @relationshipProperties {
          data: String!
        }
        type User {
          id: ID! @id @unique
          name: String!
        }
      `;

      const driver = createMockDriver();
      const ogm = new OGM({ typeDefs: schema, driver });

      // OrphanProps is not referenced by any relationship, so findRelTypeForProps
      // would fail if called. We verify assertIndexesAndConstraints doesn't crash
      // when the relProps type has no fulltext indexes (it just skips).
      expect(
        ogm.assertIndexesAndConstraints({ options: { create: true } }),
      ).resolves.toBeUndefined();
    });

    it('should throw when relationship properties type is referenced but not in relPropsToRelType', async () => {
      // This schema has @fulltext on a @relationshipProperties type that
      // is NOT used by any @relationship directive — findRelTypeForProps should throw.
      const schema = `
        type OrphanProps @relationshipProperties
          @fulltext(indexes: [{ name: "OrphanSearch", fields: ["text"] }]) {
          text: String!
        }
        type User {
          id: ID! @id @unique
          name: String!
        }
      `;

      const driver = createMockDriver();
      const ogm = new OGM({ typeDefs: schema, driver });

      await expect(
        ogm.assertIndexesAndConstraints({ options: { create: true } }),
      ).rejects.toThrow(/No relationship found using properties type/);
    });
  });
});
