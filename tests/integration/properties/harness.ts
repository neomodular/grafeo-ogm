/**
 * Shared harness for the property-based live suites.
 *
 * - Opt-in on `NEO4J_URI` like every live suite (`describeLive`).
 * - The seed graph is created once per suite under a per-run `runId` and
 *   removed in `afterAll`. Every generated case runs inside ONE explicit
 *   transaction that is rolled back, so each case starts from the same
 *   graph and nothing a case writes survives it.
 * - `snapshot()` reads every node and relationship of the run inside that
 *   transaction in a canonical, type-exact encoding (a Long and a Double
 *   never compare equal), so a diff is byte-exact.
 * - `checkProperty()` runs fast-check with a fixed seed (override with
 *   `PROPERTY_SEED`, `PROPERTY_RUNS`, `PROPERTY_PATH`) and, on failure,
 *   prints how to replay the shrunk counterexample.
 */
import fc from 'fast-check';
import neo4j, {
  Driver,
  Integer,
  isDate,
  isDateTime,
  isDuration,
  isInt,
  isLocalDateTime,
  isLocalTime,
  isPoint,
  isTime,
  Transaction,
} from 'neo4j-driver';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { OGMError } from '../../../src/errors';
import { SEED } from './schema';

export const URI = process.env.NEO4J_URI;
// `typeof` guard: the harness is also loaded by standalone repro scripts.
export const describeLive = (
  typeof describe === 'function' ? (URI ? describe : describe.skip) : undefined
) as jest.Describe;

/** Fixed default seed: CI runs are deterministic. */
export const DEFAULT_SEED = 20261018;

export function propertySeed(): number {
  const raw = process.env.PROPERTY_SEED;
  if (raw === undefined || raw === '') return DEFAULT_SEED;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`PROPERTY_SEED must be an integer`);
  return n;
}

/** Runs per property: `PROPERTY_RUNS` overrides every suite's default. */
export function propertyRuns(defaultRuns: number): number {
  const raw = process.env.PROPERTY_RUNS;
  if (raw === undefined || raw === '') return defaultRuns;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`PROPERTY_RUNS must be a positive integer`);
  return n;
}

/**
 * Assert a fast-check property with the suite seed. On failure the error
 * carries fast-check's report (seed, path, shrunk counterexample, the
 * failing assertion) plus a replay command.
 */
export async function checkProperty<T>(
  name: string,
  arb: fc.Arbitrary<T>,
  predicate: (value: T) => Promise<void>,
  defaultRuns: number,
): Promise<void> {
  const seed = propertySeed();
  const params: fc.Parameters<[T]> = {
    seed,
    numRuns: propertyRuns(defaultRuns),
    // Shrinking replays the DB round-trip; bound it so a failure reports
    // in reasonable time.
    endOnFailure: false,
    markInterruptAsFailure: true,
    interruptAfterTimeLimit: 15 * 60_000,
  };
  if (process.env.PROPERTY_PATH) params.path = process.env.PROPERTY_PATH;
  // PROPERTY_TRACE=<file>: append every case with its duration (debugging
  // a slow or hanging case).
  const trace = process.env.PROPERTY_TRACE;
  const traced = trace
    ? async (value: T) => {
        const start = Date.now();
        try {
          await predicate(value);
        } finally {
          appendFileSync(
            trace,
            `${name}\t${Date.now() - start}ms\t${JSON.stringify(
              value,
              (_k, x) => (typeof x === 'bigint' ? `${x}n` : x),
            )}\n`,
          );
        }
      }
    : predicate;
  try {
    await fc.assert(fc.asyncProperty(arb, traced), params);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const path = /path: "([^"]*)"/.exec(message)?.[1];
    const replay =
      `\n\n[${name}] Replay this exact counterexample with:\n` +
      `  PROPERTY_SEED=${seed}${path ? ` PROPERTY_PATH=${path}` : ''} ` +
      `NEO4J_URI=… npx jest ${expect.getState().testPath ?? ''} --runInBand\n`;
    (err as Error).message = message + replay;
    throw err;
  }
}

