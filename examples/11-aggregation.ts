/**
 * 11 - Aggregation
 *
 * Demonstrates count() and aggregate() with min/max/avg.
 */

import { createOGM, cleanup } from './shared/setup';

async function main() {
  const { ogm, driver } = createOGM();

  try {
    const Book = ogm.model('Book');
    const Review = ogm.model('Review');

    // Seed data
    await Book.createMany({
      data: [
        { title: 'Book A', price: 9.99, status: 'PUBLISHED' },
        { title: 'Book B', price: 14.99, status: 'PUBLISHED' },
        { title: 'Book C', price: 24.99, status: 'DRAFT' },
        { title: 'Book D', price: 39.99, status: 'PUBLISHED' },
      ],
    });

    // --- count() ---
    const total = await Book.count();
    console.log('Total books:', total);

    // count with where filter
    const publishedCount = await Book.count({
      where: { status: 'PUBLISHED' },
    });
    console.log('Published books:', publishedCount);

    // --- aggregate() with count ---
    const countAgg = await Book.aggregate({
      aggregate: { count: true },
    });
    console.log('Count aggregate:', countAgg);
    // => { count: 4 }

    // --- aggregate() with field stats ---
    const priceAgg = await Book.aggregate({
      aggregate: { price: true },
    });
    console.log('Price aggregate:', priceAgg);
    // => { price: { min: 9.99, max: 39.99, average: 22.49 } }

    // --- Combined count + field aggregate ---
    const combined = await Book.aggregate({
      aggregate: { count: true, price: true },
    });
    console.log('Combined:', combined);
    // => { count: 4, price: { min: 9.99, max: 39.99, average: 22.49 } }

    // --- Aggregate with where filter ---
    const publishedPrices = await Book.aggregate({
      where: { status: 'PUBLISHED' },
      aggregate: { count: true, price: true },
    });
    console.log('Published prices:', publishedPrices);

    // --- Cleanup ---
    await Book.deleteMany({
      where: { title_IN: ['Book A', 'Book B', 'Book C', 'Book D'] },
    });
  } finally {
    await cleanup(ogm, driver);
  }
}

main().catch(console.error);
