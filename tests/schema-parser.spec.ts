import { parseSchema, pluralize } from '../src/schema/parser';
import type { SchemaMetadata } from '../src/schema/types';

describe('pluralize', () => {
  it('should pluralize standard names', () => {
    expect(pluralize('Author')).toBe('authors');
    expect(pluralize('Book')).toBe('books');
    expect(pluralize('ShelfRow')).toBe('shelfRows');
    expect(pluralize('Edition')).toBe('editions');
    expect(pluralize('Publisher')).toBe('publishers');
    expect(pluralize('Resource')).toBe('resources');
  });

  it('should pluralize names ending in consonant+y to ies', () => {
    expect(pluralize('Category')).toBe('categories');
    expect(pluralize('BookCategory')).toBe('bookCategories');
    expect(pluralize('QuickChapterCategory')).toBe('quickChapterCategories');
    expect(pluralize('Facility')).toBe('facilities');
    expect(pluralize('Country')).toBe('countries');
  });

  it('should pluralize names ending in s/ss/sh/ch/x with es', () => {
    expect(pluralize('Status')).toBe('statuses');
    expect(pluralize('Class')).toBe('classes');
  });

  it('should pluralize QuickChapter correctly', () => {
    expect(pluralize('QuickChapter')).toBe('quickChapters');
  });

  it('should pluralize Equipment correctly', () => {
    expect(pluralize('Equipment')).toBe('equipment');
    expect(pluralize('EquipmentPage')).toBe('equipmentPages');
  });

  it('should pluralize ReadinessResource correctly', () => {
    expect(pluralize('ReadinessResource')).toBe('readinessResources');
  });
});

describe('parseSchema - simple types', () => {
  it('should parse a simple type with scalar properties', () => {
    const schema = `
      type SimpleNode {
        id: ID! @id @unique
        name: String!
        description: String
        count: Int
        score: Float!
        active: Boolean!
      }
    `;
    const metadata = parseSchema(schema);

    expect(metadata.nodes.has('SimpleNode')).toBe(true);
    const node = metadata.nodes.get('SimpleNode')!;
    expect(node.typeName).toBe('SimpleNode');
    expect(node.label).toBe('SimpleNode');
    expect(node.labels).toEqual(['SimpleNode']);
    expect(node.pluralName).toBe('simpleNodes');

    const idProp = node.properties.get('id')!;
    expect(idProp.type).toBe('ID');
    expect(idProp.required).toBe(true);
    expect(idProp.isGenerated).toBe(true);
    expect(idProp.isUnique).toBe(true);

    const nameProp = node.properties.get('name')!;
    expect(nameProp.type).toBe('String');
    expect(nameProp.required).toBe(true);
    expect(nameProp.isGenerated).toBe(false);

    const descProp = node.properties.get('description')!;
    expect(descProp.required).toBe(false);

    const countProp = node.properties.get('count')!;
    expect(countProp.type).toBe('Int');
    expect(countProp.required).toBe(false);

    const scoreProp = node.properties.get('score')!;
    expect(scoreProp.type).toBe('Float');
    expect(scoreProp.required).toBe(true);

    const activeProp = node.properties.get('active')!;
    expect(activeProp.type).toBe('Boolean');
    expect(activeProp.required).toBe(true);
  });

  it('should parse @node labels directive', () => {
    const schema = `
      type User @node(labels: ["Entity", "User"]) {
        id: ID! @id @unique
        name: String!
      }
    `;
    const metadata = parseSchema(schema);
    const node = metadata.nodes.get('User')!;
    expect(node.labels).toEqual(['Entity', 'User']);
    expect(node.label).toBe('User');
  });

  it('should use typeName as label when @node is not present', () => {
    const schema = `
      type Category {
        id: ID! @id @unique
        name: String!
      }
    `;
    const metadata = parseSchema(schema);
    const node = metadata.nodes.get('Category')!;
    expect(node.labels).toEqual(['Category']);
    expect(node.label).toBe('Category');
  });
});

