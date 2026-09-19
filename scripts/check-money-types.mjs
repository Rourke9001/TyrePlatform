#!/usr/bin/env node
// TYRE-36. Rule 2's Go half, enforced rather than remembered: "no float in
// any money path, grep-clean" was prose until now. Money is scanned as text
// into a string and emitted as a JSON string (api/CLAUDE.md, "Money over the
// wire"); a money-named identifier declared with a float type is what this
// refuses. Keyed on identifiers, never on the type alone, because float64 is
// right for a percentage and a millimetre (capture.go).

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// The schema's own money column names.
const MONEY = /(price|rand_?per_?mm|casing_?value|tread_?value|total_?value|proceeds|at_?risk)/i;
const FLOAT = /\bfloat(32|64)\b/;

// Comments on the line are ignored so a rationale may name both.
function scan(name, source) {
  let hits = 0;
  source.split('\n').forEach((line, i) => {
    const code = line.split('//')[0];
    if (FLOAT.test(code) && MONEY.test(code)) {
      console.error(`${name}:${i + 1}: money identifier typed as a float: ${line.trim()}`);
      hits += 1;
    }
  });
  return hits;
}

const args = process.argv.slice(2);
// --self-test lints a known-bad sample so the gate proves it can fail on
// every run (TYRE-49's rule).
if (args.includes('--self-test')) {
  const control = 'type row struct {\n\tpurchasePrice *float64\n}\n';
  if (scan('(self-test)', control) !== 1) {
    console.error('money gate self-test: the control did not fire');
    process.exit(1);
  }
  console.log('money gate self-test: control fires');
  process.exit(0);
}

// Tracked and untracked alike: the comment checker's blind spot for a file
// not yet staged (docs/lessons.md, 2026-08-27) is not repeated here.
const listed = () =>
  execSync('git ls-files api && git ls-files --others --exclude-standard api', { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.go'));
const files = args.length > 0 ? args : [...new Set(listed())];

let total = 0;
for (const f of files) {
  total += scan(f, readFileSync(f, 'utf8'));
}
if (total > 0) {
  console.error(`${total} money identifier(s) typed as float. Scan numeric as ::text into *string (api/CLAUDE.md).`);
  process.exit(1);
}
console.log(`money gate: ${files.length} Go files, no float on a money path`);
