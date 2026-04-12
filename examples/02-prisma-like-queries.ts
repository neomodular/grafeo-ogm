/**
 * 02 - Prisma-like Query Methods
 *
 * Demonstrates findFirst, findUnique, *OrThrow variants,
 * createMany, updateMany, deleteMany, and upsert.
 */

import { createOGM, cleanup } from './shared/setup';
import { RecordNotFoundError } from 'grafeo-ogm';

async function main() {
  const { ogm, driver } = createOGM();

  try {
    const Book = ogm.model('Book');

    // --- createMany ---
    const batchResult = await Book.createMany({
      data: [
        { title: 'Animal Farm', isbn: '978-0451526342', price: 9.99 },
        { title: '1984', isbn: '978-0451524935', price: 12.99 },
        { title: 'Brave New World', isbn: '978-0060850524', price: 11.99 },
      ],
    });
    console.log('Created count:', batchResult.count);

    // --- findFirst ---
    const cheapest = await Book.findFirst({
      options: { sort: [{ price: 'ASC' }] },
    });
    console.log('Cheapest book:', cheapest);

    // --- findUnique ---
    const byIsbn = await Book.findUnique({
      where: { isbn: '978-0451524935' },
    });
    console.log('Found by ISBN:', byIsbn);

    // --- findFirstOrThrow ---
    try {
      await Book.findFirstOrThrow({
        where: { title: 'Nonexistent Book' },
      });
    } catch (err) {
      if (err instanceof RecordNotFoundError) {
        console.log('Expected error:', err.message);
        console.log('Model:', err.model, 'Where:', err.where);
      }
    }

    // --- findUniqueOrThrow ---
    const found = await Book.findUniqueOrThrow({
      where: { isbn: '978-0451524935' },
    });
    console.log('Found or threw:', found);

    // --- upsert ---
    const upserted = await Book.upsert({
      where: { isbn: '978-0451526342' },
      create: { title: 'Animal Farm', isbn: '978-0451526342', price: 9.99 },
      update: { price: 10.99 },
    });
    console.log('Upserted:', upserted);

    // --- updateMany ---
    const updateManyResult = await Book.updateMany({
      where: { price_LT: 11 },
      data: { status: 'PUBLISHED' },
    });
    console.log('Updated count:', updateManyResult.count);

    // --- deleteMany ---
    const deleteManyResult = await Book.deleteMany({
      where: { status: 'DRAFT' },
    });
    console.log('Deleted count:', deleteManyResult.count);
  } finally {
    await cleanup(ogm, driver);
  }
}

main().catch(console.error);