describe('parseSchema - relationships', () => {
  it('should parse @relationship with direction and type', () => {
    const schema = `
      type Book {
        id: ID! @id @unique
        writtenByAuthors: [Author!]!
          @relationship(type: "WRITTEN_BY_AUTHOR", direction: OUT)
      }
      type Author {
        id: ID! @id @unique
      }
    `;
    const metadata = parseSchema(schema);
    const book = metadata.nodes.get('Book')!;
    const rel = book.relationships.get('writtenByAuthors')!;

    expect(rel.fieldName).toBe('writtenByAuthors');
    expect(rel.type).toBe('WRITTEN_BY_AUTHOR');
    expect(rel.direction).toBe('OUT');
    expect(rel.target).toBe('Author');
    expect(rel.isArray).toBe(true);
    expect(rel.isRequired).toBe(true);
    expect(rel.properties).toBeUndefined();
  });

  it('should parse @relationship with properties', () => {
    const schema = `
      type AuthorBookProps @relationshipProperties {
        position: Int!
      }
      type Book {
        id: ID! @id @unique
        writtenByAuthors: [Author!]!
          @relationship(
            type: "WRITTEN_BY_AUTHOR"
            properties: "AuthorBookProps"
            direction: OUT
          )
      }
      type Author {
        id: ID! @id @unique
      }
    `;
    const metadata = parseSchema(schema);
    const book = metadata.nodes.get('Book')!;
    const rel = book.relationships.get('writtenByAuthors')!;

    expect(rel.properties).toBe('AuthorBookProps');
    expect(rel.type).toBe('WRITTEN_BY_AUTHOR');

    // AuthorBookProps should be a relationship properties definition
    expect(metadata.relationshipProperties.has('AuthorBookProps')).toBe(true);
    const props = metadata.relationshipProperties.get('AuthorBookProps')!;
    expect(props.properties.has('position')).toBe(true);
    expect(props.properties.get('position')!.type).toBe('Int');
    expect(props.properties.get('position')!.required).toBe(true);
  });

  it('should parse optional singular relationships', () => {
    const schema = `
      type Book {
        id: ID! @id @unique
        hasStatus: Status @relationship(type: "DRUG_HAS_STATUS", direction: OUT)
      }
      type Status {
        id: ID! @id @unique
      }
    `;
    const metadata = parseSchema(schema);
    const book = metadata.nodes.get('Book')!;
    const rel = book.relationships.get('hasStatus')!;

    expect(rel.isArray).toBe(false);
    expect(rel.isRequired).toBe(false);
    expect(rel.target).toBe('Status');
  });
});

describe('parseSchema - interfaces', () => {
  it('should parse interface and implements', () => {
    const schema = `
      interface Entity {
        id: ID!
        name: String!
        resources: [Resource!]! @declareRelationship
      }
      type User implements Entity @node(labels: ["Entity", "User"]) {
        id: ID! @id @unique
        name: String!
        resources: [Resource!]! @relationship(type: "HAS_RESOURCE", direction: OUT)
      }
      type Organization implements Entity @node(labels: ["Entity", "Organization"]) {
        id: ID! @id @unique
        name: String!
        resources: [Resource!]! @relationship(type: "HAS_RESOURCE", direction: OUT)
      }
      type Resource {
        id: ID! @id @unique
      }
    `;
    const metadata = parseSchema(schema);

    expect(metadata.interfaces.has('Entity')).toBe(true);
    const iface = metadata.interfaces.get('Entity')!;
    expect(iface.name).toBe('Entity');
    expect(iface.label).toBe('Entity');
    expect(iface.properties.has('id')).toBe(true);
    expect(iface.properties.has('name')).toBe(true);
    // @declareRelationship fields should create relationships on the interface
    expect(iface.relationships.size).toBe(1);
    expect(iface.relationships.has('resources')).toBe(true);
    const rel = iface.relationships.get('resources')!;
    expect(rel.target).toBe('Resource');
    expect(rel.isArray).toBe(true);
    expect(iface.implementedBy).toContain('User');
    expect(iface.implementedBy).toContain('Organization');

    const user = metadata.nodes.get('User')!;
    expect(user.implementsInterfaces).toContain('Entity');
    expect(user.relationships.has('resources')).toBe(true);
  });
});

