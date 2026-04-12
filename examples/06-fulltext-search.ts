/**
 * 06 - Fulltext Search
 *
 * Demonstrates fulltext search using @fulltext indexes
 * with phrase matching and score thresholds.
 *
 * Prerequisites: The fulltext index must exist in Neo4j.
 * Run `ogm.assertIndexesAndConstraints({ options: { create: true } })`
 * to create it, or create it manually:
 *   CREATE FULLTEXT INDEX BookSearch IF NOT EXISTS
 *   FOR (n:Book) ON EACH [n.title, n.description]
 */

import { createOGM, cleanup } from './shared/setup';

async function main() {
  const { ogm, driver } = createOGM();

  try {
    // Create the fulltext index if it doesn't exist
    await ogm.assertIndexesAndConstraints({ options: { create: true } });

    const Book = ogm.model('Book');

    // Seed some data
    await Book.createMany({
      data: [
        {
          title: 'The Art of War',
          description: 'Ancient Chinese military strategy treatise',
          price: 8.99,
        },
        {
          title: 'War and Peace',
          description: 'A novel about Russian society during the Napoleonic era',
          price: 15.99,
        },
        {
          title: 'The Art of Cooking',
          description: 'A comprehensive guide to culinary arts',
          price: 24.99,
        },
      ],
    });

    // --- Basic fulltext search ---
    const results = await Book.find({
      fulltext: {
        BookSearch: { phrase: 'art strategy' },
      },
    });
    console.log('Fulltext results:', results);

    // --- Fulltext search with score threshold ---
    const highScoreResults = await Book.find({
      fulltext: {
        BookSearch: { phrase: 'war', score: 1.0 },
      },
    });
    console.log('High-score results:', highScoreResults);

    // --- Fulltext search combined with where filter ---
    const affordableResults = await Book.find({
      fulltext: {
        BookSearch: { phrase: 'art' },
      },
      where: { price_LT: 10 },
    });
    console.log('Affordable art books:', affordableResults);

    // --- Cleanup ---
    await Book.deleteMany({
      where: {
        title_IN: ['The Art of War', 'War and Peace', 'The Art of Cooking'],
      },
    });
  } finally {
    await cleanup(ogm, driver);
  }
}

main().catch(console.error);
