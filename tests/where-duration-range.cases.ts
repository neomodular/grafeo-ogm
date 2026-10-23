/**
 * Shared harness + cases for `where-duration-range.spec.ts` (v2.15.0).
 */
import type { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { permissive } from '../src/policy/types';

export const typeDefs = `
type LbDurTask @node {
  id: ID! @unique
  runId: String
  d: Duration
  ds: [Duration!]
  at: DateTime
  day: Date
  n: Int
  steps: [LbDurStep!]! @relationship(type: "LB_DUR_HAS", direction: OUT, properties: "LbDurWait")
}
type LbDurStep @node {
  id: ID! @unique
  d: Duration
}
type LbDurWait @relationshipProperties {
  wait: Duration
  w: Int
}
`;

export interface Opts {
  strict?: boolean;
  /** A read policy whose `when` partial is this where. */
  policyWhen?: Record<string, unknown>;
}

export function harness(opts: Opts = {}) {
  const session = {
    run: jest.fn().mockResolvedValue({
      records: [],
      summary: { counters: { updates: () => ({}) } },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const driver = {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
  const warnings: string[] = [];
  const logger = { debug: () => {}, warn: (m: string) => warnings.push(m) };
  const policyWhen = opts.policyWhen;
  const ogm = new OGM({
    typeDefs,
    driver,
    logger,
    ...(opts.strict ? { strict: true } : {}),
    ...(policyWhen
      ? {
          policies: {
            LbDurTask: [
              permissive({
                operations: ['read'],
                name: 'p',
                when: () => policyWhen,
              }),
            ],
          },
        }
      : {}),
  });
  const bound = policyWhen ? ogm.withContext({}) : ogm;
  return {
    warnings,
    task: () => bound.model('LbDurTask'),
    /** Every statement sent, in order. */
    statements: () =>
      session.run.mock.calls.map((c) => ({
        cypher: c[0] as string,
        params: c[1] as Record<string, unknown>,
      })),
  };
}

type H = ReturnType<typeof harness>;

const find = (where: Record<string, unknown>) => (h: H) =>
  h.task().find({ where: where as never, selectionSet: '{ id }' });

export type Case = [string, Opts, (h: H) => Promise<unknown>];

/** Duration ranges in every compile path, for a given operator. */
export function durationCases(op: string): Case[] {
  const v = 'P27D';
  return [
    [`root d${op}`, {}, find({ [`d${op}`]: v })],
    [`nested steps_SOME d${op}`, {}, find({ steps_SOME: { [`d${op}`]: v } })],
    [
      `connection node d${op}`,
      {},
      find({ stepsConnection_SOME: { node: { [`d${op}`]: v } } }),
    ],
    [
      `connection edge wait${op}`,
      {},
      find({ stepsConnection_SOME: { edge: { [`wait${op}`]: v } } }),
    ],
    [
      `selection steps(where: d${op})`,
      {},
      (h) =>
        h.task().find({
          selectionSet: `{ id steps(where: { d${op}: "${v}" }) { id } }`,
        }),
    ],
    [
      `selection stepsAggregate(where: d${op})`,
      {},
      (h) =>
        h.task().find({
          selectionSet: `{ id stepsAggregate(where: { d${op}: "${v}" }) { count } }`,
        }),
    ],
    [
      `aggregate() where d${op}`,
      {},
      (h) =>
        h.task().aggregate({
          where: { [`d${op}`]: v } as never,
          aggregate: { count: true },
        }),
    ],
    [`policy when d${op}`, { policyWhen: { [`d${op}`]: v } }, find({})],
    [
      `array-connect where d${op}`,
      {},
      (h) =>
        h.task().update({
          where: { id: 't' } as never,
          connect: {
            steps: [{ where: { node: { [`d${op}`]: v } } }],
          } as never,
        }),
    ],
  ];
}

/** Inputs whose Cypher must not change (in either mode). */
export const UNCHANGED_CASES: Case[] = [
  ['Duration equality', {}, find({ d: 'P1D' })],
  ['Duration _NOT', {}, find({ d_NOT: 'P1D' })],
  ['Duration _IN', {}, find({ d_IN: ['P1D', 'P1M'] })],
  ['Duration _NOT_IN', {}, find({ d_NOT_IN: ['P1D'] })],
  ['Duration list equality', {}, find({ ds: ['P1D'] })],
  ['DateTime _GT', {}, find({ at_GT: '2024-01-01T00:00:00Z' })],
  ['DateTime _LTE', {}, find({ at_LTE: '2024-01-01T00:00:00Z' })],
  ['Date _GTE', {}, find({ day_GTE: '2024-01-01' })],
  ['Int _GT / _LTE', {}, find({ n_GT: 1, n_LTE: 5 })],
  ['edge Int _GTE', {}, find({ stepsConnection_SOME: { edge: { w_GTE: 1 } } })],
  [
    'array-connect where _IN',
    {},
    (h) =>
      h.task().update({
        where: { id: 't' } as never,
        connect: { steps: [{ where: { node: { id_IN: ['s'] } } }] } as never,
      }),
  ],
];

/** Runs a case and returns every statement it sent. */
export async function run(c: Case, strict: boolean) {
  const [, opts, fn] = c;
  const h = harness({ ...opts, strict });
  await fn(h);
  return { statements: h.statements(), warnings: h.warnings };
}