describe('parseSchema - fulltext indexes', () => {
  it('should parse @fulltext indexes', () => {
    const schema = `
      type Book
        @node(labels: ["Book"])
        @fulltext(indexes: [{ name: "BookTitleSearch", fields: ["title"] }]) {
        id: ID! @id @unique
        title: String!
      }
    `;
    const metadata = parseSchema(schema);
    const book = metadata.nodes.get('Book')!;
    expect(book.fulltextIndexes).toHaveLength(1);
    expect(book.fulltextIndexes[0].name).toBe('BookTitleSearch');
    expect(book.fulltextIndexes[0].fields).toEqual(['title']);
  });

  it('should parse @fulltext with multiple fields', () => {
    const schema = `
      type Author
        @fulltext(indexes: [{ name: "IndicationsFullSearch", fields: ["indicationPlainText", "otherIndicationPlainText", "name"] }]) {
        id: ID! @id @unique
        indicationPlainText: String!
        otherIndicationPlainText: String
        name: String
      }
    `;
    const metadata = parseSchema(schema);
    const author = metadata.nodes.get('Author')!;
    expect(author.fulltextIndexes[0].fields).toEqual([
      'indicationPlainText',
      'otherIndicationPlainText',
      'name',
    ]);
  });
});

describe('parseSchema - @vector directive', () => {
  it('should parse a single vector index with required fields only', () => {
    const schema = `
      type Article
        @node(labels: ["Article"])
        @vector(indexes: [{
          indexName: "article_content_idx"
          queryName: "similarArticles"
          embeddingProperty: "embedding"
        }]) {
        id: ID! @id @unique
        title: String!
        embedding: [Float!]!
      }
    `;
    const metadata = parseSchema(schema);
    const article = metadata.nodes.get('Article')!;
    expect(article.vectorIndexes).toHaveLength(1);
    const idx = article.vectorIndexes![0];
    expect(idx.indexName).toBe('article_content_idx');
    expect(idx.queryName).toBe('similarArticles');
    expect(idx.embeddingProperty).toBe('embedding');
    expect(idx.provider).toBeUndefined();
  });

  it('should parse a vector index with provider set', () => {
    const schema = `
      type Article
        @vector(indexes: [{
          indexName: "article_content_idx"
          queryName: "similarArticles"
          embeddingProperty: "embedding"
          provider: "OpenAI"
        }]) {
        id: ID! @id @unique
        embedding: [Float!]!
      }
    `;
    const metadata = parseSchema(schema);
    const article = metadata.nodes.get('Article')!;
    expect(article.vectorIndexes).toHaveLength(1);
    expect(article.vectorIndexes![0].provider).toBe('OpenAI');
  });

  it('should parse multiple vector indexes on the same type', () => {
    const schema = `
      type Article
        @vector(indexes: [
          {
            indexName: "article_content_idx"
            queryName: "similarArticles"
            embeddingProperty: "contentEmbedding"
          },
          {
            indexName: "article_title_idx"
            queryName: "similarTitles"
            embeddingProperty: "titleEmbedding"
            provider: "VoyageAI"
          }
        ]) {
        id: ID! @id @unique
        contentEmbedding: [Float!]!
        titleEmbedding: [Float!]!
      }
    `;
    const metadata = parseSchema(schema);
    const article = metadata.nodes.get('Article')!;
    expect(article.vectorIndexes).toHaveLength(2);
    expect(article.vectorIndexes![0].indexName).toBe('article_content_idx');
    expect(article.vectorIndexes![0].embeddingProperty).toBe(
      'contentEmbedding',
    );
    expect(article.vectorIndexes![0].provider).toBeUndefined();
    expect(article.vectorIndexes![1].indexName).toBe('article_title_idx');
    expect(article.vectorIndexes![1].embeddingProperty).toBe('titleEmbedding');
    expect(article.vectorIndexes![1].provider).toBe('VoyageAI');
  });

  it('should throw descriptive OGMError when embeddingProperty is unknown', () => {
    const schema = `
      type Article
        @vector(indexes: [{
          indexName: "article_content_idx"
          queryName: "similarArticles"
          embeddingProperty: "missingEmbedding"
        }]) {
        id: ID! @id @unique
        embedding: [Float!]!
      }
    `;
    expect(() => parseSchema(schema)).toThrow(
      /@vector index "article_content_idx" references unknown embeddingProperty "missingEmbedding" on type "Article"/,
    );
  });

  it('should skip index entries missing required indexName', () => {
    const schema = `
      type Article
        @vector(indexes: [{
          queryName: "similarArticles"
          embeddingProperty: "embedding"
        }]) {
        id: ID! @id @unique
        embedding: [Float!]!
      }
    `;
    const metadata = parseSchema(schema);
    const article = metadata.nodes.get('Article')!;
    expect(article.vectorIndexes).toHaveLength(0);
  });

  it('should skip index entries missing required queryName', () => {
    const schema = `
      type Article
        @vector(indexes: [{
          indexName: "article_content_idx"
          embeddingProperty: "embedding"
        }]) {
        id: ID! @id @unique
        embedding: [Float!]!
      }
    `;
    const metadata = parseSchema(schema);
    const article = metadata.nodes.get('Article')!;
    expect(article.vectorIndexes).toHaveLength(0);
  });

  it('should skip index entries missing required embeddingProperty', () => {
    const schema = `
      type Article
        @vector(indexes: [{
          indexName: "article_content_idx"
          queryName: "similarArticles"
        }]) {
        id: ID! @id @unique
        embedding: [Float!]!
      }
    `;
    const metadata = parseSchema(schema);
    const article = metadata.nodes.get('Article')!;
    expect(article.vectorIndexes).toHaveLength(0);
  });

  it('should coexist with @fulltext on the same type', () => {
    const schema = `
      type Article
        @node(labels: ["Article"])
        @fulltext(indexes: [{ name: "ArticleTitleSearch", fields: ["title"] }])
        @vector(indexes: [{
          indexName: "article_content_idx"
          queryName: "similarArticles"
          embeddingProperty: "embedding"
        }]) {
        id: ID! @id @unique
        title: String!
        embedding: [Float!]!
      }
    `;
    const metadata = parseSchema(schema);
    const article = metadata.nodes.get('Article')!;
    expect(article.fulltextIndexes).toHaveLength(1);
    expect(article.fulltextIndexes[0].name).toBe('ArticleTitleSearch');
    expect(article.vectorIndexes).toHaveLength(1);
    expect(article.vectorIndexes![0].indexName).toBe('article_content_idx');
  });

  it('should produce an empty array when indexes: [] is supplied', () => {
    const schema = `
      type Article
        @vector(indexes: []) {
        id: ID! @id @unique
        embedding: [Float!]!
      }
    `;
    const metadata = parseSchema(schema);
    const article = metadata.nodes.get('Article')!;
    expect(article.vectorIndexes).toEqual([]);
  });
});

