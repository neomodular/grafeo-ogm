import { CypherAssert } from '../src/testing/cypher-assert';
import { Neo4jRecordFactory } from '../src/testing/neo4j-record-factory';
import { SelectionSetFactory } from '../src/testing/selection-set-factory';
import neo4j from 'neo4j-driver';
import { ResultMapper } from '../src/execution/result-mapper';

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

    // v2.5.0 — whitespace was collapsed everywhere, including inside
    // string literals and backticked names, and `$name` inside a string
    // was renamed as if it were a parameter.
    it('keeps whitespace inside string literals significant (v2.5.0)', () => {
      expect(() =>
        CypherAssert.assertStructurallyEqual(
          "RETURN 'a  b' AS s",
          "RETURN 'a b' AS s",
        ),
      ).toThrow(/Cypher mismatch/);
      expect(() =>
        CypherAssert.assertStructurallyEqual(
          'RETURN "a\n b" AS s',
          'RETURN "a b" AS s',
        ),
      ).toThrow(/Cypher mismatch/);
    });

    it('keeps whitespace inside backticked names significant (v2.5.0)', () => {
      expect(() =>
        CypherAssert.assertStructurallyEqual(
          'MATCH (n:`My  Label`) RETURN n',
          'MATCH (n:`My Label`) RETURN n',
        ),
      ).toThrow(/Cypher mismatch/);
    });

    it('still collapses whitespace around literals (v2.5.0)', () => {
      expect(() =>
        CypherAssert.assertStructurallyEqual(
          "RETURN   'a  b'\n   AS s",
          "RETURN 'a  b' AS s",
        ),
      ).not.toThrow();
    });

    it('does not rename a $ inside a string literal (v2.5.0)', () => {
      expect(CypherAssert.normalize("WHERE n.x = $a AND n.y = '$b'")).toBe(
        "WHERE n.x = $p0 AND n.y = '$b'",
      );
      expect(() =>
        CypherAssert.assertStructurallyEqual(
          "RETURN '$price' AS s",
          "RETURN '$cost' AS s",
        ),
      ).toThrow(/Cypher mismatch/);
    });

    it('handles escaped quotes inside a literal (v2.5.0)', () => {
      expect(CypherAssert.normalize("RETURN 'it\\'s  $x'   ,  $y")).toBe(
        "RETURN 'it\\'s  $x' , $p0",
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

    // v2.5.0 — the clause and the pattern were checked independently, and
    // the clause check was a raw substring.
    describe('scopes the pattern to the clause (v2.5.0)', () => {
      const ok = (cypher: string, clause: string, pattern: string) =>
        expect(() =>
          CypherAssert.assertContainsClause(cypher, clause, pattern),
        ).not.toThrow();
      const notInClause = (cypher: string, clause: string, pattern: string) =>
        expect(() =>
          CypherAssert.assertContainsClause(cypher, clause, pattern),
        ).toThrow(
          new RegExp(`does not contain pattern '.*' within a '${clause}'`),
        );
      const noClause = (cypher: string, clause: string) =>
        expect(() =>
          CypherAssert.assertContainsClause(cypher, clause, 'x'),
        ).toThrow(new RegExp(`does not contain clause '${clause}'`));

      it('rejects a pattern that only appears in a later clause', () => {
        notInClause(
          'MATCH (n) WHERE n.age > $p RETURN n { .name }',
          'WHERE',
          'n { .name }',
        );
        ok('MATCH (n) WHERE n.age > $p RETURN n { .name }', 'RETURN', '.name');
      });

      it('rejects a pattern that only appears in an earlier clause', () => {
        notInClause('MATCH (n:Book) RETURN n', 'RETURN', ':Book');
      });

      it('matches the clause keyword only as a word', () => {
        noClause('MATCH (n) RETURN n SKIP $offset', 'SET');
        noClause('MATCH (n:Asset) RETURN n.reset', 'SET');
        noClause('MATCH (n) RETURN n { set: 1 }', 'SET');
        noClause('MATCH (n) WHERE n.x = $set RETURN n', 'SET');
        noClause("MATCH (n) WHERE n.x = 'SET' RETURN n", 'SET');
        noClause('MATCH (n:`SET`) RETURN n', 'SET');
        noClause('MATCH (n) // SET\nRETURN n', 'SET');
      });

      it('is case-insensitive on the keyword', () => {
        ok('match (n) where n.x = 1 return n', 'WHERE', 'n.x = 1');
      });

      it('does not end a WHERE at STARTS WITH / ENDS WITH', () => {
        ok(
          'MATCH (n) WHERE n.a STARTS WITH $p AND n.b ENDS WITH $q RETURN n',
          'WHERE',
          'n.b ENDS WITH',
        );
        noClause('MATCH (n) WHERE n.a STARTS WITH $p RETURN n', 'WITH');
      });

      it('passes when any occurrence of the clause holds the pattern', () => {
        ok(
          'MATCH (a) WITH a MATCH (b:Book) WHERE b.x = a.x RETURN b',
          'MATCH',
          ':Book',
        );
      });

      it('handles multi-word clauses', () => {
        ok(
          'MATCH (n) RETURN n ORDER BY n.name DESC SKIP 0',
          'ORDER BY',
          'n.name DESC',
        );
        notInClause(
          'MATCH (n) RETURN n ORDER BY n.name SKIP 5',
          'ORDER BY',
          '5',
        );
        ok('MATCH (n) DETACH DELETE n', 'DELETE', 'n');
        ok(
          'MERGE (n {id: $id}) ON CREATE SET n.c = 1 ON MATCH SET n.m = 2',
          'ON MATCH SET',
          'n.m = 2',
        );
        notInClause(
          'MERGE (n {id: $id}) ON CREATE SET n.c = 1 ON MATCH SET n.m = 2',
          'ON CREATE SET',
          'n.m',
        );
      });

      it('finds clauses nested in brackets, bounded by the bracket', () => {
        const cypher =
          'MATCH (n) RETURN n { .id, books: [(n)-[:W]->(b) WHERE b.year > 2000 | b { .title }] }';
        ok(cypher, 'WHERE', 'b.year > 2000');
        notInClause(cypher, 'WHERE', '.title');
        // A nested WHERE does not cut the enclosing RETURN short.
        ok(cypher, 'RETURN', 'b { .title }');

        const sub =
          'MATCH (n) CALL { WITH n MATCH (n)-->(m) RETURN count(m) AS c } RETURN n, c';
        ok(sub, 'MATCH', '(n)-->(m)');
        notInClause(sub, 'MATCH', 'count(m)');
        ok(sub, 'CALL', 'count(m) AS c');
      });

      // v2.5.3 — any top-level `|` ended the clause, so a label expression
      // or `||` concatenation cut a WHERE short.
      it('ends a clause at `|` only for a comprehension body', () => {
        ok('MATCH (n) WHERE n:A|B AND n.x = $p RETURN n', 'WHERE', 'n.x = $p');
        ok(
          "MATCH (n) WHERE n.a || 'x' = $p AND n.y = 1 RETURN n",
          'WHERE',
          'n.y = 1',
        );
        ok('MATCH (n) WHERE n:A|B|C AND n.x = 1 RETURN n', 'WHERE', 'n.x = 1');
        // A comprehension still ends at its `|` — including one whose
        // predicate holds a label expression or a concatenation.
        const comp =
          "RETURN [x IN $l WHERE x:A|B AND x.a || 'y' = 'z' | x.name] AS r";
        ok(comp, 'WHERE', "x.a || 'y' = 'z'");
        notInClause(comp, 'WHERE', 'x.name');
        notInClause(
          'RETURN [(n)-->(m) WHERE m.x = 1 | m.name] AS r',
          'WHERE',
          'm.name',
        );
      });
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

    // v2.5.0 — the comparison was JSON.stringify(a) === JSON.stringify(b),
    // which is key-order sensitive and throws a raw TypeError on bigint.
    it('ignores object key order, at any depth (v2.5.0)', () => {
      expect(() =>
        CypherAssert.assertParams(
          { p: { x: 1, y: { a: 1, b: 2 } } },
          { p: { y: { b: 2, a: 1 }, x: 1 } },
        ),
      ).not.toThrow();
    });

    it('keeps array order significant (v2.5.0)', () => {
      expect(() =>
        CypherAssert.assertParams({ p: [1, 2] }, { p: [2, 1] }),
      ).toThrow(/mismatch/);
    });

    it('compares bigint values instead of throwing (v2.5.0)', () => {
      expect(() =>
        CypherAssert.assertParams(
          { p: 9007199254740993n },
          { p: 9007199254740993n },
        ),
      ).not.toThrow();
      expect(() => CypherAssert.assertParams({ p: 1n }, { p: 2n })).toThrow(
        /Param 'p' mismatch/,
      );
      // A bigint is not the number with the same digits.
      expect(() => CypherAssert.assertParams({ p: 1n }, { p: 1 })).toThrow(
        /mismatch/,
      );
    });

    it('compares neo4j Integers by value, and not to plain numbers (v2.5.0)', () => {
      expect(() =>
        CypherAssert.assertParams({ p: neo4j.int(5) }, { p: neo4j.int(5) }),
      ).not.toThrow();
      expect(() =>
        CypherAssert.assertParams({ p: neo4j.int(5) }, { p: neo4j.int(6) }),
      ).toThrow(/mismatch/);
      // Int writes bind an Integer so they are not sent as Float — a test
      // asserting a plain number must still catch a missing coercion.
      expect(() =>
        CypherAssert.assertParams({ p: neo4j.int(5) }, { p: 5 }),
      ).toThrow(/mismatch/);
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

    // v2.5.0 — expected values were recorded from `RETURN datetime($iso)`
    // on Neo4j 5.26 (see tests/integration/record-factory.spec.ts). Before
    // v2.5.0 the factory converted to UTC and dropped the offset, so
    // `10:00+02:00` came back as `08:00Z`, and cut nanoseconds to millis.
    it.each([
      ['2024-01-01T10:00:00+02:00', '2024-01-01T10:00:00+02:00', 10, 0, 7200],
      [
        '2024-01-01T10:00:00.123456789Z',
        '2024-01-01T10:00:00.123456789Z',
        10,
        123456789,
        0,
      ],
      [
        '2024-01-01T10:00:00.5-05:30',
        '2024-01-01T10:00:00.500000000-05:30',
        10,
        500000000,
        -19800,
      ],
      ['2024-07-01T10:00:00+0530', '2024-07-01T10:00:00+05:30', 10, 0, 19800],
      ['2024-07-01T10:00:00+05', '2024-07-01T10:00:00+05:00', 10, 0, 18000],
    ])(
      'keeps the offset and nanoseconds of %s (v2.5.0)',
      (iso, str, hour, nanosecond, offset) => {
        const dt = Neo4jRecordFactory.dateTime(iso) as Record<string, unknown>;
        expect(String(dt)).toBe(str);
        expect(dt.hour).toBe(hour);
        expect(dt.nanosecond).toBe(nanosecond);
        expect(dt.timeZoneOffsetSeconds).toBe(offset);
      },
    );

    it('carries a zone id and resolves its offset (v2.5.0)', () => {
      const summer = Neo4jRecordFactory.dateTime(
        '2024-07-01T10:00:00[Europe/Berlin]',
      ) as Record<string, unknown>;
      expect(String(summer)).toBe('2024-07-01T10:00:00+02:00[Europe/Berlin]');
      expect(summer.timeZoneId).toBe('Europe/Berlin');
      expect(summer.timeZoneOffsetSeconds).toBe(7200);

      const winter = Neo4jRecordFactory.dateTime(
        '2024-01-15T10:00:00[Europe/Berlin]',
      ) as Record<string, unknown>;
      expect(winter.timeZoneOffsetSeconds).toBe(3600);
    });

    // v2.5.0 — a string without an offset went through `new Date()`, which
    // reads it as LOCAL time, so the result depended on the machine's zone
    // (10:00 became 15:00Z on a CDT laptop, 10:00Z on UTC CI). Neo4j reads
    // it as UTC (its default zone), and so does the factory now.
    it.each([
      ['2024-07-01T10:00:00', '2024-07-01T10:00:00Z'],
      ['2024-07-01T10:00', '2024-07-01T10:00:00Z'],
      ['2024-07-01T10:00:00.987654321', '2024-07-01T10:00:00.987654321Z'],
      ['2024-07-01', '2024-07-01T00:00:00Z'],
    ])('reads %s as UTC whatever the machine zone (v2.5.0)', (iso, str) => {
      const saved = process.env.TZ;
      try {
        for (const tz of ['America/Chicago', 'Asia/Kolkata', 'UTC']) {
          process.env.TZ = tz;
          expect([tz, String(Neo4jRecordFactory.dateTime(iso))]).toEqual([
            tz,
            str,
          ]);
        }
      } finally {
        if (saved === undefined) delete process.env.TZ;
        else process.env.TZ = saved;
      }
    });

    it('rejects a string that is not an ISO date-time (v2.5.0)', () => {
      expect(() => Neo4jRecordFactory.dateTime('not a date')).toThrow(
        /not an ISO-8601 date-time/,
      );
    });

    it('maps through ResultMapper to the same string as a driver value (v2.4.8)', () => {
      const dt = Neo4jRecordFactory.dateTime('2024-01-01T10:00:00+02:00');
      expect(ResultMapper.convertNeo4jTypes(dt)).toBe(
        '2024-01-01T10:00:00+02:00',
      );
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

    it('keeps the identity 0 / elementId "0" default', () => {
      const node = Neo4jRecordFactory.node(['Book'], {}) as {
        identity: unknown;
        elementId: string;
      };
      expect(neo4j.integer.toNumber(node.identity as number)).toBe(0);
      expect(node.elementId).toBe('0');
    });

    // v2.5.0 — every factory node used to share identity 0 / elementId "0",
    // with no way to give two mock nodes distinct ids.
    it('accepts an identity and elementId (v2.5.0)', () => {
      const node = Neo4jRecordFactory.node(
        ['Book'],
        { count: Neo4jRecordFactory.integer(5) },
        { identity: 22, elementId: '4:db:22' },
      ) as {
        identity: unknown;
        elementId: string;
        properties: Record<string, unknown>;
      };
      expect(neo4j.isInt(node.identity)).toBe(true);
      expect(neo4j.integer.toNumber(node.identity as number)).toBe(22);
      expect(node.elementId).toBe('4:db:22');
      expect(neo4j.isInt(node.properties.count)).toBe(true);
    });

    it('derives elementId from identity when only identity is given (v2.5.0)', () => {
      const node = Neo4jRecordFactory.node(['Book'], {}, { identity: 7 }) as {
        elementId: string;
      };
      expect(node.elementId).toBe('7');
    });

    it('passes property values through unchanged (v2.5.0)', () => {
      // A JS number is not turned into an Integer: 2.0 may be a Float.
      const node = Neo4jRecordFactory.node(['Book'], { n: 5, f: 2.0 }) as {
        properties: Record<string, unknown>;
      };
      expect(node.properties).toEqual({ n: 5, f: 2.0 });
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
