/**
 * 03 - Typed Select API
 *
 * Demonstrates the `select: {}` API vs `selectionSet` string,
 * nested select, and select with where filters.
 */

import { createOGM, cleanup } from './shared/setup';

async function main() {
  const { ogm, driver } = createOGM();

  try {
    const Book = ogm.model('Book');

    // --- selectionSet (GraphQL string) ---
    const withSelectionSet = await Book.find({
      selectionSet: `{
        id
        title
        price
        author {
          id
          name
        }
      }`,
    });
    console.log('With selectionSet:', withSelectionSet);

    // --- select: {} (typed object API) ---
    // Use `true` for scalar fields
    const withSelect = await Book.find({
      select: {
        id: true,
        title: true,
        price: true,
      },
    });
    console.log('With select:', withSelect);

    // --- Nested select ---
    // For relationships, use { select: { ... } } to pick nested fields
    const withNestedSelect = await Book.find({
      select: {
        id: true,
        title: true,
        author: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
    console.log('With nested select:', withNestedSelect);

    // --- Select with where on relationships ---
    // Filter related nodes using `where` alongside `select`
    const withWhereSelect = await Book.find({
      select: {
        id: true,
        title: true,
        reviews: {
          select: {
            rating: true,
            comment: true,
          },
          where: {
            rating_GTE: 4,
          },
        },
      },
    });
    console.log('With where on relationship:', withWhereSelect);

    // --- Using `true` for a relationship returns all scalars ---
    const withRelBool = await Book.find({
      select: {
        id: true,
        title: true,
        author: true, // returns all scalar fields of Author
      },
    });
    console.log('Relationship with true:', withRelBool);

    // --- select and selectionSet are mutually exclusive ---
    // This would throw an OGMError:
    // await Book.find({ select: { id: true }, selectionSet: '{ id }' });
  } finally {
    await cleanup(ogm, driver);
  }
}

main().catch(console.error);