describe('parseSchema - enums', () => {
  it('should parse enum definitions', () => {
    const schema = `
      enum UserOnboardingStep {
        WELCOME
        SUBSCRIPTION
        PAYMENT
        PROFILE
        PENDING_CONFIRMATION
        PENDING_APPROVAL
        APPROVED
        REJECTED
      }
      type User {
        id: ID! @id @unique
        onboardingStep: UserOnboardingStep @default(value: WELCOME)
      }
    `;
    const metadata = parseSchema(schema);
    expect(metadata.enums.has('UserOnboardingStep')).toBe(true);
    const values = metadata.enums.get('UserOnboardingStep')!;
    expect(values).toEqual([
      'WELCOME',
      'SUBSCRIPTION',
      'PAYMENT',
      'PROFILE',
      'PENDING_CONFIRMATION',
      'PENDING_APPROVAL',
      'APPROVED',
      'REJECTED',
    ]);

    const user = metadata.nodes.get('User')!;
    const prop = user.properties.get('onboardingStep')!;
    expect(prop.type).toBe('UserOnboardingStep');
    expect(prop.defaultValue).toBe('WELCOME');
  });
});

describe('parseSchema - @relationshipProperties', () => {
  it('should parse relationship properties types', () => {
    const schema = `
      type SubscriptionProps @relationshipProperties {
        endDate: DateTime!
        createdAt: DateTime
        updatedAt: DateTime
      }
    `;
    const metadata = parseSchema(schema);
    expect(metadata.relationshipProperties.has('SubscriptionProps')).toBe(true);
    const props = metadata.relationshipProperties.get('SubscriptionProps')!;
    expect(props.typeName).toBe('SubscriptionProps');
    expect(props.properties.has('endDate')).toBe(true);
    expect(props.properties.get('endDate')!.required).toBe(true);
    expect(props.properties.has('createdAt')).toBe(true);
    expect(props.properties.get('createdAt')!.required).toBe(false);
  });

  it('should not create node definitions for @relationshipProperties types', () => {
    const schema = `
      type AuthorBookProps @relationshipProperties {
        position: Int!
      }
      type Author {
        id: ID! @id @unique
      }
    `;
    const metadata = parseSchema(schema);
    expect(metadata.nodes.has('AuthorBookProps')).toBe(false);
    expect(metadata.nodes.has('Author')).toBe(true);
    expect(metadata.relationshipProperties.has('AuthorBookProps')).toBe(true);
  });
});

