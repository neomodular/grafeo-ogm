/* eslint-disable no-console */
/**
 * Seeds the live perf dataset (only Pf*-labelled nodes are touched).
 * Throwaway container only — never a database you care about:
 *   NEO4J_URI=bolt://localhost:17733 npx ts-node -T bench/live/seed.ts
 */
import neo4j from 'neo4j-driver';
import { CONSTRAINTS, SEED_STATEMENTS } from './schema';

async function main(): Promise<void> {
  const driver = neo4j.driver(
    process.env.NEO4J_URI ?? 'bolt://localhost:17733',
    neo4j.auth.basic('neo4j', process.env.NEO4J_PASSWORD ?? 'livetest-pw-526'),
  );
  const s = driver.session();
  try {
    await s.run(
      'MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH "Pf") CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 5000 ROWS',
    );
    for (const c of CONSTRAINTS) await s.run(c);
    await s.run('CALL db.awaitIndexes(300)');
    for (const st of SEED_STATEMENTS(Number(process.env.SCALE ?? 1))) {
      const t = Date.now();
      await s.run(st);
      console.log(
        'seeded in',
        Date.now() - t,
        'ms:',
        st.slice(0, 60).replace(/\s+/g, ' '),
      );
    }
    const r = await s.run(
      'MATCH (n) RETURN labels(n)[0] AS l, count(*) AS c ORDER BY l',
    );
    for (const rec of r.records)
      console.log(rec.get('l'), rec.get('c').toString());
  } finally {
    await s.close();
    await driver.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
