/**
 * 10 - Multi-Label Support
 *
 * Demonstrates runtime multi-label filtering via the `labels` parameter
 * on queries and mutations, and the `setLabels()` method.
 */

import { createOGM, cleanup } from './shared/setup';

async function main() {
  const { ogm, driver } = createOGM();

  try {
    const Book = ogm.model('Book');

    // Seed data
    await Book.createMany({
      data: [
        { title: 'Featured Book', price: 19.99, status: 'PUBLISHED' },
        { title: 'Regular Book', price: 9.99, status: 'PUBLISHED' },
      ],
    });

    // --- setLabels: add an additional label to a node ---
    await Book.setLabels({
      where: { title: 'Featured Book' },
      addLabels: ['Featured'],
    });
    console.log('Added "Featured" label');

    // --- Query with additional label filter ---
    // Only matches nodes that have BOTH :Book AND :Featured labels
    const featured = await Book.find({
      labels: ['Featured'],
    });
    console.log('Featured books:', featured);
    // => Only "Featured Book"

    // --- findFirst with labels ---
    const firstFeatured = await Book.findFirst({
      labels: ['Featured'],
    });
    console.log('First featured:', firstFeatured);

    // --- count with labels ---
    const featuredCount = await Book.count({
      labels: ['Featured'],
    });
    console.log('Featured count:', featuredCount);

    // --- aggregate with labels ---
    const featuredAgg = await Book.aggregate({
      labels: ['Featured'],
      aggregate: { count: true, price: true },
    });
    console.log('Featured aggregate:', featuredAgg);

    // --- Update with labels filter ---
    await Book.update({
      labels: ['Featured'],
      update: { price: 24.99 },
    });
    console.log('Updated featured book price');

    // --- removeLabels ---
    await Book.setLabels({
      where: { title: 'Featured Book' },
      removeLabels: ['Featured'],
    });
    console.log('Removed "Featured" label');

    // Verify label was removed
    const afterRemoval = await Book.find({ labels: ['Featured'] });
    console.log('Featured after removal:', afterRemoval);
    // => []

    // --- Cleanup ---
    await Book.deleteMany({
      where: { title_IN: ['Featured Book', 'Regular Book'] },
    });
  } finally {
    await cleanup(ogm, driver);
  }
}

main().catch(console.error);
