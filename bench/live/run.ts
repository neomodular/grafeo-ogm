/* eslint-disable no-console */
/**
 * Live Cypher performance harness (server side, SLOTTED runtime).
 *
 *   NEO4J_URI=bolt://localhost:17733 npx ts-node -T bench/live/run.ts [filter] [--print]
 *
 * For every shape: run the OGM call inside a rolled-back transaction whose
 * `run` is wrapped to capture each generated statement, then re-run every
 * captured statement N times (fresh rolled-back tx each) with
 * `CYPHER runtime=slotted PROFILE` for db hits / rows / memory, and plain
 * `CYPHER runtime=slotted` for the median wall time.
 */
import neo4j, { Driver, Integer, Transaction } from 'neo4j-driver';
import { writeFileSync } from 'node:fs';
import { OGM } from '../../src/ogm';
import { permissive, restrictive } from '../../src/policy/types';
import { typeDefs } from './schema';
import { SHAPES } from './shapes';

const RUNS = Number(process.env.RUNS ?? 15);

interface Captured {
  cypher: string;
  params: Record<string, unknown>;
}

interface Plan {
  dbHits: number;
  rows: number;
  arguments: Record<string, unknown>;
  children: Plan[];
  operatorType: string;
}

function sumHits(p: Plan): number {
  return p.dbHits + p.children.reduce((a, c) => a + sumHits(c), 0);
}

function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (neo4j.isInt(v)) return (v as Integer).toNumber();
  return Number(v);
}

async function capture(
  driver: Driver,
  ogm: OGM,
  fn: (ogm: OGM, ctx: { transaction: Transaction }) => Promise<unknown>,
): Promise<{ statements: Captured[]; result: unknown }> {
  const session = driver.session();
  const tx = session.beginTransaction();
  const statements: Captured[] = [];
  const wrapped = new Proxy(tx, {
    get(target, prop, recv) {
      if (prop === 'run')
        return (cypher: string, params: Record<string, unknown>) => {
          statements.push({ cypher, params });
          return target.run(cypher, params);
        };
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Transaction;
  try {
    const result = await fn(ogm, { transaction: wrapped });
    return { statements, result };
  } finally {
    await tx.rollback();
    await session.close();
  }
}

async function measure(
  driver: Driver,
  st: Captured,
): Promise<{
  dbHits: number;
  rows: number;
  memory: number;
  medianMs: number;
  runtime: string;
  coldMs: number;
}> {
  const session = driver.session();
  try {
    // warm + profile
    let tx = session.beginTransaction();
    const prof = await tx.run(
      `CYPHER runtime=slotted PROFILE ${st.cypher}`,
      st.params,
    );
    await tx.rollback();
    const plan = prof.summary.profile as unknown as Plan;
    const runtime = String(plan.arguments.runtime ?? '?');
    const memory = num(plan.arguments.GlobalMemory);
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      tx = session.beginTransaction();
      const t0 = process.hrtime.bigint();
      const r = await tx.run(`CYPHER runtime=slotted ${st.cypher}`, st.params);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      void r;
      await tx.rollback();
    }
    times.sort((a, b) => a - b);
    tx = session.beginTransaction();
    const c0 = process.hrtime.bigint();
    await tx.run(
      `CYPHER runtime=slotted /* cold ${Math.random()} */ ${st.cypher}`,
      st.params,
    );
    const coldMs = Number(process.hrtime.bigint() - c0) / 1e6;
    await tx.rollback();
    return {
      dbHits: sumHits(plan),
      rows: plan.rows,
      memory,
      medianMs: times[Math.floor(times.length / 2)],
      runtime,
      coldMs,
    };
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const print = args.includes('--print');
  const filter = args.find((a) => !a.startsWith('--'));
  const out = process.env.OUT;
  const driver = neo4j.driver(
    process.env.NEO4J_URI ?? 'bolt://localhost:17733',
    neo4j.auth.basic('neo4j', process.env.NEO4J_PASSWORD ?? 'livetest-pw-526'),
  );
  const ogms: Record<string, OGM> = {
    default: new OGM({ typeDefs, driver }),
    strict: new OGM({ typeDefs, driver, strict: true }),
    policy: new OGM({
      typeDefs,
      driver,
      policies: {
        PfPost: [
          permissive({
            operations: ['read', 'update', 'delete', 'create'],
            name: 'post.tenant',
            when: (c: any) => ({ tenantId: c.tid }),
          }),
          restrictive({
            operations: ['read'],
            name: 'post.visible',
            when: () => ({ score_GTE: 0 }),
          }),
        ],
        PfUser: [
          permissive({
            operations: ['read', 'update', 'create', 'delete'],
            name: 'user.tenant',
            when: (c: any) => ({ tenantId: c.tid }),
          }),
        ],
        PfTag: [
          permissive({
            operations: ['read', 'update', 'create', 'delete'],
            name: 'tag.all',
            when: () => ({}),
          }),
        ],
        PfComment: [
          permissive({
            operations: ['read', 'update', 'create', 'delete'],
            name: 'c.all',
            when: () => ({}),
          }),
        ],
        PfNote: [
          permissive({
            operations: ['read', 'update', 'create', 'delete'],
            name: 'n.all',
            when: () => ({}),
          }),
        ],
      } as any,
    }),
  };
  const rows: Record<string, unknown>[] = [];
  try {
    for (const shape of SHAPES) {
      if (filter && !shape.name.includes(filter)) continue;
      const ogm = (
        shape.ogm === 'policy'
          ? (ogms.policy.withContext({ tid: 't5' } as any) as unknown)
          : ogms[shape.ogm ?? 'default']
      ) as OGM;
      let cap;
      try {
        cap = await capture(driver, ogm, shape.run);
      } catch (e) {
        console.log(
          `${shape.name.padEnd(42)} ERROR ${(e as Error).message.split('\n')[0]}`,
        );
        continue;
      }
      const { statements, result } = cap;
      let tot = {
        dbHits: 0,
        rows: 0,
        memory: 0,
        medianMs: 0,
        runtime: '',
        coldMs: 0,
      };
      for (const st of statements) {
        const m = await measure(driver, st);
        tot = {
          dbHits: tot.dbHits + m.dbHits,
          rows: m.rows,
          memory: Math.max(tot.memory, m.memory),
          medianMs: tot.medianMs + m.medianMs,
          runtime: m.runtime,
          coldMs: tot.coldMs + m.coldMs,
        };
      }
      const row = {
        shape: shape.name,
        stmts: statements.length,
        ...tot,
        medianMs: Number(tot.medianMs.toFixed(2)),
        coldMs: Number(tot.coldMs.toFixed(1)),
        resultHash: (JSON.stringify(result) ?? '').length,
      };
      rows.push({ ...row, cypher: statements.map((s) => s.cypher), result });
      console.log(
        `${shape.name.padEnd(42)} stmts=${row.stmts} hits=${String(row.dbHits).padStart(8)} rows=${String(row.rows).padStart(6)} mem=${String(row.memory).padStart(9)} ms=${String(row.medianMs).padStart(8)} cold=${String(row.coldMs).padStart(7)} ${row.runtime}`,
      );
      if (print)
        for (const s of statements) {
          console.log('---\n' + s.cypher);
          console.log(JSON.stringify(s.params));
        }
    }
  } finally {
    await driver.close();
  }
  if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
