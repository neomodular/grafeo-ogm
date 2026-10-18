import {
  planSchemaSync,
  type LiveSchema,
  type LiveSchemaItem,
} from '../../src/cli/push-planner';
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

/** A live single-property UNIQUENESS constraint, as SHOW CONSTRAINTS reports it. */
function uniq(label: string, prop: string): LiveSchemaItem {
  return {
    name: `${label}_${prop}_unique`,
    type: 'UNIQUENESS',
    labelsOrTypes: [label],
    properties: [prop],
  };
}

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
        {
          name: 'Book_id_unique',
          type: 'UNIQUENESS',
          labelsOrTypes: ['Book'],
          properties: ['id'],
        },
        {
          name: 'Author_id_unique',
          type: 'UNIQUENESS',
          labelsOrTypes: ['Author'],
          properties: ['id'],
        },
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
        uniq('Book', 'id'),
        uniq('Author', 'id'),
        // grafeo-shaped (single-label, single-prop UNIQUENESS on a known
        // label, conventional name), but the SDL no longer declares
        // Author.email as unique → orphan.
        uniq('Author', 'email'),
      ],
      indexes: [{ name: 'BookSearch', type: 'FULLTEXT' }],
    };

    const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), live);
    expect(plan.orphans.map((o) => o.name)).toEqual(['Author_email_unique']);
    expect(plan.orphans[0].dropCypher).toBe(
      'DROP CONSTRAINT Author_email_unique IF EXISTS',
    );
  });

  // v2.4.7 — orphans were attributed by NAME PREFIX only, so --force-drop
  // could drop constraints grafeo never created.
  describe('never treats a constraint it cannot prove is grafeo-owned as an orphan', () => {
    const cases: Array<[string, LiveSchemaItem]> = [
      [
        'a label the schema does not define, sharing a known label prefix',
        uniq('Author_Archive', 'code'),
      ],
      [
        'a conventional name whose definition is on another property',
        { ...uniq('Author', 'email'), properties: ['phone'] },
      ],
      [
        'a NODE KEY constraint with a conventional name',
        { ...uniq('Author', 'email'), type: 'NODE_KEY' },
      ],
      [
        'a composite constraint',
        { ...uniq('Author', 'email'), properties: ['email', 'phone'] },
      ],
      [
        'a row without definition columns (older server)',
        // Deliberately name-only: no labelsOrTypes / properties columns.
        { name: 'Author_email_unique', type: 'UNIQUENESS' },
      ],
    ];
    it.each(cases)('%s', (_label, constraint) => {
      const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), {
        constraints: [uniq('Book', 'id'), uniq('Author', 'id'), constraint],
        indexes: [{ name: 'BookSearch', type: 'FULLTEXT' }],
      });
      expect(plan.orphans).toEqual([]);
      expect(plan.unmanaged).toContain(constraint.name);
    });
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

  // v2.4.8 — every in-sync grafeo constraint also appears in SHOW INDEXES
  // as its backing RANGE index (owningConstraint set). Pre-2.4.8 those rows
  // were listed as "Unmanaged — ignored" on every rerun.
  describe('constraint-backed index rows', () => {
    it('are not reported as unmanaged (owningConstraint set)', () => {
      const live: LiveSchema = {
        constraints: [uniq('Book', 'id'), uniq('Author', 'id')],
        indexes: [
          { name: 'BookSearch', type: 'FULLTEXT' },
          {
            name: 'Book_id_unique',
            type: 'RANGE',
            labelsOrTypes: ['Book'],
            properties: ['id'],
            owningConstraint: 'Book_id_unique',
          },
          {
            name: 'Author_id_unique',
            type: 'RANGE',
            labelsOrTypes: ['Author'],
            properties: ['id'],
            owningConstraint: 'Author_id_unique',
          },
        ],
      };

      const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), live);
      expect(plan.unmanaged).toEqual([]);
      expect(plan.create).toEqual([]);
    });

    it('are not reported when only the name ties them to a live constraint', () => {
      // A server that does not expose `owningConstraint`.
      const live: LiveSchema = {
        constraints: [uniq('Book', 'id'), uniq('Author', 'id')],
        indexes: [
          { name: 'BookSearch', type: 'FULLTEXT' },
          { name: 'Book_id_unique', type: 'RANGE' },
          { name: 'Author_id_unique', type: 'RANGE' },
        ],
      };

      expect(planSchemaSync(parseSchema(BOOK_AUTHOR), live).unmanaged).toEqual(
        [],
      );
    });

    it('still reports a DBA constraint (not its backing index) as unmanaged', () => {
      const live: LiveSchema = {
        constraints: [
          uniq('Book', 'id'),
          uniq('Author', 'id'),
          {
            name: 'dba_title_unique',
            type: 'UNIQUENESS',
            labelsOrTypes: ['Other'],
            properties: ['title'],
          },
        ],
        indexes: [
          { name: 'BookSearch', type: 'FULLTEXT' },
          {
            name: 'dba_title_unique',
            type: 'RANGE',
            owningConstraint: 'dba_title_unique',
          },
        ],
      };

      expect(planSchemaSync(parseSchema(BOOK_AUTHOR), live).unmanaged).toEqual([
        'dba_title_unique',
      ]);
    });
  });

  // v2.4.8 — indexes used to be matched by NAME only, so an index whose
  // definition no longer matched the SDL was reported "in sync" and never
  // applied (`CREATE … IF NOT EXISTS` on an existing name is a no-op).
  describe('changed index definitions', () => {
    const inSyncConstraints = [uniq('Book', 'id'), uniq('Author', 'id')];
    const bookSearch = (
      over: Partial<LiveSchemaItem> = {},
    ): LiveSchemaItem => ({
      name: 'BookSearch',
      type: 'FULLTEXT',
      entityType: 'NODE',
      labelsOrTypes: ['Book'],
      properties: ['title'],
      ...over,
    });

    it('reports a fulltext index whose fields changed', () => {
      const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), {
        constraints: inSyncConstraints,
        indexes: [bookSearch({ properties: ['title', 'body'] })],
      });

      expect(plan.create).toEqual([]);
      expect(plan.inSync.map((s) => s.name)).not.toContain('BookSearch');
      expect(plan.changed).toHaveLength(1);
      expect(plan.changed[0].statement.name).toBe('BookSearch');
      expect(plan.changed[0].dropCypher).toBe(
        'DROP INDEX BookSearch IF EXISTS',
      );
      expect(plan.changed[0].differences.join(' ')).toMatch(/properties/);
    });

    it('reports a fulltext index whose label changed', () => {
      const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), {
        constraints: inSyncConstraints,
        indexes: [bookSearch({ labelsOrTypes: ['Novel'] })],
      });
      expect(plan.changed.map((c) => c.statement.name)).toEqual(['BookSearch']);
    });

    it('ignores fulltext property order', () => {
      const schema = BOOK_AUTHOR.replace(
        'fields: ["title"]',
        'fields: ["title", "body"]',
      ).replace('title: String!', 'title: String!\n  body: String');
      const plan = planSchemaSync(parseSchema(schema), {
        constraints: inSyncConstraints,
        indexes: [bookSearch({ properties: ['body', 'title'] })],
      });
      expect(plan.changed).toEqual([]);
      expect(plan.inSync.map((s) => s.name)).toContain('BookSearch');
    });

    it('keeps a row without definition columns in sync (older servers)', () => {
      const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), {
        constraints: inSyncConstraints,
        indexes: [{ name: 'BookSearch', type: 'FULLTEXT' }],
      });
      expect(plan.changed).toEqual([]);
    });

    it('reports an index whose name is now held by another index type', () => {
      const plan = planSchemaSync(parseSchema(BOOK_AUTHOR), {
        constraints: inSyncConstraints,
        indexes: [bookSearch({ type: 'RANGE' })],
      });
      expect(plan.changed.map((c) => c.statement.name)).toEqual(['BookSearch']);
    });

    const vecLive = (dims: unknown, sim: string): LiveSchema => ({
      constraints: [uniq('Doc', 'id')],
      indexes: [
        {
          name: 'DocEmbedding',
          type: 'VECTOR',
          entityType: 'NODE',
          labelsOrTypes: ['Doc'],
          properties: ['embedding'],
          indexConfig: {
            'vector.dimensions': dims,
            'vector.similarity_function': sim,
          },
        },
      ],
    });

    it('reports a vector index whose dimensions or similarity changed', () => {
      const dims = planSchemaSync(
        parseSchema(DOC_VECTOR),
        vecLive(4, 'COSINE'),
        {
          DocEmbedding: { dimensions: 8 },
        },
      );
      expect(dims.changed.map((c) => c.statement.name)).toEqual([
        'DocEmbedding',
      ]);
      expect(dims.changed[0].differences.join(' ')).toMatch(/dimensions/);

      const sim = planSchemaSync(
        parseSchema(DOC_VECTOR),
        vecLive(8, 'COSINE'),
        {
          DocEmbedding: { dimensions: 8, similarity: 'euclidean' },
        },
      );
      expect(sim.changed[0].differences.join(' ')).toMatch(/similarity/);
    });

    it('treats a matching vector index as in sync (similarity case-insensitive)', () => {
      const plan = planSchemaSync(
        parseSchema(DOC_VECTOR),
        vecLive(8, 'COSINE'),
        {
          DocEmbedding: { dimensions: 8, similarity: 'cosine' },
        },
      );
      expect(plan.changed).toEqual([]);
      expect(plan.inSync.map((s) => s.name)).toContain('DocEmbedding');
    });
  });
});
