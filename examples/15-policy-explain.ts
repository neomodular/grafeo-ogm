/**
 * 15 - Explaining Policy Decisions
 *
 * On a policy-bound model, `find` only tells you THAT a node is hidden.
 * `explainPolicies` tells you WHICH named policy clause hid it — for
 * declarative `when:` and raw `cypher:` clauses alike — and returns the
 * hidden nodes too, each with a per-clause outcome.
 *
 * It bypasses policy filtering by design: use it on admin-only
 * diagnostic paths. Every call logs a warning and is tagged
 * `explain: true` in transaction metadata.
 */

import { OGM, permissive, restrictive } from 'grafeo-ogm';
import { cleanup, createOGM, typeDefs } from './shared/setup';

async function main() {
  const { ogm: baseOgm, driver } = createOGM();
  const ogm = new OGM({
    typeDefs,
    driver,
    logger: console,
    policies: {
      Book: [
        permissive({
          operations: ['read'],
          name: 'book.published',
          when: () => ({ status: 'PUBLISHED' }),
        }),
        restrictive({
          operations: ['read'],
          name: 'book.priced',
          when: () => ({ price_GT: 0 }),
        }),
        // Raw-Cypher clauses are explained exactly like declarative ones.
        restrictive({
          operations: ['read'],
          name: 'book.reviewed',
          cypher: {
            fragment: (_ctx, { node }) =>
              `EXISTS { MATCH (${node})-[:HAS_REVIEW]->(:Review) }`,
            params: () => ({}),
          },
        }),
        // Only applies when the request carries a category.
        restrictive({
          operations: ['read'],
          name: 'book.in-category',
          appliesWhen: (ctx) => Boolean(ctx.categoryName),
          when: (ctx) => ({ categories_SOME: { name: ctx.categoryName } }),
        }),
      ],
    },
  });

  // Seed with raw Cypher (policies do not govern $executeRaw).
  await ogm.$executeRaw(`
    CREATE (:Book {id: 'explain-1', title: 'Explain: visible', status: 'PUBLISHED', price: 10.0})
           -[:HAS_REVIEW]->(:Review {id: 'explain-r1', rating: 5})
    CREATE (:Book {id: 'explain-2', title: 'Explain: free', status: 'PUBLISHED', price: 0.0})
           -[:HAS_REVIEW]->(:Review {id: 'explain-r2', rating: 4})
    CREATE (:Book {id: 'explain-3', title: 'Explain: unreviewed draft', status: 'DRAFT', price: 12.0})
  `);

  try {
    const ids = ['explain-1', 'explain-2', 'explain-3'];
    const Books = ogm.withContext({ readerId: 'r1' }).model('Book');

    // --- What find() can tell you: only the survivors ---
    const visible = await Books.find({
      where: { id_IN: ids },
      select: { id: true },
    });
    console.log(
      'find() returns:',
      visible.map((b) => b.id),
    );
    // => [ 'explain-1' ]

    // --- What explainPolicies() tells you: why, for every candidate ---
    const report = await Books.explainPolicies({
      where: { id_IN: ids },
      select: { id: true, title: true },
      options: { sort: [{ title: 'ASC' }] },
    });
    for (const r of report) {
      const passed = r.policies
        .filter((p) => p.outcome === 'pass')
        .map((p) => p.name);
      const rejectedBy = [
        ...(r.permissiveGranted ? [] : ['(no permissive granted)']),
        ...r.failedRestrictives,
      ];
      console.log(
        `${String(r.node.title)}: ${
          r.visible
            ? 'visible'
            : `hidden — rejected by ${rejectedBy.join(', ')}`
        } (passed: ${passed.join(', ') || 'none'})`,
      );
    }
    // => Explain: free: hidden — rejected by book.priced (passed: book.published, book.reviewed)
    // => Explain: unreviewed draft: hidden — rejected by (no permissive granted), book.reviewed (passed: book.priced)
    // => Explain: visible: visible (passed: book.published, book.priced, book.reviewed)

    // `visible` IS the enforcement verdict: it always matches find().
    const explained = report
      .filter((r) => r.visible)
      .map((r) => String(r.node.id))
      .sort();
    const found = visible.map((b) => String(b.id)).sort();
    if (JSON.stringify(explained) !== JSON.stringify(found))
      throw new Error(`explain/find mismatch: ${explained} vs ${found}`);

    // --- appliesWhen is reported, not folded into a pass ---
    const [plain] = await Books.explainPolicies({
      where: { id: 'explain-1' },
    });
    console.log(plain.policies.find((p) => p.name === 'book.in-category'));
    // => { name: 'book.in-category', ..., applied: false, outcome: 'not-applied' }

    const [scoped] = await ogm
      .withContext({ readerId: 'r1', categoryName: 'Dystopian Fiction' })
      .model('Book')
      .explainPolicies({ where: { id: 'explain-1' } });
    console.log(scoped.policies.find((p) => p.name === 'book.in-category'));
    // => { name: 'book.in-category', ..., applied: true, outcome: 'fail' }
    //    (the demo book has no category)
  } finally {
    await ogm.$executeRaw(
      `MATCH (n) WHERE n.id STARTS WITH 'explain-' DETACH DELETE n`,
    );
    ogm.close();
    await cleanup(baseOgm, driver);
  }
}

main().catch(console.error);
