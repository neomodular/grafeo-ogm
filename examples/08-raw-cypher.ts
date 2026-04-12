/**
 * 08 - Raw Cypher Queries
 *
 * Demonstrates $queryRaw and $executeRaw for custom Cypher queries
 * that go beyond the OGM's built-in methods.
 */

import { createOGM, cleanup } from './shared/setup';

async function main() {
  const { ogm, driver } = createOGM();

  try {
    const Author = ogm.model('Author');

    // Seed data
    await Author.create({
      input: [
        { name: 'Leo Tolstoy', bio: 'Russian writer', bornYear: 1828 },
        { name: 'Fyodor Dostoevsky', bio: 'Russian novelist', bornYear: 1821 },
      ],
    });

    // --- $queryRaw: read query returning mapped results ---
    const results = await ogm.$queryRaw<{ name: string; bornYear: number }>(
      'MATCH (a:Author) WHERE a.bornYear < $year RETURN a.name AS name, a.bornYear AS bornYear ORDER BY a.bornYear',
      { year: 1830 },
    );
    console.log('Raw query results:', results);

    // --- $queryRaw: graph pattern query ---
    const paths = await ogm.$queryRaw(
      `MATCH (a:Author)-[r:WRITTEN_BY]-(b:Book)
       RETURN a.name AS author, b.title AS book, type(r) AS relType
       LIMIT 10`,
    );
    console.log('Path query:', paths);

    // --- $executeRaw: write operation returning affected counts ---
    const writeResult = await ogm.$executeRaw(
      'MATCH (a:Author) WHERE a.name = $name SET a.bio = $bio',
      { name: 'Leo Tolstoy', bio: 'Russian writer and philosopher' },
    );
    console.log('Execute raw result:', writeResult);
    // => { recordsAffected: N } (sum of nodes/rels created/deleted + properties set)

    // --- $executeRaw: bulk operation ---
    const bulkResult = await ogm.$executeRaw(
      `MATCH (a:Author)
       WHERE a.bornYear < $year
       SET a.bio = a.bio + ' (classic author)'`,
      { year: 1900 },
    );
    console.log('Bulk update:', bulkResult);

    // --- Cleanup ---
    await Author.deleteMany({
      where: { name_IN: ['Leo Tolstoy', 'Fyodor Dostoevsky'] },
    });
  } finally {
    await cleanup(ogm, driver);
  }
}

main().catch(console.error);
