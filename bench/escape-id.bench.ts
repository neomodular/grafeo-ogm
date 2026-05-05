/**
 * `escapeIdentifier` micro-benchmark.
 *
 * Every Cypher emission backtick-wraps identifiers (relationship types,
 * labels, property names). The current implementation calls
 * `identifier.replace(/`/g, '``')` unconditionally — which allocates a
 * fresh string even when the identifier contains zero backticks (the
 * 99.99%+ case for any well-named schema).
 *
 * Tier 4 fix F: short-circuit when no backticks are present. The expected
 * win is small (~30ns per call) but multiplied by the dozens of calls
 * per compile, it adds up at high QPS.
 *
 * If this fix doesn't clear the 5% threshold on the where / selection
 * benchmarks (where escapeIdentifier is called many times indirectly),
 * we drop it — micro-opts that don't show up in real workloads aren't
 * worth the code churn.
 */

import { bench, group } from 'mitata';
import { escapeIdentifier } from '../src/utils/validation';

group('escapeIdentifier', () => {
  bench('typical identifier (no backticks)', () => escapeIdentifier('hasStatus'));

  bench('long identifier (no backticks)', () =>
    escapeIdentifier('isThisDrugAvailableForPediatricUseInTheUSA'),
  );

  bench('identifier with one backtick (rare)', () =>
    escapeIdentifier('weird`name'),
  );
});
