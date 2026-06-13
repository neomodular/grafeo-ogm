import { planSchemaSync, type LiveSchema } from '../../src/cli/push-planner';
import { parseSchema } from '../../src/schema/parser';

const EMPTY: LiveSchema = { constraints: [], indexes: [] };

const BOOK_AUTHOR = `
type Book @fulltext(indexes: [{ name: "BookSearch", fields: ["title"] }]) {
  id: ID! @id @unique
  title: String!
}
type Author {
  id: ID! @id @unique
  name: String!
}
`;

const DOC_VECTOR = `
type Doc @vector(indexes: [{ indexName: "DocEmbedding", queryName: "qDoc", embeddingProperty: "embedding" }]) {
  id: ID! @id @unique
  embedding: [Float!]
}
`;

describe('planSchemaSync (cli-db-push spec)', () => {
  it('flags missing unique constraints and fulltext indexes for creation', () => {
    const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), EMPTY);

    const names = plan.create.map((s) => s.name).sort();
    // Lexicographic: 'S' (0x53) sorts before '_' (0x5F), so BookSearch < Book_id_unique.
    expect(names).toEqual(['Author_id_unique', 'BookSearch', 'Book_id_unique']);
    expect(plan.inSync).toHaveLength(0);
    expect(plan.orphans).toHaveLength(0);
    expect(plan.unmanaged).toHaveLength(0);

    const constraint = plan.create.find((s) => s.name === 'Book_id_unique');
    expect(constraint?.cypher).toContain('CREATE CONSTRAINT Book_id_unique');
    const fulltext = plan.create.find((s) => s.name === 'BookSearch');
    expect(fulltext?.cypher).toContain('CREATE FULLTEXT INDEX BookSearch');
  });

  it('reports a vector index as needing config when no dimensions are given', () => {
    const plan = planSchemaSync(parseSchema(DOC_VECTOR), EMPTY);

    expect(plan.create.map((s) => s.name)).toEqual(['Doc_id_unique']);
    expect(plan.needsConfig).toHaveLength(1);
    expect(plan.needsConfig[0]).toMatchObject({
      indexName: 'DocEmbedding',
      typeName: 'Doc',
      embeddingProperty: 'embedding',
    });
  });

  it('creates the vector index once dimensions are supplied', () => {
    const plan = planSchemaSync(parseSchema(DOC_VECTOR), EMPTY, {
      DocEmbedding: { dimensions: 1536 },
    });

    expect(plan.needsConfig).toHaveLength(0);
    const vector = plan.create.find((s) => s.name === 'DocEmbedding');
    expect(vector?.cypher).toContain('CREATE VECTOR INDEX DocEmbedding');
    expect(vector?.cypher).toContain('`vector.dimensions`: 1536');
  });

  it('produces an empty create plan when everything is already in sync', () => {
    const live: LiveSchema = {
      constraints: [
        { name: 'Book_id_unique', type: 'UNIQUENESS' },
        { name: 'Author_id_unique', type: 'UNIQUENESS' },
      ],
      indexes: [{ name: 'BookSearch', type: 'FULLTEXT' }],
    };

    const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), live);
    expect(plan.create).toHaveLength(0);
    expect(plan.inSync).toHaveLength(3);
    expect(plan.orphans).toHaveLength(0);
  });

  it('flags a convention-named constraint missing from the SDL as an orphan', () => {
    const live: LiveSchema = {
      constraints: [
        { name: 'Book_id_unique', type: 'UNIQUENESS' },
        { name: 'Author_id_unique', type: 'UNIQUENESS' },
        // matches {Label}_{prop}_unique for the known label Author, but the
        // SDL no longer declares Author.email as unique → orphan.
        { name: 'Author_email_unique', type: 'UNIQUENESS' },
      ],
      indexes: [{ name: 'BookSearch', type: 'FULLTEXT' }],
    };

    const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), live);
    expect(plan.orphans.map((o) => o.name)).toEqual(['Author_email_unique']);
    expect(plan.orphans[0].dropCypher).toBe(
      'DROP CONSTRAINT Author_email_unique IF EXISTS',
    );
  });

  it('treats non-convention items as unmanaged and ignores LOOKUP indexes', () => {
    const live: LiveSchema = {
      constraints: [{ name: 'dba_custom_constraint', type: 'UNIQUENESS' }],
      indexes: [
        { name: 'dba_range_idx', type: 'RANGE' },
        { name: 'index_343affbe', type: 'LOOKUP' },
      ],
    };

    const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), live);
    // No grafeo-named items → all desired statements still need creating.
    expect(plan.orphans).toHaveLength(0);
    expect(plan.unmanaged.sort()).toEqual([
      'dba_custom_constraint',
      'dba_range_idx',
    ]);
    // LOOKUP is Neo4j system infrastructure — never reported.
    expect(plan.unmanaged).not.toContain('index_343affbe');
  });

  it('never builds a drop for a constraint name carrying unsafe characters', () => {
    // A hostile live constraint whose name matches the {Label}_{prop}_unique
    // SHAPE but smuggles Cypher via a backtick must NOT become a droppable
    // orphan — it is demoted to `unmanaged` so its name never enters Cypher.
    const evil = 'Book`); MATCH (x) DETACH DELETE x; //_id_unique';
    const live: LiveSchema = {
      constraints: [{ name: evil, type: 'UNIQUENESS' }],
      indexes: [],
    };

    const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), live);

    expect(plan.orphans).toHaveLength(0); // never droppable
    expect(plan.unmanaged).toContain(evil); // reported, never executed
  });

  it('deduplicates names that appear in both constraints and indexes', () => {
    const live: LiveSchema = {
      constraints: [{ name: 'shared_artifact', type: 'UNIQUENESS' }],
      indexes: [{ name: 'shared_artifact', type: 'RANGE' }],
    };

    const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), live);
    expect(plan.unmanaged.filter((n) => n === 'shared_artifact')).toHaveLength(
      1,
    );
  });
});