export function makeDriver(): Driver {
  // Lossless integers (the driver default): the snapshot must tell a Long
  // from a Double, and the round-trip rule writes Ints beyond 2^53.
  return neo4j.driver(
    process.env.NEO4J_URI!,
    neo4j.auth.basic(
      process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
      process.env.NEO4J_PASSWORD ?? 'password',
    ),
  );
}

export function newRunId(): string {
  return `itp-${randomUUID()}`;
}

type Rec = Record<string, unknown>;

/**
 * Inputs are generated with placeholders so a shrunk counterexample stays
 * readable and replayable: `'@run'` is the runId, `'@c1'` is the node id
 * `<runId>-c1`. Replaced deeply right before execution.
 */
export function resolvePlaceholders<T>(value: T, runId: string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v === '@run') return runId;
      if (v.startsWith('@')) return `${runId}-${v.slice(1)}`;
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (
      v &&
      typeof v === 'object' &&
      Object.getPrototypeOf(v) === Object.prototype
    ) {
      const out: Rec = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Strip the runId prefix back off an id (for readable failure output). */
export function shortId(id: string, runId: string): string {
  return id.startsWith(`${runId}-`) ? `@${id.slice(runId.length + 1)}` : id;
}

export async function run(
  driver: Driver,
  cypher: string,
  params: Rec = {},
): Promise<Rec[]> {
  const session = driver.session();
  try {
    const res = await session.run(cypher, params);
    return res.records.map((r) => r.toObject());
  } finally {
    await session.close();
  }
}

/** Create the shared seed graph for `runId`. */
export async function seedGraph(driver: Driver, runId: string): Promise<void> {
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      for (const n of SEED.nodes)
        await tx.run(
          `CREATE (n:\`${n.type}\`) SET n = $props, n.id = $id, n.runId = $runId`,
          {
            props: toNeo4jProps(n.props),
            id: `${runId}-${n.id}`,
            runId,
          },
        );
      for (const [from, type, to, props] of SEED.rels)
        await tx.run(
          `MATCH (a {id: $from, runId: $runId}), (b {id: $to, runId: $runId})
           CREATE (a)-[r:\`${type}\`]->(b) SET r = $props`,
          {
            from: `${runId}-${from}`,
            to: `${runId}-${to}`,
            runId,
            props: toNeo4jProps(props),
          },
        );
    });
  } finally {
    await session.close();
  }
}

/** Seed Ints as Longs, as the OGM writes them. */
function toNeo4jProps(props: Rec): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(props))
    out[k] = typeof v === 'number' && Number.isInteger(v) ? neo4j.int(v) : v;
  return out;
}

export async function cleanup(driver: Driver, runId: string): Promise<void> {
  await run(driver, 'MATCH (n) WHERE n.runId = $runId DETACH DELETE n', {
    runId,
  });
}

const TX_TIMEOUT_MS = Number(process.env.PROPERTY_TX_TIMEOUT_MS ?? 20_000);

/**
 * Run `fn` inside one explicit transaction and always roll it back. A
 * failed statement poisons the transaction; rolling back is still valid.
 */
export async function inRollback<T>(
  driver: Driver,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const session = driver.session();
  // A server-side timeout: a statement that runs away (rather than failing)
  // must not hang the suite; the timeout surfaces as a failure.
  const tx = session.beginTransaction({ timeout: TX_TIMEOUT_MS });
  try {
    return await fn(tx);
  } finally {
    try {
      await tx.rollback();
    } catch {
      // already closed by a failed statement
    }
    await session.close();
  }
}

// --- snapshot ---------------------------------------------------------------

export interface NodeSnap {
  key: string;
  type: string;
  labels: string[];
  props: Rec;
  canon: string;
}

export interface RelSnap {
  start: string;
  type: string;
  end: string;
  props: Rec;
  canon: string;
}