describe('parseSchema - @cypher fields', () => {
  it('should mark @cypher fields as isCypher: true', () => {
    const schema = `
      type Book {
        id: ID! @id @unique
        title: String!
        insensitiveBookName: String!
          @cypher(
            statement: "RETURN LOWER(this.title) AS insensitiveBookName"
            columnName: "insensitiveBookName"
          )
      }
    `;
    const metadata = parseSchema(schema);
    const book = metadata.nodes.get('Book')!;

    const titleProp = book.properties.get('title')!;
    expect(titleProp.isCypher).toBe(false);

    const insensitiveProp = book.properties.get('insensitiveBookName')!;
    expect(insensitiveProp.isCypher).toBe(true);
    expect(insensitiveProp.type).toBe('String');
    expect(insensitiveProp.required).toBe(true);
  });
});

describe('parseSchema - @id and @unique directives', () => {
  it('should parse @id and @unique directives', () => {
    const schema = `
      type Book {
        id: ID! @id @unique
        isbn: String! @unique
        title: String! @unique
        description: String
      }
    `;
    const metadata = parseSchema(schema);
    const book = metadata.nodes.get('Book')!;

    expect(book.properties.get('id')!.isGenerated).toBe(true);
    expect(book.properties.get('id')!.isUnique).toBe(true);

    expect(book.properties.get('isbn')!.isGenerated).toBe(false);
    expect(book.properties.get('isbn')!.isUnique).toBe(true);

    expect(book.properties.get('title')!.isGenerated).toBe(false);
    expect(book.properties.get('title')!.isUnique).toBe(true);

    expect(book.properties.get('description')!.isGenerated).toBe(false);
    expect(book.properties.get('description')!.isUnique).toBe(false);
  });
});

describe('parseSchema - @default directive', () => {
  it('should parse boolean default values', () => {
    const schema = `
      type StripeSubscription {
        id: ID! @id @unique
        cancelAtPeriodEnd: Boolean! @default(value: false)
      }
    `;
    const metadata = parseSchema(schema);
    const node = metadata.nodes.get('StripeSubscription')!;
    expect(node.properties.get('cancelAtPeriodEnd')!.defaultValue).toBe(
      'false',
    );
  });

  it('should parse enum default values', () => {
    const schema = `
      enum UserOnboardingStep {
        WELCOME
        SUBSCRIPTION
      }
      type User {
        id: ID! @id @unique
        onboardingStep: UserOnboardingStep @default(value: WELCOME)
      }
    `;
    const metadata = parseSchema(schema);
    const user = metadata.nodes.get('User')!;
    expect(user.properties.get('onboardingStep')!.defaultValue).toBe('WELCOME');
  });
});

describe('parseSchema - union types', () => {
  it('should skip union types without errors', () => {
    const schema = `
      union ChapterType = RangeChapter | StandardChapter
      type RangeChapter @node(labels: ["ChapterType", "RangeChapter"]) {
        id: ID! @id @unique
        minValue: Float!
      }
      type StandardChapter @node(labels: ["ChapterType", "StandardChapter"]) {
        id: ID! @id @unique
        value: Float!
      }
    `;
    const metadata = parseSchema(schema);
    expect(metadata.nodes.has('RangeChapter')).toBe(true);
    expect(metadata.nodes.has('StandardChapter')).toBe(true);
    // Union types should not appear as nodes
    expect(metadata.nodes.has('ChapterType')).toBe(false);
  });
});

