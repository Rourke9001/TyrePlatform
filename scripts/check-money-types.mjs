#!/usr/bin/env node
// TYRE-36. Rule 2's Go half: money is scanned as text into a string
// (api/CLAUDE.md, "Money over the wire"), so a money-named identifier
// declared with a float type is refused. Keyed on identifiers, never on the
// type alone, because float64 is right for a percentage and a millimetre.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// The schema's own money column names.
const MONEY = /(price|rand_?per_?mm|casing_?value|tread_?value|total_?value|proceeds|at_?risk)/i;
const FLOAT = /\bfloat(32|64)\b/;

// Comments and string literals are blanked before matching, so a rationale,
// an error message or a column name in an SQL literal may say both words
// without failing the build. Line-oriented, not a Go parser: it handles
// block comments, interpreted strings and multi-line raw strings, which is
// every shape the tree actually contains.
function strip(source) {
  let raw = false;
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => {
      if (raw) {
        const close = line.indexOf('`');
        if (close === -1) {
          return '';
        }
        raw = false;
        line = line.slice(close + 1);
      }
      line = line.replace(/`[^`]*`/g, '``').replace(/"(?:[^"\\]|\\.)*"/g, '""');
      const open = line.indexOf('`');
      if (open !== -1) {
        raw = true;
        line = line.slice(0, open);
      }
      return line.replace(/\/\/.*$/, '');
    });
}

function scan(name, source) {
  let hits = 0;
  const lines = source.split('\n');
  strip(source).forEach((code, i) => {
    if (FLOAT.test(code) && MONEY.test(code)) {
      console.error(`${name}:${i + 1}: money identifier typed as a float: ${lines[i].trim()}`);
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
  // The negative control: a gate that fails valid code gets switched off, so
  // the three shapes that name both words harmlessly are proven silent.
  const quiet = [
    '// purchasePrice is never a float64 (rule 2)',
    '/* purchasePrice float64 */',
    'const q = "purchasePrice float64"',
    'const s = `SELECT purchase_price::float64`',
  ].join('\n');
  if (scan('(self-test)', quiet) !== 0) {
    console.error('money gate self-test: a comment or literal was read as code');
    process.exit(1);
  }
  console.log('money gate self-test: control fires, comments and literals stay quiet');
  process.exit(0);
}

// Untracked files too: the comment checker's blind spot (docs/lessons.md,
// 2026-08-27) is not repeated here.
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