export interface Snapshot {
  nodes: Map<string, NodeSnap>;
  rels: RelSnap[];
}

/**
 * Every node of the run (runId), plus any `ItP*` node with no runId at all
 * (a write that dropped it must still be seen), and every relationship
 * leaving them. Nodes are keyed by `id`; a node without one by element id.
 */
export async function snapshot(
  tx: Transaction,
  runId: string,
): Promise<Snapshot> {
  const res = await tx.run(
    `MATCH (n)
     WHERE n.runId = $runId
        OR (n.runId IS NULL AND any(l IN labels(n) WHERE l STARTS WITH 'ItP'))
     OPTIONAL MATCH (n)-[r]->(m)
     RETURN elementId(n) AS eid, labels(n) AS labels, properties(n) AS props,
            collect(CASE WHEN r IS NULL THEN null ELSE
              { type: type(r), endEid: elementId(m), endId: m.id, props: properties(r) }
            END) AS out`,
    { runId },
  );
  const nodes = new Map<string, NodeSnap>();
  const rels: RelSnap[] = [];
  for (const rec of res.records) {
    const props = rec.get('props') as Rec;
    const key =
      typeof props.id === 'string' ? props.id : `eid:${rec.get('eid')}`;
    const labels = [...(rec.get('labels') as string[])].sort();
    const type = labels.find((l) => l.startsWith('ItP')) ?? labels[0] ?? '?';
    nodes.set(key, {
      key,
      type,
      labels,
      props,
      canon: `${labels.join(':')}${canonProps(props)}`,
    });
    for (const o of rec.get('out') as Array<Rec | null>) {
      if (!o) continue;
      const end =
        typeof o.endId === 'string' ? (o.endId as string) : `eid:${o.endEid}`;
      const rprops = o.props as Rec;
      rels.push({
        start: key,
        type: o.type as string,
        end,
        props: rprops,
        canon: `${key}|${o.type}|${end}|${canonProps(rprops)}`,
      });
    }
  }
  rels.sort((a, b) => (a.canon < b.canon ? -1 : a.canon > b.canon ? 1 : 0));
  return { nodes, rels };
}

/** Type-exact canonical encoding of a stored value. */
export function canonValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (isInt(v)) return `i:${(v as Integer).toString()}`;
  if (typeof v === 'number') return `f:${Object.is(v, -0) ? '-0' : String(v)}`;
  if (typeof v === 'string') return `s:${JSON.stringify(v)}`;
  if (typeof v === 'boolean') return `b:${v}`;
  if (Array.isArray(v)) return `[${v.map(canonValue).join(',')}]`;
  if (isPoint(v)) {
    const p = v as unknown as {
      srid: unknown;
      x: number;
      y: number;
      z?: number;
    };
    return `pt:${canonValue(p.srid)}:${p.x},${p.y},${p.z ?? '-'}`;
  }
  if (isDateTime(v)) return `dt:${String(v)}`;
  if (isLocalDateTime(v)) return `ldt:${String(v)}`;
  if (isDate(v)) return `d:${String(v)}`;
  if (isTime(v)) return `t:${String(v)}`;
  if (isLocalTime(v)) return `lt:${String(v)}`;
  if (isDuration(v)) return `dur:${String(v)}`;
  return `?:${JSON.stringify(v)}`;
}

export function canonProps(props: Rec): string {
  return `{${Object.keys(props)
    .sort()
    .map((k) => `${k}=${canonValue(props[k])}`)
    .join(',')}}`;
}

export interface GraphDiff {
  created: NodeSnap[];
  deleted: NodeSnap[];
  changed: Array<{ before: NodeSnap; after: NodeSnap }>;
  relsAdded: RelSnap[];
  relsRemoved: RelSnap[];
}

