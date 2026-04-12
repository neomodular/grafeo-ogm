/**
 * 12 - Error Handling
 *
 * Demonstrates RecordNotFoundError, OGMError, and how to catch them.
 */

import { createOGM, cleanup } from './shared/setup';
import { OGMError, RecordNotFoundError } from 'grafeo-ogm';

async function main() {
  const { ogm, driver } = createOGM();

  try {
    const Book = ogm.model('Book');

    // --- RecordNotFoundError from findFirstOrThrow ---
    try {
      await Book.findFirstOrThrow({
        where: { title: 'This Book Does Not Exist' },
      });
    } catch (err) {
      if (err instanceof RecordNotFoundError) {
        console.log('Error name:', err.name); // 'RecordNotFoundError'
        console.log('Message:', err.message); // 'No Book record found with where ...'
        console.log('Model:', err.model); // 'Book'
        console.log('Where:', err.where); // { title: 'This Book Does Not Exist' }
      }
    }

    // --- RecordNotFoundError from findUniqueOrThrow ---
    try {
      await Book.findUniqueOrThrow({
        where: { isbn: 'invalid-isbn' },
      });
    } catch (err) {
      if (err instanceof RecordNotFoundError) {
        console.log('\nfindUniqueOrThrow error:', err.message);
      }
    }

    // --- OGMError: mutually exclusive select + selectionSet ---
    try {
      await Book.find({
        select: { id: true },
        selectionSet: '{ id }',
      });
    } catch (err) {
      if (err instanceof OGMError) {
        console.log('\nOGMError:', err.message);
        // 'Cannot provide both "select" and "selectionSet". They are mutually exclusive.'
      }
    }

    // --- OGMError: unknown model ---
    try {
      ogm.model('NonexistentType');
    } catch (err) {
      if (err instanceof OGMError) {
        console.log('\nUnknown type error:', err.message);
        // 'Unknown type: NonexistentType. Not found in nodes or interfaces.'
      }
    }

    // --- OGMError: mutation on interface model ---
    try {
      const Entity = ogm.interfaceModel('Entity');
      await Entity.create();
    } catch (err) {
      if (err instanceof OGMError) {
        console.log('\nInterface mutation error:', err.message);
      }
    }

    // --- All OGM errors extend Error ---
    try {
      await Book.findFirstOrThrow({ where: { title: 'nope' } });
    } catch (err) {
      console.log('\nIs Error?', err instanceof Error); // true
      console.log('Is OGMError?', err instanceof OGMError); // true
      console.log('Is RecordNotFoundError?', err instanceof RecordNotFoundError); // true
    }
  } finally {
    await cleanup(ogm, driver);
  }
}

main().catch(console.error);
