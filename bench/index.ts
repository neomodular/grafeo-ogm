/**
 * Top-level benchmark entry point. Imports all `*.bench.ts` files (each
 * registers its own `group` / `bench` calls into mitata's global
 * registry) and runs the full suite.
 *
 * Run: `pnpm run bench`
 *
 * To capture a JSON snapshot for before/after comparison:
 *   `pnpm run bench -- --json > bench/snapshots/<label>.json`
 */

import { run } from 'mitata';

// Side-effect imports — each file registers its benchmarks on import.
import './where.bench';
import './selection.bench';
import './result-mapper.bench';
import './mutation.bench';
import './escape-id.bench';
import './policy.bench';

const wantJson = process.argv.includes('--json');

async function main(): Promise<void> {
  await run({
    // `samples: false` strips the per-iteration sample arrays from the
    // JSON output — without it the snapshot file balloons to ~30 MB
    // because every benchmark records thousands of raw timings. We
    // only need the rolled-up stats (avg, p50, p75, p99, min, max)
    // for before/after comparison.
    format: wantJson ? { json: { samples: false, debug: false } } : 'mitata',
    colors: !wantJson,
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
