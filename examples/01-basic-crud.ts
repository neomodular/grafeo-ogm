/**
 * 01 - Basic CRUD Operations
 *
 * Demonstrates the four fundamental operations: find, create, update, delete.
 */

import { createOGM, cleanup } from './shared/setup';

async function main() {
  const { ogm, driver } = createOGM();

  try {
    const Author = ogm.model('Author');

    // --- CREATE ---
    const createResult = await Author.create({
      input: [
        { name: 'George Orwell', bio: 'English novelist', bornYear: 1903 },
      ],
    });
    console.log('Created:', createResult);

    // --- FIND ---
    const authors = await Author.find();
    console.log('All authors:', authors);

    // Find with a where filter
    const filtered = await Author.find({
      where: { name: 'George Orwell' },
    });
    console.log('Filtered:', filtered);

    // Find with sorting, limit, and offset
    const paginated = await Author.find({
      options: {
        sort: [{ name: 'ASC' }],
        limit: 10,
        offset: 0,
      },
    });
    console.log('Paginated:', paginated);

    // --- UPDATE ---
    const updateResult = await Author.update({
      where: { name: 'George Orwell' },
      update: { bio: 'English novelist and essayist' },
    });
    console.log('Updated:', updateResult);

    // --- DELETE ---
    const deleteResult = await Author.delete({
      where: { name: 'George Orwell' },
    });
    console.log('Deleted:', deleteResult);
    // => { nodesDeleted: 1, relationshipsDeleted: 0 }
  } finally {
    await cleanup(ogm, driver);
  }
}

main().catch(console.error);
