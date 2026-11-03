#!/usr/bin/env node
// TYRE-379. The Go toolchain is pinned in api/go.mod's go line, the
// Makefile's GO_IMAGE, api/Dockerfile's build stage and each setup-go step in
// ci.yml, and Renovate proposes each bump as its own PR. This refuses a tree
// where those pins name different Go minors, or where one golang image tag
// carries two digests.

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Docs are left out: an ADR or a spec names the version it was written under.
const RELEVANT = [
  /(^|\/)go\.mod$/,
  /^Makefile$/,
  /(^|\/)(Dockerfile|[^/]+\.Dockerfile)$/,
  /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
];
const relevant = (rel) => RELEVANT.some((re) => re.test(rel));

const GO_LINE = /^(go|toolchain)\s+(?:go)?(\d+\.\d+)\S*\s*$/gm;
const IMAGE = /\bgolang:(\d+\.\d+)([\w.-]*)(?:@(sha256:[0-9a-f]{64}))?/g;
const SETUP_GO = /\buses:\s*['"]?actions\/setup-go@/g;
// Block or flow style, so `with: { go-version: '1.27' }` is read too.
const GO_VERSION = /(?<![\w-])go-version:\s*['"]?([^'"\s,}#]*)/g;
const MINOR = /^(\d+\.\d+)(?:\.(?:\d+|x))?$/;

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function check(files) {
  const pins = [];
  const problems = [];
  const digests = new Map();
  let goLines = 0;
  let goImage = false;
  let buildStage = false;
  let setupGo = 0;
  for (const [rel, text] of files) {
    const at = (index) => `${rel}:${lineOf(text, index)}`;
    if (/(^|\/)go\.mod$/.test(rel)) {
      for (const m of text.matchAll(GO_LINE)) {
        pins.push({ where: at(m.index), what: m[0].trim(), minor: m[2] });
        if (m[1] === 'go') goLines += 1;
      }
      continue;
    }
    for (const m of text.matchAll(IMAGE)) {
      const tag = m[1] + m[2];
      pins.push({ where: at(m.index), what: `golang:${tag}`, minor: m[1] });
      const before = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index);
      if (rel === 'Makefile' && /^GO_IMAGE\s*\?=/.test(before)) goImage = true;
      if (/Dockerfile$/.test(rel) && /^FROM\s/i.test(before)) buildStage = true;
      const byDigest = digests.get(tag) ?? new Map();
      const digest = m[3] ?? '(no digest)';
      byDigest.set(digest, [...(byDigest.get(digest) ?? []), at(m.index)]);
      digests.set(tag, byDigest);
    }
    if (/^\.github\/workflows\//.test(rel)) {
      const steps = [...text.matchAll(SETUP_GO)].length;
      const versions = [...text.matchAll(GO_VERSION)];
      setupGo += steps;
      if (versions.length !== steps) {
        problems.push(
          `${rel}: ${steps} setup-go step(s) but ${versions.length} go-version value(s); each setup-go step names its Go minor in go-version`,
        );
      }
      for (const m of versions) {
        const v = MINOR.exec(m[1]);
        if (v) {
          pins.push({ where: at(m.index), what: `go-version: '${m[1]}'`, minor: v[1] });
        } else {
          problems.push(`${at(m.index)}: go-version '${m[1]}' is not a Go release this check can compare`);
        }
      }
    }
  }
  // A gate that finds no pins would report agreement it did not check
  // (TYRE-49), so each pin the toolchain needs must be found.
  if (goLines === 0) problems.push('no go line in any go.mod');
  if (!goImage) problems.push("no golang image on the Makefile's GO_IMAGE line");
  if (!buildStage) problems.push('no Dockerfile builds FROM a golang image');
  if (setupGo === 0) problems.push('no setup-go step in .github/workflows');
  const minors = [...new Set(pins.map((p) => p.minor))];
  if (minors.length > 1) {
    problems.push(`the Go pins name ${minors.length} minors (${minors.join(', ')}):`);
    for (const p of pins) problems.push(`  ${p.where}: ${p.what} -> ${p.minor}`);
  }
  for (const [tag, byDigest] of digests) {
    if (byDigest.size > 1) {
      problems.push(`golang:${tag} carries ${byDigest.size} digests:`);
      for (const [digest, where] of byDigest) problems.push(`  ${digest}: ${where.join(', ')}`);
    }
  }
  return { pins, problems };
}

const args = process.argv.slice(2);
// --self-test plants each disagreement in a tree held in memory and runs the
// same check() the repo run uses, so the gate proves it can fail (TYRE-49).
if (args.includes('--self-test')) {
  const D1 = `sha256:${'1'.repeat(64)}`;
  const D2 = `sha256:${'2'.repeat(64)}`;
  const ci = (a, b) =>
    [
      '      - uses: actions/setup-go@0000000000000000000000000000000000000000 # v7.0.0',
      '        with:',
      `          go-version: ${a}`,
      '      - uses: actions/setup-go@0000000000000000000000000000000000000000 # v7.0.0',
      `        with: { go-version: ${b}, cache-dependency-path: api/go.sum }`,
    ].join('\n');
  const tree = (over) =>
    new Map(
      Object.entries({
        'api/go.mod': 'module x\n\ngo 1.27\n\nrequire (\n)\n',
        Makefile: `# golang:*-alpine has no C toolchain\nGO_IMAGE ?= golang:1.27-alpine@${D1}\n`,
        'api/Dockerfile': `FROM golang:1.27-alpine@${D1} AS build\nFROM gcr.io/distroless/static\n`,
        '.github/workflows/ci.yml': ci("'1.27'", '"1.27"'),
        ...over,
      }).filter(([, text]) => text !== null),
    );
  const planted = { Makefile: `GO_IMAGE ?= golang:1.26-alpine@${D1}\n` };
  const cases = [
    ['the pins agree', {}, null],
    ['go.mod names a patch', { 'api/go.mod': 'module x\n\ngo 1.27.0\n' }, null],
    ['go.mod names a matching toolchain', { 'api/go.mod': 'go 1.27\ntoolchain go1.27.3\n' }, null],
    ['GO_IMAGE moves alone', planted, 'minors'],
    ['the Dockerfile moves alone', { 'api/Dockerfile': `FROM golang:1.28-alpine@${D1}\n` }, 'minors'],
    ['one go-version moves alone', { '.github/workflows/ci.yml': ci("'1.27'", "'1.26'") }, 'minors'],
    ['go.mod moves alone', { 'api/go.mod': 'go 1.28\n' }, 'minors'],
    ['the toolchain line moves alone', { 'api/go.mod': 'go 1.27\ntoolchain go1.28.1\n' }, 'minors'],
    ['the Dockerfile takes another digest', { 'api/Dockerfile': `FROM golang:1.27-alpine@${D2}\n` }, 'digests'],
    ['the Dockerfile drops its digest', { 'api/Dockerfile': 'FROM golang:1.27-alpine\n' }, 'digests'],
    [
      'a setup-go step reads go-version-file',
      { '.github/workflows/ci.yml': ci("'1.27'", "'1.27'").replace(/go-version: '1.27', /, 'go-version-file: api/go.mod, ') },
      'go-version value',
    ],
    ['a go-version is not a release', { '.github/workflows/ci.yml': ci("'1.27'", 'stable') }, 'not a Go release'],
    ['no workflow uses setup-go', { '.github/workflows/ci.yml': null }, 'no setup-go'],
    ['no GO_IMAGE', { Makefile: '# GO_IMAGE ?= golang:1.27-alpine\n' }, 'GO_IMAGE'],
    ['no golang build stage', { 'api/Dockerfile': 'FROM alpine:3\n' }, 'no Dockerfile'],
    ['no go.mod', { 'api/go.mod': null }, 'no go line'],
  ];
  const failures = [];
  for (const [name, over, expect] of cases) {
    const { problems } = check(tree(over));
    const said = problems.join('\n');
    if (expect === null && problems.length > 0) failures.push(`${name}: refused an agreeing tree:\n${said}`);
    if (expect !== null && !said.includes(expect)) failures.push(`${name}: expected "${expect}", got:\n${said || '(nothing)'}`);
  }
  const paths = ['api/go.mod', 'Makefile', 'api/Dockerfile', 'infra/bicep.Dockerfile', '.github/workflows/ci.yml', 'docker-compose.yml'];
  const ignored = ['docs/adr/0016-identity-provider-and-token-to-actor.md', 'api/internal/auth/auth.go', 'web/package.json', 'renovate.json'];
  for (const p of paths) if (!relevant(p)) failures.push(`${p} is not scanned`);
  for (const p of ignored) if (relevant(p)) failures.push(`${p} is scanned`);
  if (failures.length > 0) {
    console.error(`go pins self-test:\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('go pins self-test: a GO_IMAGE moved alone is refused with');
  for (const line of check(tree(planted)).problems) console.log(`  | ${line}`);
  const agreeing = cases.filter(([, , expect]) => expect === null).length;
  console.log(
    `go pins self-test: ${cases.length - agreeing} planted disagreements refused, ${agreeing} agreeing trees pass`,
  );
  process.exit(0);
}

// Untracked files too, as the money gate reads them.
const files = new Map(
  [
    ...new Set(
      execSync('git ls-files && git ls-files --others --exclude-standard', { cwd: root, encoding: 'utf8' }).split('\n'),
    ),
  ]
    .filter((rel) => relevant(rel) && existsSync(join(root, rel)))
    .map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]),
);
const { pins, problems } = check(files);
if (problems.length > 0) {
  for (const line of problems) console.error(line);
  console.error('Move every Go pin to one minor in one change (TYRE-379).');
  process.exit(1);
}
console.log(`go pins: ${pins[0].minor} in ${pins.length} places (${pins.map((p) => p.where).join(', ')})`);