export function diffSnapshots(before: Snapshot, after: Snapshot): GraphDiff {
  const created: NodeSnap[] = [];
  const deleted: NodeSnap[] = [];
  const changed: Array<{ before: NodeSnap; after: NodeSnap }> = [];
  for (const [k, a] of after.nodes) {
    const b = before.nodes.get(k);
    if (!b) created.push(a);
    else if (b.canon !== a.canon) changed.push({ before: b, after: a });
  }
  for (const [k, b] of before.nodes) if (!after.nodes.has(k)) deleted.push(b);

  const count = (rels: RelSnap[]) => {
    const m = new Map<string, RelSnap[]>();
    for (const r of rels) m.set(r.canon, [...(m.get(r.canon) ?? []), r]);
    return m;
  };
  const bm = count(before.rels);
  const am = count(after.rels);
  const relsAdded: RelSnap[] = [];
  const relsRemoved: RelSnap[] = [];
  for (const [c, as] of am) {
    const n = as.length - (bm.get(c)?.length ?? 0);
    for (let i = 0; i < n; i++) relsAdded.push(as[i]);
  }
  for (const [c, bs] of bm) {
    const n = bs.length - (am.get(c)?.length ?? 0);
    for (let i = 0; i < n; i++) relsRemoved.push(bs[i]);
  }
  return { created, deleted, changed, relsAdded, relsRemoved };
}

export function isEmptyDiff(d: GraphDiff): boolean {
  return (
    d.created.length === 0 &&
    d.deleted.length === 0 &&
    d.changed.length === 0 &&
    d.relsAdded.length === 0 &&
    d.relsRemoved.length === 0
  );
}

/** Compact, runId-free rendering of a diff for failure messages. */
export function describeDiff(d: GraphDiff, runId: string): string {
  const s = (k: string) => shortId(k, runId);
  const lines = [
    ...d.created.map((n) => `+node ${s(n.key)} ${n.labels.join(':')}`),
    ...d.deleted.map((n) => `-node ${s(n.key)} ${n.labels.join(':')}`),
    ...d.changed.map(
      (c) =>
        `~node ${s(c.before.key)} ${canonProps(c.before.props)} -> ${canonProps(c.after.props)}`,
    ),
    ...d.relsAdded.map((r) => `+rel ${s(r.start)}-[${r.type}]->${s(r.end)}`),
    ...d.relsRemoved.map((r) => `-rel ${s(r.start)}-[${r.type}]->${s(r.end)}`),
  ];
  return redact(lines.join('\n'), runId);
}

/** Replace this run's ids with their `@` placeholders in a message. */
export function redact(text: string, runId: string): string {
  return text.split(`${runId}-`).join('@').split(runId).join('@run');
}

// --- error classification ---------------------------------------------------

/**
 * Rule 1: the OGM either throws `OGMError` before sending, or Neo4j accepts
 * the statement. A `Neo.ClientError.Statement.*` (syntax / semantic /
 * type / argument error) is always a compiler bug; so is any other
 * non-OGM error.
 */
export function classifyError(err: unknown): 'ogm' | 'server' | 'other' {
  if (err instanceof OGMError) return 'ogm';
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && code.startsWith('Neo.')) return 'server';
  return 'other';
}

export function errorSummary(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return `${e?.code ? `${e.code}: ` : ''}${(e?.message ?? String(err)).split('\n').slice(0, 6).join('\n')}`;
}

// --- outcome statistics (PROPERTY_STATS=1) -----------------------------------

/**
 * Tallies case outcomes so a generator that only ever hits `OGMError` (a
 * property with no teeth) is visible: `PROPERTY_STATS=1` prints the tally
 * per property in afterAll.
 */
export class OutcomeStats {
  private counts = new Map<string, number>();
  constructor(private readonly name: string) {}
  add(label: string): void {
    this.counts.set(label, (this.counts.get(label) ?? 0) + 1);
  }
  report(): void {
    if (!process.env.PROPERTY_STATS) return;
    const rows = [...this.counts.entries()].sort((a, b) => b[1] - a[1]);
    process.stdout.write(
      `\n[${this.name}] outcomes:\n${rows.map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`).join('\n')}\n`,
    );
  }
}
