import { CypherAssert } from '../src/testing/cypher-assert';
import { Neo4jRecordFactory } from '../src/testing/neo4j-record-factory';
import { SelectionSetFactory } from '../src/testing/selection-set-factory';
import neo4j from 'neo4j-driver';

// ---------------------------------------------------------------------------
// CypherAssert
// ---------------------------------------------------------------------------
describe('CypherAssert', () => {
  describe('normalize()', () => {
    it('collapses whitespace', () => {
      const input = `MATCH  (n:Book)
        WHERE   n.name = $name
        RETURN   n`;
      const result = CypherAssert.normalize(input);
      expect(result).toBe('MATCH (n:Book) WHERE n.name = $p0 RETURN n');
    });

    it('renames params canonically in order of appearance', () => {
      const input =
        'MATCH (n) WHERE n.id = $nodeId AND n.name = $ft_phrase RETURN n, $nodeId';
      const result = CypherAssert.normalize(input);
      expect(result).toBe(
        'MATCH (n) WHERE n.id = $p0 AND n.name = $p1 RETURN n, $p0',
      );
    });
  });

  describe('assertStructurallyEqual()', () => {
    it('passes for structurally equivalent Cypher', () => {
      const a = 'MATCH (n:Book) WHERE n.id = $param0 RETURN n';
      const b = `MATCH  (n:Book)
        WHERE n.id = $bookId
        RETURN n`;
      expect(() => CypherAssert.assertStructurallyEqual(a, b)).not.toThrow();
    });

    it('throws for different Cypher', () => {
      const a = 'MATCH (n:Book) WHERE n.id = $param0 RETURN n';
      const b = 'MATCH (n:Author) WHERE n.id = $param0 RETURN n';
      expect(() => CypherAssert.assertStructurallyEqual(a, b)).toThrow();
    });

    it('throws with "Cypher mismatch" message when strings differ', () => {
      const a = 'MATCH (n:Book) RETURN n';
      const b = 'MATCH (n:Book) DELETE n';
      expect(() => CypherAssert.assertStructurallyEqual(a, b)).toThrow(
        /Cypher mismatch/,
      );
    });
  });

  describe('assertContainsClause()', () => {
    it('finds pattern in correct clause', () => {
      const cypher = 'MATCH (n:Book) WHERE n.name = $name RETURN n';
      expect(() =>
        CypherAssert.assertContainsClause(cypher, 'WHERE', 'n.name'),
      ).not.toThrow();
    });

    it('throws when pattern not found', () => {
      const cypher = 'MATCH (n:Book) RETURN n';
      expect(() =>
        CypherAssert.assertContainsClause(cypher, 'WHERE', 'n.name'),
      ).toThrow();
    });

    it('throws when clause type not found', () => {
      const cypher = 'MATCH (n:Book) RETURN n';
      expect(() =>
        CypherAssert.assertContainsClause(cypher, 'SET', 'n.name'),
      ).toThrow(/does not contain clause 'SET'/);
    });

    it('throws when clause exists but pattern not found', () => {
      const cypher = 'MATCH (n:Book) WHERE n.id = $id RETURN n';
      expect(() =>
        CypherAssert.assertContainsClause(cypher, 'WHERE', 'n.name'),
      ).toThrow(/does not contain pattern 'n.name'/);
    });
  });

  describe('assertNotContainsClause()', () => {
    it('passes when pattern absent', () => {
      const cypher = 'MATCH (n:Book) RETURN n';
      expect(() =>
        CypherAssert.assertNotContainsClause(cypher, 'WHERE', 'n.name'),
      ).not.toThrow();
    });

    it('throws when pattern IS found', () => {
      const cypher = 'MATCH (n:Book) WHERE n.name = $name RETURN n';
      expect(() =>
        CypherAssert.assertNotContainsClause(cypher, 'WHERE', 'n.name'),
      ).toThrow(/unexpectedly contains pattern 'n.name'/);
    });

    it('uses clauseTypeOrPattern as pattern when only 2 args given', () => {
      const cypher = 'MATCH (n:Book) RETURN n';
      // 2-arg form: pattern = clauseTypeOrPattern
      expect(() =>
        CypherAssert.assertNotContainsClause(cypher, 'DELETE'),
      ).not.toThrow();
    });

    it('throws with 2-arg form when pattern IS found', () => {
      const cypher = 'MATCH (n:Book) DELETE n';
      expect(() =>
        CypherAssert.assertNotContainsClause(cypher, 'DELETE'),
      ).toThrow(/unexpectedly contains pattern 'DELETE'/);
    });
  });

  describe('assertParams()', () => {
    it('validates param subset', () => {
      const actual = { id: '123', name: 'Aspirin', extra: true };
      const expected = { id: '123', name: 'Aspirin' };
      expect(() => CypherAssert.assertParams(actual, expected)).not.toThrow();
    });

    it('throws when param value differs', () => {
      const actual = { id: '123', name: 'Aspirin' };
      const expected = { id: '999' };
      expect(() => CypherAssert.assertParams(actual, expected)).toThrow();
    });

    it('throws with "Missing param key" when key is absent', () => {
      const actual = { id: '123' };
      const expected = { missing: 'value' };
      expect(() => CypherAssert.assertParams(actual, expected)).toThrow(
        /Missing param key 'missing'/,
      );
    });

    it('throws with "mismatch" when value does not match', () => {
      const actual = { id: '123', name: 'Aspirin' };
      const expected = { name: 'Ibuprofen' };
      expect(() => CypherAssert.assertParams(actual, expected)).toThrow(
        /mismatch/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Neo4jRecordFactory
// ---------------------------------------------------------------------------
describe('Neo4jRecordFactory', () => {
  describe('create()', () => {
    it('returns object with get() and toObject()', () => {
      const record = Neo4jRecordFactory.create({
        name: 'Aspirin',
        count: 42,
      });

      expect(record.get('name')).toBe('Aspirin');
      expect(record.get('count')).toBe(42);
      expect(record.toObject()).toEqual({ name: 'Aspirin', count: 42 });
      expect(record.keys).toEqual(['name', 'count']);
    });
  });

  describe('integer()', () => {
    it('returns Neo4j Integer', () => {
      const val = Neo4jRecordFactory.integer(42);
      expect(neo4j.isInt(val)).toBe(true);
      expect(val.toNumber()).toBe(42);
    });
  });

  describe('dateTime()', () => {
    it('returns DateTime-like object with correct fields', () => {
      const dt = Neo4jRecordFactory.dateTime(
        '2024-06-15T10:30:00.000Z',
      ) as Record<string, unknown>;
      expect(dt).toHaveProperty('year', 2024);
      expect(dt).toHaveProperty('month', 6);
      expect(dt).toHaveProperty('day', 15);
      expect(dt).toHaveProperty('hour', 10);
      expect(dt).toHaveProperty('minute', 30);
      expect(dt).toHaveProperty('second', 0);
    });
  });

  describe('node()', () => {
    it('creates a Node with labels and properties', () => {
      const node = Neo4jRecordFactory.node(['Book'], {
        title: 'Aspirin',
      }) as { labels: string[]; properties: Record<string, unknown> };
      expect(node.labels).toEqual(['Book']);
      expect(node.properties).toEqual({ title: 'Aspirin' });
    });
  });
});

// ---------------------------------------------------------------------------
// SelectionSetFactory
// ---------------------------------------------------------------------------
describe('SelectionSetFactory', () => {
  describe('gql()', () => {
    it('handles scalar fields only', () => {
      const result = SelectionSetFactory.gql(['id', 'name']);
      expect(result).toBe('{ id name }');
    });

    it('handles nested fields', () => {
      const result = SelectionSetFactory.gql([
        'id',
        'name',
        { books: ['id', 'title'] },
      ]);
      expect(result).toBe('{ id name books { id title } }');
    });

    it('handles deeply nested fields', () => {
      const result = SelectionSetFactory.gql([
        'id',
        { authors: ['id', { books: ['id', 'title'] }] },
      ]);
      expect(result).toBe('{ id authors { id books { id title } } }');
    });
  });

  describe('select()', () => {
    it('handles scalar fields only', () => {
      const result = SelectionSetFactory.select(['id', 'name']);
      expect(result).toEqual({ id: true, name: true });
    });

    it('handles nested fields', () => {
      const result = SelectionSetFactory.select([
        'id',
        'name',
        { books: ['id', 'title'] },
      ]);
      expect(result).toEqual({
        id: true,
        name: true,
        books: { select: { id: true, title: true } },
      });
    });

    it('matches gql() structure', () => {
      const fields = ['id', { books: ['id', 'title'] }];
      const gqlResult = SelectionSetFactory.gql(fields);
      const selectResult = SelectionSetFactory.select(fields);

      // gql has nested braces, select has nested select objects
      expect(gqlResult).toContain('books { id title }');
      expect(selectResult).toHaveProperty('books.select.id', true);
      expect(selectResult).toHaveProperty('books.select.title', true);
    });
  });
});
