/**
 * 05 - Nested Mutations
 *
 * Demonstrates create with nested relationships, connect/disconnect,
 * edge properties, and cascade delete.
 */

import { createOGM, cleanup } from './shared/setup';

async function main() {
  const { ogm, driver } = createOGM();

  try {
    const Author = ogm.model('Author');
    const Book = ogm.model('Book');
    const Category = ogm.model('Category');

    // --- Setup: create an author and category ---
    await Author.create({
      input: [{ name: 'Aldous Huxley', bio: 'English writer' }],
    });
    await Category.create({
      input: [{ name: 'Dystopian Fiction' }],
    });

    // --- Create with nested connect and edge properties ---
    const bookResult = await Book.create({
      input: [
        {
          title: 'Brave New World',
          isbn: '978-0060850524',
          price: 14.99,
          status: 'PUBLISHED',
          author: {
            connect: {
              where: { node: { name: 'Aldous Huxley' } },
              edge: { role: 'Author', year: 1932 },
            },
          },
          categories: {
            connect: [
              {
                where: { node: { name: 'Dystopian Fiction' } },
                edge: { isPrimary: true },
              },
            ],
          },
        },
      ],
      selectionSet: `{
        books {
          id
          title
          author {
            name
          }
        }
      }`,
    });
    console.log('Created with relationships:', bookResult);

    // --- Connect an existing node via update ---
    await Category.create({
      input: [{ name: 'Science Fiction' }],
    });

    await Book.update({
      where: { title: 'Brave New World' },
      connect: {
        categories: [
          {
            where: { node: { name: 'Science Fiction' } },
            edge: { isPrimary: false },
          },
        ],
      },
    });
    console.log('Connected additional category');

    // --- Disconnect a relationship ---
    await Book.update({
      where: { title: 'Brave New World' },
      disconnect: {
        categories: [{ where: { node: { name: 'Science Fiction' } } }],
      },
    });
    console.log('Disconnected category');

    // --- Cascade delete (delete related nodes) ---
    const deleteResult = await Book.delete({
      where: { title: 'Brave New World' },
      delete: {
        reviews: [{ where: {} }], // delete all related reviews
      },
    });
    console.log('Cascade deleted:', deleteResult);

    // --- Cleanup ---
    await Author.delete({ where: { name: 'Aldous Huxley' } });
    await Category.delete({ where: { name: 'Dystopian Fiction' } });
    await Category.delete({ where: { name: 'Science Fiction' } });
  } finally {
    await cleanup(ogm, driver);
  }
}

main().catch(console.error);