describe('parseSchema - array properties', () => {
  it('should detect array scalar properties', () => {
    const schema = `
      type EditionlessChapter {
        id: ID! @id @unique
        tags: [String]!
      }
    `;
    const metadata = parseSchema(schema);
    const node = metadata.nodes.get('EditionlessChapter')!;
    const tagsProp = node.properties.get('tags')!;
    expect(tagsProp.isArray).toBe(true);
    expect(tagsProp.type).toBe('String');
    expect(tagsProp.required).toBe(true);
  });

  it('should set isListItemRequired to true for [String!]!', () => {
    const schema = `
      type TestNode {
        id: ID! @id @unique
        requiredItems: [String!]!
      }
    `;
    const metadata = parseSchema(schema);
    const node = metadata.nodes.get('TestNode')!;
    const prop = node.properties.get('requiredItems')!;
    expect(prop.isArray).toBe(true);
    expect(prop.isListItemRequired).toBe(true);
    expect(prop.required).toBe(true);
  });

  it('should set isListItemRequired to false for [String]!', () => {
    const schema = `
      type TestNode {
        id: ID! @id @unique
        nullableItems: [String]!
      }
    `;
    const metadata = parseSchema(schema);
    const node = metadata.nodes.get('TestNode')!;
    const prop = node.properties.get('nullableItems')!;
    expect(prop.isArray).toBe(true);
    expect(prop.isListItemRequired).toBe(false);
    expect(prop.required).toBe(true);
  });

  it('should set isListItemRequired to true for [Int!]', () => {
    const schema = `
      type TestNode {
        id: ID! @id @unique
        scores: [Int!]
      }
    `;
    const metadata = parseSchema(schema);
    const node = metadata.nodes.get('TestNode')!;
    const prop = node.properties.get('scores')!;
    expect(prop.isArray).toBe(true);
    expect(prop.isListItemRequired).toBe(true);
    expect(prop.required).toBe(false);
  });

  it('should set isListItemRequired to false for non-array fields', () => {
    const schema = `
      type TestNode {
        id: ID! @id @unique
        name: String!
      }
    `;
    const metadata = parseSchema(schema);
    const node = metadata.nodes.get('TestNode')!;
    const prop = node.properties.get('name')!;
    expect(prop.isArray).toBe(false);
    expect(prop.isListItemRequired).toBe(false);
  });
});

describe('parseSchema - directives array', () => {
  it('should collect all directive names on a field', () => {
    const schema = `
      type TestNode {
        id: ID! @id @unique
        name: String!
        description: String
      }
    `;
    const metadata = parseSchema(schema);
    const node = metadata.nodes.get('TestNode')!;

    const idProp = node.properties.get('id')!;
    expect(idProp.directives).toEqual(['id', 'unique']);

    const nameProp = node.properties.get('name')!;
    expect(nameProp.directives).toEqual([]);

    const descProp = node.properties.get('description')!;
    expect(descProp.directives).toEqual([]);
  });

  it('should include @cypher in directives', () => {
    const schema = `
      type Book {
        id: ID! @id @unique
        title: String!
        computed: String!
          @cypher(
            statement: "RETURN 'hello'"
            columnName: "computed"
          )
      }
    `;
    const metadata = parseSchema(schema);
    const book = metadata.nodes.get('Book')!;

    expect(book.properties.get('computed')!.directives).toEqual(['cypher']);
    expect(book.properties.get('title')!.directives).toEqual([]);
  });

  it('should include @default in directives', () => {
    const schema = `
      enum Status { ACTIVE INACTIVE }
      type TestNode {
        id: ID! @id @unique
        status: Status @default(value: ACTIVE)
      }
    `;
    const metadata = parseSchema(schema);
    const node = metadata.nodes.get('TestNode')!;
    const prop = node.properties.get('status')!;
    expect(prop.directives).toEqual(['default']);
  });
});

// ---------------------------------------------------------------------------
// Edge case schemas
// ---------------------------------------------------------------------------

describe('parseSchema edge cases', () => {
  it('should parse schema with @default Int value', () => {
    const schema = parseSchema(`
      type Book @node {
        id: ID! @id
        priority: Int @default(value: 5)
      }
    `);
    const book = schema.nodes.get('Book')!;
    expect(book.properties.get('priority')).toBeDefined();
  });

  it('should parse schema with @default Float value', () => {
    const schema = parseSchema(`
      type Book @node {
        id: ID! @id
        score: Float @default(value: 3.14)
      }
    `);
    const book = schema.nodes.get('Book')!;
    expect(book.properties.get('score')).toBeDefined();
  });

  it('should skip malformed @relationship directive with missing type', () => {
    const schema = parseSchema(`
      type Book @node {
        id: ID! @id
        name: String
      }
      type Status @node {
        id: ID! @id
        label: String
      }
    `);
    const book = schema.nodes.get('Book')!;
    expect(book.relationships.size).toBe(0);
  });

  it('should skip @relationship directive missing type/direction args', () => {
    // @relationship has only a "properties" arg but no "type" or "direction"
    const schema = parseSchema(`
      type Book @node {
        id: ID! @id
        hasStatus: [Status!]! @relationship(properties: "BookStatusProps")
      }
      type Status @node {
        id: ID! @id
      }
    `);
    const book = schema.nodes.get('Book')!;
    // Should skip the malformed relationship and treat it as nothing
    expect(book.relationships.size).toBe(0);
  });
});
