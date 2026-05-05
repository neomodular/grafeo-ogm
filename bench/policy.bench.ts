/**
 * NLS (Node-Level Security) policy hot-path benchmark.
 *
 * Policy-enabled queries pay extra cost:
 * - PolicyResolver lookup (Map.get for the (typeName, op) pair)
 * - compilePolicyClause for each permissive/restrictive
 * - Each policy's `when()` returns a where-partial that gets compiled
 *   through compileConditions (same path as user where)
 * - The compiled policy clause AND-stitches into the user body
 *
 * What we measure here:
 * - Baseline: WhereCompiler.compile WITHOUT policy (already covered
 *   by where.bench.ts but kept here for direct comparison)
 * - WITH a single permissive `when()` partial — the cheapest policy
 * - WITH multiple permissives (OR'd grants)
 * - WITH permissive + restrictive (AND'd)
 * - WITH a permissive whose `when()` returns AND/OR-nested partial
 *   — exercises the recursion path that fix C targets
 * - WITH the `cypher` escape hatch fragment
 */

import { bench, group } from 'mitata';
import { WhereCompiler } from '../src/compilers/where.compiler';
import type {
  Operation,
  PolicyContext,
  PolicyContextBundle,
  ResolvedPolicies,
  Policy,
} from '../src/policy/types';
import { bookNode, schema, MIXED_OPERATORS_WHERE } from './fixtures';

const compiler = new WhereCompiler(schema);

const ctx: PolicyContext = { userId: 'u-123', tenantId: 't-456' };

// Helpers to construct policy bundles with hand-built ResolvedPolicies
// (skipping the resolver — that's measured separately if/when we add
// a resolver bench).
function bundle(resolved: ResolvedPolicies): PolicyContextBundle {
  return {
    ctx,
    operation: 'read' as Operation,
    resolved,
    defaults: { onDeny: 'empty', auditMetadata: false },
    resolveForType: () => null,
  };
}

const NO_POLICY = bundle({
  overridden: false,
  permissives: [],
  restrictives: [],
  evaluated: [],
});

// Single permissive — `when` returns a flat partial
const SIMPLE_PERMISSIVE: Policy = {
  kind: 'permissive',
  operations: ['read'],
  when: (c: PolicyContext) => ({ id: c.userId as string }),
};

// Multiple permissives OR'd
const PERMISSIVE_A: Policy = {
  kind: 'permissive',
  operations: ['read'],
  when: (c: PolicyContext) => ({ id: c.userId as string }),
};
const PERMISSIVE_B: Policy = {
  kind: 'permissive',
  operations: ['read'],
  when: (c: PolicyContext) => ({ title_CONTAINS: c.tenantId as string }),
};

// Restrictive (read-side)
const SIMPLE_RESTRICTIVE: Policy = {
  kind: 'restrictive',
  operations: ['read'],
  when: (c: PolicyContext) => ({ pageCount_GT: 0 }),
};

// Permissive with nested AND/OR in the `when` — exercises fix C path
const NESTED_PERMISSIVE: Policy = {
  kind: 'permissive',
  operations: ['read'],
  when: (c: PolicyContext) => ({
    AND: [
      { id: c.userId as string },
      {
        OR: [
          { title_STARTS_WITH: 'A' },
          { AND: [{ pageCount_GT: 100 }, { rating_GTE: 3.5 }] },
        ],
      },
    ],
  }),
};

// Cypher escape hatch
const CYPHER_PERMISSIVE: Policy = {
  kind: 'permissive',
  operations: ['read'],
  cypher: {
    fragment: (_c, { node }) => `${node}.tenantId = $tenantId`,
    params: (c: PolicyContext) => ({ tenantId: c.tenantId }),
  },
};

const SIMPLE = bundle({
  overridden: false,
  permissives: [SIMPLE_PERMISSIVE],
  restrictives: [],
  evaluated: ['simple-perm'],
});

const TWO_PERMS = bundle({
  overridden: false,
  permissives: [PERMISSIVE_A, PERMISSIVE_B],
  restrictives: [],
  evaluated: ['perm-a', 'perm-b'],
});

const PERM_AND_REST = bundle({
  overridden: false,
  permissives: [SIMPLE_PERMISSIVE],
  restrictives: [SIMPLE_RESTRICTIVE],
  evaluated: ['simple-perm', 'simple-rest'],
});

const NESTED = bundle({
  overridden: false,
  permissives: [NESTED_PERMISSIVE],
  restrictives: [],
  evaluated: ['nested-perm'],
});

const CYPHER = bundle({
  overridden: false,
  permissives: [CYPHER_PERMISSIVE],
  restrictives: [],
  evaluated: ['cypher-perm'],
});

group('NLS policy compile cost', () => {
  bench('user where only — no policy (baseline)', () =>
    compiler.compile(MIXED_OPERATORS_WHERE, 'n', bookNode, undefined, {
      policyContext: NO_POLICY,
    }),
  );

  bench('+ single permissive (flat when)', () =>
    compiler.compile(MIXED_OPERATORS_WHERE, 'n', bookNode, undefined, {
      policyContext: SIMPLE,
    }),
  );

  bench('+ two permissives (OR-grant)', () =>
    compiler.compile(MIXED_OPERATORS_WHERE, 'n', bookNode, undefined, {
      policyContext: TWO_PERMS,
    }),
  );

  bench('+ permissive AND restrictive', () =>
    compiler.compile(MIXED_OPERATORS_WHERE, 'n', bookNode, undefined, {
      policyContext: PERM_AND_REST,
    }),
  );

  bench('+ nested AND/OR permissive (deep when)', () =>
    compiler.compile(MIXED_OPERATORS_WHERE, 'n', bookNode, undefined, {
      policyContext: NESTED,
    }),
  );

  bench('+ cypher escape hatch fragment', () =>
    compiler.compile(MIXED_OPERATORS_WHERE, 'n', bookNode, undefined, {
      policyContext: CYPHER,
    }),
  );
});
