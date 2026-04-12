/**
 * 04 - Where Filters
 *
 * Demonstrates comparison, string, logical, null, and relationship filters.
 */

import { createOGM, cleanup } from './shared/setup';

async function main() {
  const { ogm, driver } = createOGM();

  try {
    const Book = ogm.model('Book');

    // --- Comparison operators ---
    const expensive = await Book.find({
      where: { price_GTE: 20.0 },
    });
    console.log('Expensive books (>= $20):', expensive);

    const inRange = await Book.find({
      where: { price_GT: 10, price_LT: 30 },
    });
    console.log('Books $10-$30:', inRange);

    // --- String operators ---
    const containing = await Book.find({
      where: { title_CONTAINS: 'World' },
    });
    console.log('Title contains "World":', containing);

    const startsWith = await Book.find({
      where: { title_STARTS_WITH: 'The' },
    });
    console.log('Title starts with "The":', startsWith);

    const endsWith = await Book.find({
      where: { title_ENDS_WITH: 'Farm' },
    });
    console.log('Title ends with "Farm":', endsWith);

    // --- IN operator ---
    const specificStatuses = await Book.find({
      where: { status_IN: ['PUBLISHED', 'DRAFT'] },
    });
    console.log('Published or Draft:', specificStatuses);

    // --- NULL checks ---
    const withDescription = await Book.find({
      where: { description_NOT: null },
    });
    console.log('Books with description:', withDescription);

    // --- Logical operators (AND / OR / NOT) ---
    const complexFilter = await Book.find({
      where: {
        OR: [
          { price_LT: 10 },
          { AND: [{ status: 'PUBLISHED' }, { title_CONTAINS: 'New' }] },
        ],
      },
    });
    console.log('Complex filter:', complexFilter);

    const notDraft = await Book.find({
      where: {
        NOT: { status: 'DRAFT' },
      },
    });
    console.log('Not draft:', notDraft);

    // --- Relationship filters ---
    // Find books where SOME reviews have a high rating
    const highlyRated = await Book.find({
      where: {
        reviews_SOME: { rating_GTE: 5 },
      },
    });
    console.log('Has 5-star review:', highlyRated);

    // Find books where ALL reviews are positive
    const allPositive = await Book.find({
      where: {
        reviews_ALL: { rating_GTE: 3 },
      },
    });
    console.log('All reviews >= 3:', allPositive);

    // Find books with NO low reviews
    const noLowReviews = await Book.find({
      where: {
        reviews_NONE: { rating_LT: 3 },
      },
    });
    console.log('No reviews below 3:', noLowReviews);

    // --- Nested relationship filters ---
    const byAuthorName = await Book.find({
      where: {
        author: { name_CONTAINS: 'Orwell' },
      },
    });
    console.log('Books by Orwell:', byAuthorName);
  } finally {
    await cleanup(ogm, driver);
  }
}

main().catch(console.error);
