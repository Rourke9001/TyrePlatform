#!/usr/bin/env node
// TYRE-192. Regression cases for the RULES patterns, each with a negative
// control so a broadened pattern cannot start flagging ordinary prose.
// Fixtures go to a temp directory rather than committed: a positive case is
// text that must fail the gate, and a tracked copy would fail `make lint`'s
// repo-wide scan. Fixture bodies build their comment marker and flagged
// phrase from parts rather than typing them literally, the same reason
// check-comment-style.mjs builds EM_DASH from a code point: this source line
// must not itself contain the text the fixture plants.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT = join(fileURLToPath(new URL('.', import.meta.url)), 'check-comment-style.mjs');
const SLASH = '/';
const C = SLASH + SLASH; // a real line comment marker, kept out of literal form

const CASES = [
  {
    name: 'the-old-with-modifier',
    file: 'modifier.go',
    content: `${C} the ${'old'} instant-formatter ${'behaviour'} double-escaped every value\nfunc f() {}\n`,
    expectRule: 'change-narration',
    expectFail: true,
  },
  {
    name: 'the-old-unrelated-noun',
    file: 'unrelated-noun.go',
    content: `${C} the old depot still owns every fitment created before the move\nfunc f() {}\n`,
    expectFail: false,
  },
  {
    name: 'is-what-made-clause',
    file: 'retrospective.go',
    content: `${C} this ${'is what'} ${'made'} the same button exist five times in the tree\nfunc f() {}\n`,
    expectRule: 'change-narration',
    expectFail: true,
  },
  {
    name: 'is-what-makes-present-tense',
    file: 'present-tense.go',
    content: `${C} this is what makes a pooled connection unsafe across tenants\nfunc f() {}\n`,
    expectFail: false,
  },
  {
    name: 'plan-step-reference',
    file: 'planstep.go',
    content: `${C} ${'Task'} ${'4'} covers the retry budget for this handler\nfunc f() {}\n`,
    expectRule: 'plan-step-reference',
    expectFail: true,
  },
  {
    name: 'lowercase-task-is-domain-vocabulary',
    file: 'scheduled-task.go',
    content: `${C} a background task retries the outbox on the configured interval\nfunc f() {}\n`,
    expectFail: false,
  },
  {
    name: 'plan-step-reference-plural',
    file: 'planstep-plural.go',
    content: `${C} ${'Tasks'} ${'4'} and 5 share the retry budget for this handler\nfunc f() {}\n`,
    expectRule: 'plan-step-reference',
    expectFail: true,
  },
  {
    name: 'plan-step-reference-suffixed',
    file: 'planstep-suffixed.go',
    content: `${C} ${'Task'} ${'4b'} covers the retry budget for this handler\nfunc f() {}\n`,
    expectRule: 'plan-step-reference',
    expectFail: true,
  },
  {
    name: 'lowercase-plural-tasks-is-domain-vocabulary',
    file: 'scheduled-tasks.go',
    content: `${C} the scheduler runs inspection tasks 2 at a time per tenant\nfunc f() {}\n`,
    expectFail: false,
  },
  {
    // Every alternative must sit inside the group the trailing \b closes; one
    // placed outside it loses its own boundary check and can match a prefix
    // of a longer word.
    name: 'trailing-boundary-not-lost-for-earlier-alternatives',
    file: 'versioning.go',
    content: `${C} the new ${'versioning'} scheme adds a monotonic column\nfunc f() {}\n`,
    expectFail: false,
  },
  {
    name: 'before-this-file-clause',
    file: 'beforethis.go',
    content: `${C} ${'before'} ${'this'} ${'file'}, retries had no ceiling at all\nfunc f() {}\n`,
    expectRule: 'change-narration',
    expectFail: true,
  },
  {
    name: 'before-this-noun-not-in-list',
    file: 'beforethisinsert.go',
    content: `${C} the row must exist before this insert runs\nfunc f() {}\n`,
    expectFail: false,
  },
];

const dir = mkdtempSync(join(tmpdir(), 'comment-style-'));
let failures = 0;

try {
  for (const c of CASES) {
    const path = join(dir, c.file);
    writeFileSync(path, c.content);
    let stderr = '';
    let failed = false;
    try {
      execFileSync('node', [SCRIPT, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      failed = true;
      stderr = String(err.stderr ?? '');
    }
    if (failed !== c.expectFail) {
      failures++;
      console.error(
        `${c.name}: expected ${c.expectFail ? 'a finding' : 'no finding'}, got ${failed ? 'a finding' : 'none'}`
      );
      continue;
    }
    if (c.expectFail && c.expectRule && !stderr.includes(`[${c.expectRule}]`)) {
      failures++;
      console.error(`${c.name}: expected rule '${c.expectRule}' in output, got: ${stderr.trim()}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} comment-style regression case(s) failed.`);
  process.exit(1);
}
console.log(`${CASES.length} comment-style regression cases passed.`);
