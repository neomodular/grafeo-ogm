/**
 * 14 - Testing Utilities
 *
 * Demonstrates CypherAssert, Neo4jRecordFactory, and SelectionSetFactory.
 * These utilities help test OGM-generated Cypher without a Neo4j connection.
 * This example does NOT require a running Neo4j instance.
 */

import {
  CypherAssert,
  Neo4jRecordFactory,
  SelectionSetFactory,
} from 'grafeo-ogm/testing';

function main() {
  // =========================================================================
  // CypherAssert — structural comparison of Cypher strings
  // =========================================================================

  // normalize() collapses whitespace and renames params to $p0, $p1, ...
  const normalized = CypherAssert.normalize(`
    MATCH (n:Book)
    WHERE n.title = $param0 AND n.price > $param1
    RETURN n
  `);
  console.log('Normalized:', normalized);
  // => 'MATCH (n:Book) WHERE n.title = $p0 AND n.price > $p1 RETURN n'

  // assertStructurallyEqual() — ignores whitespace and param naming
  CypherAssert.assertStructurallyEqual(
    'MATCH (n:Book) WHERE n.title = $myParam RETURN n',
    'MATCH (n:Book)  WHERE  n.title = $param0  RETURN n',
  );
  console.log('Structural equality: passed');

  // assertContainsClause() — check for a specific clause
  const cypher = 'MATCH (n:Book) WHERE n.price > $param0 RETURN n { .id, .title }';
  CypherAssert.assertContainsClause(cypher, 'WHERE', 'n.price');
  CypherAssert.assertContainsClause(cypher, 'RETURN', '.title');
  console.log('Contains clause: passed');

  // assertNotContainsClause() — ensure something is absent
  CypherAssert.assertNotContainsClause(cypher, 'DELETE');
  console.log('Not contains clause: passed');

  // assertParams() — partial match on parameter values
  CypherAssert.assertParams(
    { param0: 'hello', param1: 42, param2: true },
    { param0: 'hello', param1: 42 }, // only checks these keys
  );
  console.log('Params match: passed');

  // =========================================================================
  // Neo4jRecordFactory — create mock Neo4j records for unit tests
  // =========================================================================

  // Create a mock record with named fields
  const record = Neo4jRecordFactory.create({
    n: { id: '1', title: 'Test Book', price: 9.99 },
  });
  console.log('\nMock record keys:', record.keys);
  console.log('Record field "n":', record.get('n'));

  // Create a Neo4j Integer (for count results, etc.)
  const intVal = Neo4jRecordFactory.integer(42);
  console.log('Neo4j Integer:', intVal);

  // Create a Neo4j DateTime
  const dt = Neo4jRecordFactory.dateTime('2024-01-15T10:30:00Z');
  console.log('Neo4j DateTime:', dt);

  // Create a mock Neo4j Node
  const node = Neo4jRecordFactory.node(['Book'], {
    id: '1',
    title: 'Mock Node Book',
  });
  console.log('Neo4j Node:', node);

  // =========================================================================
  // SelectionSetFactory — build selection sets from simplified specs
  // =========================================================================

  // gql() — build a GraphQL selection set string
  const selectionSet = SelectionSetFactory.gql([
    'id',
    'title',
    { author: ['id', 'name'] },
    { categories: ['id', 'name'] },
  ]);
  console.log('\nSelection set string:', selectionSet);
  // => '{ id title author { id name } categories { id name } }'

  // select() — build a typed select object
  const selectObj = SelectionSetFactory.select([
    'id',
    'title',
    { author: ['id', 'name'] },
  ]);
  console.log('Select object:', JSON.stringify(selectObj, null, 2));
  // => { id: true, title: true, author: { select: { id: true, name: true } } }

  // Nested relationships
  const deepSelect = SelectionSetFactory.gql([
    'id',
    {
      author: [
        'name',
        { books: ['id', 'title'] },
      ],
    },
  ]);
  console.log('Deep selection:', deepSelect);
  // => '{ id author { name books { id title } } }'
}

main();
