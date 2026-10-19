#!/usr/bin/env node
/**
 * Fails CI when any live suite under tests/integration/ did not really run.
 *
 * Every live suite is opt-in (`describe.skip` unless NEO4J_URI /
 * NEO4J_APOC_URI / NEO4J_GENAI_URI is set), so a missing or misspelled env
 * var silently turns a suite green. This reads Jest's `--json` report and
 * fails if:
 *   - a test was skipped or left as todo,
 *   - a spec file under tests/integration/ is missing from the report,
 *   - no test ran at all.
 * It checks the outcome, not the env, so it also catches a new gate var or
 * a typo inside a spec file.
 *
 * Usage: node scripts/ci/assert-live-suites-ran.cjs <jest-results.json>
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('usage: assert-live-suites-ran.cjs <jest-results.json>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (err) {
  console.error(`Cannot read Jest report at ${reportPath}: ${err.message}`);
  process.exit(1);
}

const root = path.resolve(__dirname, '..', '..');
const liveDir = path.join(root, 'tests', 'integration');
// Recursive: suites in subdirectories (tests/integration/properties/) must
// be present in the report too, not only the top-level ones.
function specFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? specFiles(path.join(dir, e.name))
        : e.name.endsWith('.spec.ts')
          ? [path.join(dir, e.name)]
          : [],
    )
    .sort();
}
const expected = specFiles(liveDir);

const problems = [];
const seen = new Set();

for (const suite of report.testResults ?? []) {
  const file = path.resolve(suite.name);
  seen.add(file);
  const rel = path.relative(root, file);
  const assertions = suite.assertionResults ?? [];
  const notRun = assertions.filter(
    (a) =>
      a.status === 'pending' || a.status === 'skipped' || a.status === 'todo',
  );
  if (assertions.length === 0) {
    problems.push(`${rel}: no test ran`);
  } else if (notRun.length > 0) {
    problems.push(
      `${rel}: ${notRun.length}/${assertions.length} test(s) skipped (is its env gate set?)`,
    );
  }
}

for (const file of expected) {
  if (!seen.has(file))
    problems.push(`${path.relative(root, file)}: missing from the Jest report`);
}

if ((report.numTotalTests ?? 0) === 0) problems.push('no tests ran at all');

if (problems.length > 0) {
  console.error('Live suites did not all run:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `All ${expected.length} live suites ran: ${report.numPassedTests}/${report.numTotalTests} tests passed, 0 skipped.`,
);
for (const file of expected) console.log(`  ${path.relative(root, file)}`);
