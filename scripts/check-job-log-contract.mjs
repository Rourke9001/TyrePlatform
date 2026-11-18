// The daily job's success line and the alert that waits for it name the same
// two values (TYRE-371, spec section 5). api/internal/job/log.go declares the
// `job` field's value as Name and the success event as EventSucceeded;
// infra/platform.bicep's alert counts rows whose parsed job and event fields
// equal them. A drift between the two leaves the alert firing every night, or
// the job writing a line nothing reads.
//
// A lint and not a Go test, because make api-test mounts only api/ into its
// container (Makefile, GO_RUN), so a Go test cannot read infra/.
// It reads the Go source by line and not by parsing: each constant must sit on
// its own line, alone or in a const block. Text it cannot place is refused.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const goPath = 'api/internal/job/log.go';
const bicepPath = 'infra/platform.bicep';

// One value per name, from every match of re in text; a count other than one
// is a problem, never a guess at which match was meant.
function single(text, re, missing, many) {
  const found = [...text.matchAll(re)].map((m) => m[1]);
  if (found.length === 0) return { problem: missing };
  if (found.length > 1) return { problem: many(found.length) };
  return { value: found[0] };
}

function read(goSource, bicepSource) {
  const go = goSource.replace(/\r\n/g, '\n');
  const bicep = bicepSource.replace(/\r\n/g, '\n');
  const constant = (name) =>
    single(
      go,
      new RegExp(`^\\s*(?:const\\s+)?${name}\\s*=\\s*"([^"]*)"`, 'gm'),
      `${goPath} declares no constant ${name} on a line of its own`,
      (n) => `${goPath} names ${n} declarations of ${name}`,
    );
  const field = (name) =>
    single(
      bicep,
      new RegExp(`tostring\\(\\s*\\w+\\.${name}\\s*\\)\\s*==\\s*"([^"]*)"`, 'g'),
      `${bicepPath}: the alert's query names no parsed ${name} field`,
      (n) => `${bicepPath}: the alert's query names ${n} parsed ${name} fields`,
    );
  const pairs = [
    ['job', 'Name', constant('Name'), field('job')],
    ['event', 'EventSucceeded', constant('EventSucceeded'), field('event')],
  ];
  const problems = [];
  for (const [fieldName, constName, fromGo, fromBicep] of pairs) {
    if (fromGo.problem) problems.push(fromGo.problem);
    if (fromBicep.problem) problems.push(fromBicep.problem);
    if (fromGo.problem || fromBicep.problem) continue;
    if (fromGo.value !== fromBicep.value) {
      problems.push(
        `${bicepPath}'s alert matches ${fieldName} "${fromBicep.value}", but ${goPath}'s ${constName} is "${fromGo.value}"`,
      );
    }
  }
  return { problems, job: pairs[0][2].value, event: pairs[1][2].value };
}

export function check(goSource, bicepSource) {
  return read(goSource, bicepSource).problems;
}

const args = process.argv.slice(2);

if (args.includes('--self-test')) {
  const goBlock = [
    'package job',
    '',
    'const (',
    '\tName              = "daily" // the `job` field',
    '\tEventStarted      = "daily_job_started"',
    '\tEventSucceeded    = "daily_job_succeeded" // the alert matches it',
    ')',
    '',
  ].join('\n');
  const goAlone = ['package job', '', 'const Name = "daily"', 'const EventSucceeded = "daily_job_succeeded"', ''].join('\n');
  const query = (where) =>
    [
      "resource dailyJobAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {",
      "          query: '''",
      'ContainerAppConsoleLogs_CL',
      '| extend entry = parse_json(Log_s)',
      `| where ${where}`,
      "'''",
      '}',
      '',
    ].join('\n');
  const agree = query('tostring(entry.job) == "daily" and tostring(entry.event) == "daily_job_succeeded"');
  const cases = [
    ['a const block naming both, as log.go does', goBlock, agree, null],
    ['each constant declared alone', goAlone, agree, null],
    [
      'the query names another job',
      goBlock,
      query('tostring(entry.job) == "nightly" and tostring(entry.event) == "daily_job_succeeded"'),
      ['"nightly"', '"daily"'],
    ],
    [
      'the query names another event',
      goBlock,
      query('tostring(entry.job) == "daily" and tostring(entry.event) == "daily_job_started"'),
      ['"daily_job_started"', '"daily_job_succeeded"'],
    ],
    [
      'the query matches a substring, not a parsed field',
      goBlock,
      query('Log_s has "daily_job_succeeded"'),
      ['names no parsed event field', 'names no parsed job field'],
    ],
    [
      'the query names two job clauses',
      goBlock,
      query('tostring(entry.job) == "daily" and tostring(e.job) == "daily" and tostring(entry.event) == "daily_job_succeeded"'),
      ['names 2'],
    ],
    ['Go source with no EventSucceeded', goBlock.replace(/\tEventSucceeded.*\n/, ''), agree, ['EventSucceeded']],
    ['Go source declaring Name twice', goAlone.replace('const Name', 'const Name = "x"\nconst Name'), agree, ['names 2']],
    ['CR LF line ends, both agree', goBlock.replace(/\n/g, '\r\n'), agree.replace(/\n/g, '\r\n'), null],
  ];

  const failures = [];
  let refused = 0;
  let passing = 0;
  for (const [label, go, bicep, expect] of cases) {
    const problems = check(go, bicep);
    const joined = problems.join('\n');
    if (expect === null) {
      passing++;
      if (problems.length > 0) failures.push(`${label}: expected no problem, got\n${joined}`);
    } else {
      refused++;
      for (const e of expect) {
        if (!joined.includes(e)) failures.push(`${label}: expected '${e}', got\n${joined || '(nothing)'}`);
      }
    }
  }
  if (failures.length > 0) {
    console.error(`job log contract self-test:\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`job log contract self-test: ${refused} planted cases refused, ${passing} agreeing pairs pass`);
  process.exit(0);
}

const { problems, job, event } = read(readFileSync(join(root, goPath), 'utf8'), readFileSync(join(root, bicepPath), 'utf8'));
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error('Change both sides together: the alert waits for the line the job writes (ADR-0025).');
  process.exit(1);
}
console.log(`job log contract: ${bicepPath}'s alert matches job "${job}" and event "${event}" (${goPath})`);
