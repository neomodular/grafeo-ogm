/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
/**
 * Interleaved A/B of the Cypher two source trees generate for the same
 * shapes (BASE_SRC = other checkout's `src`, default `../../src` = this one).
 *
 *   BASE_SRC=/tmp/base/src npx ts-node -T bench/live/ab.ts <shapeFilter>
 *
 * Per shape: captures each tree's statement, checks both return the same
 * rows (canonical JSON, inside rolled-back transactions), then alternates
 * A / B for RUNS warm runs and COLD cache-busted runs; prints db hits,
 * memory, median warm ms and median cold (plan + run) ms.
 */
import neo4j, { Driver, Transaction } from 'neo4j-driver';
import { typeDefs } from './schema';
import { SHAPES } from './shapes';

const RUNS = Number(process.env.RUNS ?? 21);
const COLD = Number(process.env.COLD ?? 7);

function hits(p: any): number {
  return p.dbHits + p.children.reduce((a: number, c: any) => a + hits(c), 0);
}
function canon(records: any[]): string {
  return JSON.stringify(
    records.map((r) => r.toObject()),
    (_k, v) => {
      if (neo4j.isInt(v)) return `int:${v.toString()}`;
      if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        v.constructor?.name === 'Node'
      )
        return { labels: v.labels, props: v.properties };
      return v;
    },
  );
}

async function capture(
  driver: Driver,
  ogm: any,
  shape: any,
): Promise<{ cypher: string; params: any }[]> {
  const session = driver.session();
  const tx = session.beginTransaction();
  const out: { cypher: string; params: any }[] = [];
  const wrapped = new Proxy(tx, {
    get(t, p, r) {
      if (p === 'run')
        return (c: string, ps: any) => {
          out.push({ cypher: c, params: ps });
          return t.run(c, ps);
        };
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as Transaction;
  try {
    const o =
      shape.ogm === 'policy'
        ? ogm.policy.withContext({ tid: 't5' })
        : ogm[shape.ogm ?? 'default'];
    await shape.run(o, { transaction: wrapped });
  } finally {
    await tx.rollback();
    await session.close();
  }
  return out;
}

function makeOgms(src: string, driver: Driver): any {
  const { OGM } = require(`${src}/ogm`);
  const { permissive, restrictive } = require(`${src}/policy/types`);
  const all = (name: string): any =>
    permissive({
      operations: ['read', 'update', 'create', 'delete'],
      name,
      when: () => ({}),
    });
  return {
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
        PfTag: [all('tag.all')],
        PfComment: [all('c.all')],
        PfNote: [all('n.all')],
      },
    }),
  };
}

async function timed(
  driver: Driver,
  cypher: string,
  params: any,
  cold: boolean,
): Promise<{ ms: number; rows: string }> {
  const s = driver.session();
  const tx = s.beginTransaction();
  try {
    const q = cold
      ? `CYPHER runtime=slotted /* ${Math.random()} */ ${cypher}`
      : `CYPHER runtime=slotted ${cypher}`;
    const t0 = process.hrtime.bigint();
    const r = await tx.run(q, params);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ms, rows: canon(r.records) };
  } finally {
    await tx.rollback();
    await s.close();
  }
}

async function profile(
  driver: Driver,
  cypher: string,
  params: any,
): Promise<{ hits: number; mem: number }> {
  const s = driver.session();
  const tx = s.beginTransaction();
  try {
    const r = await tx.run(`CYPHER runtime=slotted PROFILE ${cypher}`, params);
    const p: any = r.summary.profile;
    const m = p.arguments.GlobalMemory;
    return {
      hits: hits(p),
      mem: m == null ? 0 : neo4j.isInt(m) ? m.toNumber() : Number(m),
    };
  } finally {
    await tx.rollback();
    await s.close();
  }
}

const med = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[xs.length >> 1];

async function main(): Promise<void> {
  const filter = process.argv[2] ?? '';
  const driver = neo4j.driver(
    process.env.NEO4J_URI ?? 'bolt://localhost:17733',
    neo4j.auth.basic('neo4j', process.env.NEO4J_PASSWORD ?? 'livetest-pw-526'),
  );
  const A = makeOgms(process.env.BASE_SRC ?? `${__dirname}/../../src`, driver);
  const B = makeOgms(`${__dirname}/../../src`, driver);
  try {
    for (const shape of SHAPES) {
      if (!shape.name.includes(filter)) continue;
      const [a] = await capture(driver, A, shape);
      const [b] = await capture(driver, B, shape);
      if (!a || !b) continue;
      const same = a.cypher === b.cypher;
      const wa: number[] = [],
        wb: number[] = [],
        ca: number[] = [],
        cb: number[] = [];
      let ra = '',
        rb = '';
      for (let i = 0; i < RUNS; i++) {
        const x = await timed(driver, a.cypher, a.params, false);
        const y = await timed(driver, b.cypher, b.params, false);
        wa.push(x.ms);
        wb.push(y.ms);
        ra = x.rows;
        rb = y.rows;
      }
      for (let i = 0; i < COLD; i++) {
        ca.push((await timed(driver, a.cypher, a.params, true)).ms);
        cb.push((await timed(driver, b.cypher, b.params, true)).ms);
      }
      const pa = await profile(driver, a.cypher, a.params);
      const pb = await profile(driver, b.cypher, b.params);
      console.log(
        `${shape.name.padEnd(40)} ${same ? 'SAME-CYPHER' : 'changed    '} rows-identical=${ra === rb}` +
          ` | hits ${pa.hits} -> ${pb.hits} | mem ${pa.mem} -> ${pb.mem}` +
          ` | warm ${med(wa).toFixed(2)} -> ${med(wb).toFixed(2)} ms | cold ${med(ca).toFixed(1)} -> ${med(cb).toFixed(1)} ms`,
      );
      if (process.env.PRINT && !same)
        console.log('--- A\n' + a.cypher + '\n--- B\n' + b.cypher);
    }
  } finally {
    await driver.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
