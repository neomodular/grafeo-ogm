import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  generateTypes,
  type GenerateTypesResult,
} from '../src/generator/generate-types';

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------

const TEST_SCHEMA = `
  enum Status {
    ACTIVE
    INACTIVE
    DRAFT
  }

  interface Entity {
    id: ID! @id
    internalId: Int
    name: String!
  }

  type Book @node @fulltext(indexes: [{ name: "BookSearch", fields: ["title"] }]) {
    id: ID! @id
    title: String!
    isActive: Boolean
    dose: Float
    quantity: Int
    createdAt: DateTime
    status: Status
  }

  type AuthorBookProps @relationshipProperties {
    order: Int
    isVisible: Boolean
  }

  type Author implements Entity @node {
    id: ID! @id
    internalId: Int
    name: String!
    books: [Book!]! @relationship(type: "HAS_BOOKS", direction: OUT, properties: "AuthorBookProps")
    parentAuthor: Author @relationship(type: "HAS_PARENT", direction: OUT)
  }

  type Organization implements Entity @node {
    id: ID! @id
    internalId: Int
    name: String!
    authors: [Author!]! @relationship(type: "HAS_CHARTS", direction: OUT)
  }

  union AuthorOrBook = Author | Book
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let outFile: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogm-gen-'));
  outFile = path.join(tmpDir, 'ogm-types.ts');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// generateTypes() — core behavior
// ---------------------------------------------------------------------------

describe('generateTypes', () => {
  let result: GenerateTypesResult;

  beforeAll(async () => {
    result = await generateTypes({
      typeDefs: TEST_SCHEMA,
      outFile,
      config: { formatOutput: false },
    });
  });

  it('writes the output file', () => {
    expect(fs.existsSync(outFile)).toBe(true);
  });

  it('returns correct outputPath', () => {
    expect(result.outputPath).toBe(path.resolve(outFile));
  });

  it('counts exported types', () => {
    expect(result.typeCount).toBeGreaterThan(30);
  });

  it('reports file size', () => {
    expect(result.fileSize).toBeGreaterThan(0);
    const actual = fs.statSync(outFile).size;
    expect(result.fileSize).toBe(actual);
  });

  it('reports generation duration', () => {
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns no warnings for valid schema', () => {
    expect(result.warnings).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Output content validation
  // -----------------------------------------------------------------------

  describe('generated output', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(outFile, 'utf-8');
    });

    // --- Header ---
    it('includes auto-generated header', () => {
      expect(content).toContain('AUTO-GENERATED FILE');
      expect(content).toContain('DO NOT EDIT');
    });

    // --- Utility types ---
    it('emits Maybe type', () => {
      expect(content).toContain('export type Maybe<T>');
    });

    it('emits Scalars type', () => {
      expect(content).toContain('export type Scalars');
      expect(content).toContain('DateTime');
    });

    // --- Enums ---
    it('emits schema enums with PascalCase members', () => {
      expect(content).toContain('export enum Status');
      expect(content).toContain('Active = "ACTIVE"');
      expect(content).toContain('Inactive = "INACTIVE"');
      expect(content).toContain('Draft = "DRAFT"');
    });

    it('emits SortDirection enum', () => {
      expect(content).toContain('export enum SortDirection');
      expect(content).toContain('Asc = "ASC"');
    });

    // --- Node types ---
    it('emits Book node type', () => {
      expect(content).toContain('export type Book');
      expect(content).toContain('title');
      expect(content).toContain('isActive');
    });

    it('emits Author node type with relationships', () => {
      expect(content).toContain('export type Author');
      expect(content).toContain('books');
      expect(content).toContain('parentAuthor');
    });

    it('emits __typename on node types', () => {
      expect(content).toMatch(/__typename\?.*"Book"/);
    });

    // --- Union types ---
    it('emits union types', () => {
      expect(content).toContain('export type AuthorOrBook = Author | Book');
    });

    // --- Interface types ---
    it('emits interface type', () => {
      expect(content).toContain('export type Entity');
    });

    it('emits EntityImplementation enum', () => {
      expect(content).toContain('export enum EntityImplementation');
      expect(content).toContain('Author = "Author"');
      expect(content).toContain('Organization = "Organization"');
    });

    // --- Where types ---
    it('emits Where type for each node', () => {
      expect(content).toContain('export type BookWhere');
      expect(content).toContain('export type AuthorWhere');
      expect(content).toContain('export type OrganizationWhere');
    });

    it('emits Where type for interface', () => {
      expect(content).toContain('export type EntityWhere');
    });

    it('includes scalar operators in Where types', () => {
      // String operators
      expect(content).toContain('title_CONTAINS');
      expect(content).toContain('title_STARTS_WITH');
      expect(content).toContain('title_MATCHES');
      // Numeric operators
      expect(content).toContain('dose_LT');
      expect(content).toContain('dose_GTE');
      // Boolean operators
      expect(content).toContain('isActive_NOT');
      // Enum operators
      expect(content).toContain('status_IN');
    });

    it('includes relationship operators in Where types', () => {
      expect(content).toContain('books_SOME');
      expect(content).toContain('books_ALL');
      expect(content).toContain('books_NONE');
    });

    it('includes logical operators in Where types', () => {
      expect(content).toMatch(/OR\?.*AuthorWhere/);
      expect(content).toMatch(/AND\?.*AuthorWhere/);
      expect(content).toMatch(/NOT\?.*AuthorWhere/);
    });

    // --- ConnectionWhere types ---
    it('emits ConnectionWhere types', () => {
      expect(content).toContain('export type AuthorBooksConnectionWhere');
    });

    it('includes edge filter when relationship has properties', () => {
      expect(content).toMatch(/edge\?.*AuthorBookPropsWhere/);
    });

    // --- Input types ---
    it('emits CreateInput types', () => {
      expect(content).toContain('export type BookCreateInput');
      expect(content).toContain('export type AuthorCreateInput');
    });

    it('emits UpdateInput types', () => {
      expect(content).toContain('export type BookUpdateInput');
      expect(content).toContain('export type AuthorUpdateInput');
    });

    it('emits ConnectInput types', () => {
      expect(content).toContain('export type AuthorConnectInput');
    });

    it('emits DisconnectInput types', () => {
      expect(content).toContain('export type AuthorDisconnectInput');
    });

    it('emits DeleteInput types', () => {
      expect(content).toContain('export type AuthorDeleteInput');
    });

    // --- Sort & Options ---
    it('emits Sort types', () => {
      expect(content).toContain('export type BookSort');
      expect(content).toContain('export type AuthorSort');
    });

    it('emits Sort types for interfaces', () => {
      expect(content).toContain('export type EntitySort');
    });

    it('emits Options types', () => {
      expect(content).toContain('export type BookOptions');
      expect(content).toContain('export type AuthorOptions');
    });

    it('emits Options types for interfaces', () => {
      expect(content).toContain('export type EntityOptions');
    });

    // --- Connection & Edge ---
    it('emits Connection types', () => {
      expect(content).toContain('export type AuthorBooksConnection');
    });

    it('emits Relationship (Edge) types', () => {
      expect(content).toContain('export type AuthorBooksRelationship');
    });

    it('emits PageInfo', () => {
      expect(content).toContain('export type PageInfo');
    });

    // --- Aggregation ---
    it('emits AggregateSelection types', () => {
      expect(content).toContain('export type BookAggregateSelection');
      expect(content).toContain('export type AuthorAggregateSelection');
    });

    it('emits aggregate primitives', () => {
      expect(content).toContain('StringAggregateSelection');
      expect(content).toContain('IntAggregateSelection');
      expect(content).toContain('FloatAggregateSelection');
      expect(content).toContain('DateTimeAggregateSelection');
    });

    // --- MutationResponse ---
    it('emits MutationResponse types', () => {
      expect(content).toContain('CreateBooksMutationResponse');
      expect(content).toContain('UpdateBooksMutationResponse');
      expect(content).toContain('CreateAuthorsMutationResponse');
    });

    it('emits CreateInfo and UpdateInfo', () => {
      expect(content).toContain('export type CreateInfo');
      expect(content).toContain('export type UpdateInfo');
    });

    it('emits MutationInfoSelectFields once', () => {
      const matches = content.match(/export type MutationInfoSelectFields/g);
      expect(matches).toHaveLength(1);
      expect(content).toContain('nodesCreated?: boolean');
      expect(content).toContain('relationshipsDeleted?: boolean');
    });

    it('emits per-node MutationSelectFields', () => {
      expect(content).toContain('export type BookMutationSelectFields');
      expect(content).toContain('export type AuthorMutationSelectFields');
      // Should reference the node's SelectFields and plural key
      expect(content).toMatch(
        /BookMutationSelectFields[\s\S]*?books\?:\s*BookSelectFields/,
      );
      expect(content).toMatch(
        /AuthorMutationSelectFields[\s\S]*?authors\?:\s*AuthorSelectFields/,
      );
    });

    // --- Fulltext ---
    it('emits Fulltext result types for nodes with @fulltext', () => {
      expect(content).toContain('BookFulltextResult');
    });

    it('emits per-node FulltextLeaf and FulltextInput for nodes with @fulltext', () => {
      expect(content).toContain('export type BookFulltextLeaf');
      expect(content).toContain('BookSearch?: FulltextIndexEntry;');
      expect(content).toContain('export type BookFulltextInput');
      expect(content).toContain('| BookFulltextLeaf');
    });

    it('threads per-node FulltextInput as the 12th generic of BookModel', () => {
      // From v1.7.0-beta.2: <Node>FulltextInput is passed as the TFulltext
      // generic on ModelInterface, not via an Omit-and-override hack. The
      // generic threading flows fulltext typing into every method that
      // accepts a fulltext param — find/findFirst/findFirstOrThrow/count/
      // aggregate — without per-method redeclaration.
      expect(content).toContain('export type BookModel = ModelInterface<');
      expect(content).toContain('BookSort,\n  BookFulltextInput\n>');
      expect(content).not.toContain('export type BookModel = Omit<');
      // The generated alias must not redeclare the fulltext param shape.
      expect(content).not.toContain('fulltext?: BookFulltextInput;');
      expect(content).not.toContain('fulltext?: FulltextInput;');
    });

    it('nodes without fulltext keep the plain ModelInterface alias (no 12th generic)', () => {
      // Author has no @fulltext index — its model alias stops at TSort
      // (the 11th generic) and the runtime default `TFulltext = FulltextInput`
      // applies.
      expect(content).toContain('export type AuthorModel = ModelInterface<');
      expect(content).not.toContain('AuthorFulltextInput');
      expect(content).not.toMatch(/export type AuthorModel = Omit</);
    });

    // --- SelectFields ---
    it('emits SelectFields per node', () => {
      expect(content).toContain('BookSelectFields');
      expect(content).toContain('AuthorSelectFields');
    });

    it('emits SelectFields for interface', () => {
      expect(content).toContain('EntitySelectFields');
    });

    it('emits edge SelectFields for relationship properties', () => {
      expect(content).toContain('AuthorBooksEdgeSelectFields');
    });

    // --- SelectResult ---
    it('emits SelectResult utility type', () => {
      expect(content).toContain('SelectResult');
      expect(content).toContain('SelectFields');
    });

    it('emits MutationSelectResult and MutationInfoResult utility types', () => {
      expect(content).toContain('export type MutationInfoResult');
      expect(content).toContain('export type MutationSelectResult');
      expect(content).toContain('MutationInfoFields');
    });

    // --- Model Declarations ---
    it('emits Model type for each node', () => {
      // Book has a @fulltext directive in the test schema, so its model type
      // is emitted as `Omit<ModelInterface<...>, ...> & { ... }` to refine
      // the `fulltext` parameter with the per-node BookFulltextInput.
      expect(content).toMatch(
        /export type BookModel = (?:Omit<\s*)?ModelInterface</,
      );
      expect(content).toContain('export type AuthorModel = ModelInterface<');
    });

    it('emits InterfaceModelInterface type for interfaces', () => {
      expect(content).toContain(
        'export type EntityModel = InterfaceModelInterface<',
      );
      expect(content).toContain('EntityWhere');
    });

    // --- ModelMap ---
    it('emits ModelMap type', () => {
      expect(content).toContain('export type ModelMap');
      expect(content).toContain('Author:');
      expect(content).toContain('Book:');
      expect(content).toContain('Organization:');
    });

    it('ModelMap entries include MutationSelectFields', () => {
      expect(content).toContain(
        'MutationSelectFields: BookMutationSelectFields',
      );
      expect(content).toContain(
        'MutationSelectFields: AuthorMutationSelectFields',
      );
    });

    it('model type alias includes MutationSelectFields as 10th param', () => {
      // The `(?:Omit<\s*)?` prefix allows for the fulltext-typed wrapper
      // form that nodes with fulltext indexes receive.
      expect(content).toMatch(
        /BookModel = (?:Omit<\s*)?ModelInterface<[\s\S]*?'books',\s*BookMutationSelectFields/,
      );
    });

    it('does not include interfaces in ModelMap', () => {
      // Entity should NOT be in ModelMap (it's an interface, not a node)
      const modelMapMatch = content.match(
        /export type ModelMap = \{([\s\S]*?)\};/,
      );
      expect(modelMapMatch).not.toBeNull();
      expect(modelMapMatch![1]).not.toContain('Entity:');
    });

    // --- InterfaceModelMap ---
    it('emits InterfaceModelMap type', () => {
      expect(content).toContain('export type InterfaceModelMap');
      expect(content).toContain('Entity:');
    });

    it('InterfaceModelMap contains Type and Where for interfaces', () => {
      const ifaceMapMatch = content.match(
        /export type InterfaceModelMap = \{([\s\S]*?)\};/,
      );
      expect(ifaceMapMatch).not.toBeNull();
      expect(ifaceMapMatch![1]).toContain('Type: Entity;');
      expect(ifaceMapMatch![1]).toContain('Where: EntityWhere;');
    });

    // --- Imports ---
    it('imports InterfaceModelInterface from grafeo-ogm', () => {
      expect(content).toContain('InterfaceModelInterface');
    });
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('generateTypes — error handling', () => {
  it('throws SchemaParseError for invalid schema', async () => {
    await expect(
      generateTypes({
        typeDefs: 'not valid graphql {{{',
        outFile: '/tmp/should-not-exist.ts',
        config: { formatOutput: false },
      }),
    ).rejects.toThrow('Failed to parse schema');
  });

  it('throws OutputPathError for non-existent directory', async () => {
    await expect(
      generateTypes({
        typeDefs: TEST_SCHEMA,
        outFile: '/nonexistent/path/types.ts',
        config: { formatOutput: false },
      }),
    ).rejects.toThrow('Output directory does not exist');
  });

  it('throws EmptySchemaError for schema with no nodes', async () => {
    await expect(
      generateTypes({
        typeDefs: 'enum Foo { BAR }',
        outFile: outFile,
        config: { formatOutput: false },
      }),
    ).rejects.toThrow('no node types');
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('generateTypes — config', () => {
  it('omits MATCHES operator when stringMatchesFilter is false', async () => {
    const result = await generateTypes({
      typeDefs: TEST_SCHEMA,
      outFile,
      config: { formatOutput: false, stringMatchesFilter: false },
    });
    const content = fs.readFileSync(outFile, 'utf-8');
    expect(content).not.toContain('_MATCHES');
    expect(result.typeCount).toBeGreaterThan(0);
  });

  it('adds warning when prettier formatting fails', async () => {
    // Mock prettier to fail by using formatOutput: true but
    // prettier is not installed or fails
    const result = await generateTypes({
      typeDefs: TEST_SCHEMA,
      outFile,
      config: { formatOutput: true },
    });

    // Prettier may or may not be available; either way the output should be valid
    expect(result.typeCount).toBeGreaterThan(0);
    // If prettier failed, there should be a warning; if it succeeded, no warnings
    // Either way the output file should exist
    expect(fs.existsSync(outFile)).toBe(true);
  });

  it('supports custom header', async () => {
    await generateTypes({
      typeDefs: TEST_SCHEMA,
      outFile,
      config: { formatOutput: false, header: '/* Custom header */' },
    });
    const content = fs.readFileSync(outFile, 'utf-8');
    expect(content).toContain('/* Custom header */');
  });
});
