/**
 * 09 - Interface Models
 *
 * Demonstrates querying across types via a shared GraphQL interface.
 * InterfaceModel provides read-only operations and always returns __typename.
 * Mutations must use the concrete model.
 */

import { createOGM, cleanup } from './shared/setup';
import { OGMError } from 'grafeo-ogm';

async function main() {
  const { ogm, driver } = createOGM();

  try {
    const Author = ogm.model('Author');
    const Publisher = ogm.model('Publisher');

    // Seed data: both Author and Publisher implement Entity
    await Author.create({
      input: [{ name: 'Jane Austen', bio: 'English novelist' }],
    });
    await Publisher.create({
      input: [{ name: 'Penguin Books', website: 'https://www.penguin.com' }],
    });

    // --- Query across all Entity implementations ---
    const Entity = ogm.interfaceModel('Entity');

    const allEntities = await Entity.find();
    console.log('All entities:', allEntities);
    // Each result includes __typename: 'Author' or 'Publisher'

    // --- Filter by shared interface fields ---
    const byName = await Entity.find({
      where: { name_CONTAINS: 'Austen' },
    });
    console.log('Filtered entities:', byName);

    // --- findFirst on interface ---
    const first = await Entity.findFirst({
      options: { sort: [{ name: 'ASC' }] },
    });
    console.log('First entity:', first);

    // --- findUnique on interface ---
    const unique = await Entity.findUnique({
      where: { name: 'Penguin Books' },
    });
    console.log('Unique entity:', unique);

    // --- count across implementations ---
    const total = await Entity.count();
    console.log('Total entities:', total);

    // --- aggregate across implementations ---
    const agg = await Entity.aggregate({
      aggregate: { count: true },
    });
    console.log('Aggregate:', agg);

    // --- Mutations throw on interface models ---
    try {
      await Entity.create();
    } catch (err) {
      if (err instanceof OGMError) {
        console.log('Expected error:', err.message);
        // => Cannot create on interface type "Entity". Use ogm.model('ConcreteType') for mutations.
      }
    }

    // --- Cleanup ---
    await Author.delete({ where: { name: 'Jane Austen' } });
    await Publisher.delete({ where: { name: 'Penguin Books' } });
  } finally {
    await cleanup(ogm, driver);
  }
}

main().catch(console.error);
