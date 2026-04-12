/**
 * 07 - Transactions
 *
 * Demonstrates $transaction with callback and sequential forms.
 * Transactions auto-commit on success and rollback on error.
 */

import { createOGM, cleanup } from './shared/setup';

async function main() {
  const { ogm, driver } = createOGM();

  try {
    const Author = ogm.model('Author');
    const Book = ogm.model('Book');

    // --- Callback form ---
    // Pass a function that receives a transaction context.
    // All model operations within receive the same transaction.
    const result = await ogm.$transaction(async (ctx) => {
      const authorResult = await Author.create({
        input: [{ name: 'Franz Kafka', bio: 'Czech novelist' }],
        context: ctx,
      });

      const bookResult = await Book.create({
        input: [
          {
            title: 'The Metamorphosis',
            price: 7.99,
            author: {
              connect: {
                where: { node: { name: 'Franz Kafka' } },
              },
            },
          },
        ],
        context: ctx,
      });

      return { authorResult, bookResult };
    });
    console.log('Transaction result:', result);

    // --- Sequential form ---
    // Pass an array of operations. Each runs in order within the same transaction.
    const [authorsFound, booksFound] = await ogm.$transaction([
      (ctx) => Author.find({ where: { name: 'Franz Kafka' }, context: ctx }),
      (ctx) =>
        Book.find({
          where: { title: 'The Metamorphosis' },
          context: ctx,
        }),
    ]);
    console.log('Sequential transaction:', { authorsFound, booksFound });

    // --- Automatic rollback on error ---
    try {
      await ogm.$transaction(async (ctx) => {
        await Author.create({
          input: [{ name: 'Will Be Rolled Back' }],
          context: ctx,
        });

        // This error causes the entire transaction to rollback
        throw new Error('Something went wrong');
      });
    } catch (err) {
      console.log('Transaction rolled back:', (err as Error).message);
      // 'Will Be Rolled Back' author was NOT persisted
    }

    // --- Cleanup ---
    await Book.delete({ where: { title: 'The Metamorphosis' } });
    await Author.delete({ where: { name: 'Franz Kafka' } });
  } finally {
    await cleanup(ogm, driver);
  }
}

main().catch(console.error);
