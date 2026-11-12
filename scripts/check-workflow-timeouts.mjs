// Every job with runs-on in .github/workflows carries a job-level
// timeout-minutes (TYRE-478).
//
// Why: a job with no timeout-minutes runs to GitHub's six-hour default when a
// step hangs, and the pipeline lead waits on CI.
// Each value is at least twice the job's slowest passing run, rounded up to 5
// minutes; the measurement behind each is in the design its trailing comment
// cites.
// A job that calls a reusable workflow cannot carry the key, so it passes.
//
// There is no YAML library at the repo root, so this reads lines and relies on
// the two-space job indent every workflow here uses. Text it cannot place is
// refused, never skipped (TYRE-49).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = '.github/workflows';

export function check(files) {
  const jobs = [];
  const problems = [];
  for (const [file, text] of files) {
    const lines = text.split(/\r?\n/);
    let sawJobs = false;
    let inJobs = false;
    let job = null;
    // Line numbers of runs-on keys this pass read as a job's own key.
    const placed = new Set();

    const close = () => {
      if (job === null) return;
      jobs.push(job);
      if (job.runsOn && !job.timeout) {
        problems.push(`${file}:${job.line}: job '${job.id}' has runs-on and no job-level timeout-minutes`);
      } else if (!job.runsOn && !job.uses) {
        problems.push(`${file}:${job.line}: job '${job.id}' has neither runs-on nor uses at the four-space indent`);
      }
      job = null;
    };

    lines.forEach((line, i) => {
      const n = i + 1;
      if (/^\s*(#.*)?$/.test(line)) return;
      if (/^\S/.test(line)) {
        close();
        inJobs = /^jobs:\s*(#.*)?$/.test(line);
        if (inJobs) sawJobs = true;
        return;
      }
      if (!inJobs) return;
      if (/^ {2}\S/.test(line)) {
        close();
        const m = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(#.*)?$/.exec(line);
        if (m === null) {
          problems.push(`${file}:${n}: a job header this check cannot read: '${line}'`);
          return;
        }
        job = { id: m[1], line: n, runsOn: false, uses: false, timeout: false };
        return;
      }
      const key = /^ {4}(runs-on|uses|timeout-minutes):/.exec(line);
      if (key !== null && job !== null) {
        if (key[1] === 'runs-on') {
          job.runsOn = true;
          placed.add(n);
        } else if (key[1] === 'uses') {
          job.uses = true;
        } else {
          job.timeout = true;
        }
      }
    });
    close();

    if (!sawJobs) problems.push(`${file}: no jobs: key at the margin`);
    lines.forEach((line, i) => {
      if (/^(\s*)(- )?runs-on:/.test(line) && !placed.has(i + 1)) {
        problems.push(
          `${file}:${i + 1}: runs-on outside a job's four-space indent; this check reads two-space job indents`,
        );
      }
    });
  }
  // A gate that reads nothing would report agreement it did not check.
  if (jobs.length === 0) problems.push(`no job found in ${workflowDir}`);
  return { jobs, problems };
}

const args = process.argv.slice(2);

if (args.includes('--self-test')) {
  const wf = (...jobLines) =>
    ['on:', '  push:', '    branches: [main]', 'permissions:', '  contents: read', 'jobs:', ...jobLines, ''].join('\n');
  const good = ['  build:', '    runs-on: ubuntu-latest', '    timeout-minutes: 5', '    steps:', '      - run: true'];
  const bare = ['  build:', '    runs-on: ubuntu-latest', '    steps:', '      - run: true'];
  const cases = [
    ['a runs-on job with timeout-minutes', wf(...good), null],
    ['a runs-on job with no timeout-minutes', wf(...bare), "job 'build' has runs-on and no"],
    [
      'a job that calls a reusable workflow',
      wf('  deploy:', '    uses: ./.github/workflows/deploy.yml', '    with:', '      target: staging'),
      null,
    ],
    [
      'two jobs, the second with no timeout',
      wf('  first:', '    runs-on: ubuntu-latest', '    timeout-minutes: 5', '  second:', '    runs-on: ubuntu-latest', '    steps: []'),
      "job 'second' has runs-on",
      "'first'",
    ],
    ['a job id with a digit', wf('  e2e:', '    runs-on: ubuntu-latest', '    steps: []'), "job 'e2e' has runs-on"],
    ['a hyphenated job id', wf('  deploy-web:', '    runs-on: ubuntu-latest', '    steps: []'), "job 'deploy-web' has runs-on"],
    [
      'a step-level timeout-minutes only',
      wf('  build:', '    runs-on: ubuntu-latest', '    steps:', '      - run: true', '        timeout-minutes: 5'),
      "job 'build' has runs-on",
    ],
    [
      'a commented-out timeout-minutes',
      wf('  build:', '    runs-on: ubuntu-latest', '    # timeout-minutes: 5', '    steps: []'),
      "job 'build' has runs-on",
    ],
    ['a comment at the job indent between jobs', wf(...good, '  # the next job deploys', '  deploy:', '    uses: ./x.yml'), null],
    ['runs-on written as a block', wf('  build:', '    runs-on:', '      group: big', '    timeout-minutes: 5'), null],
    ['timeout-minutes as an expression', wf('  build:', '    runs-on: ubuntu-latest', '    timeout-minutes: ${{ inputs.t }}'), null],
    ['timeout-minutes with a trailing comment', wf('  build:', '    runs-on: ubuntu-latest', '    timeout-minutes: 5 # TYRE-478'), null],
    ['CR LF line ends, no timeout', wf(...bare).replace(/\n/g, '\r\n'), "job 'build' has runs-on"],
    ['CR LF line ends, with a timeout', wf(...good).replace(/\n/g, '\r\n'), null],
    ['a four-space job indent', wf('    build:', '      runs-on: ubuntu-latest', '      timeout-minutes: 5'), 'runs-on outside'],
    ['a quoted job id', wf("  'build':", '    runs-on: ubuntu-latest', '    timeout-minutes: 5'), 'cannot read'],
    ['a job with neither runs-on nor uses', wf('  build:', '    steps: []'), 'neither runs-on nor uses'],
    ['a top-level key after jobs ends them', `${wf(...good)}env:\n  runs: x\n`, null],
    ['a workflow with no jobs key', 'on: push\n', 'no jobs: key'],
  ];

  const failures = [];
  let refused = 0;
  let passing = 0;
  for (const [label, text, expect, absent] of cases) {
    const { problems } = check(new Map([['.github/workflows/t.yml', text]]));
    const joined = problems.join('\n');
    if (expect === null) {
      passing++;
      if (problems.length > 0) failures.push(`${label}: expected no problem, got\n${joined}`);
    } else {
      refused++;
      if (!joined.includes(expect)) failures.push(`${label}: expected '${expect}', got\n${joined || '(nothing)'}`);
      if (absent !== undefined && joined.includes(absent)) failures.push(`${label}: '${absent}' must not be named, got\n${joined}`);
    }
  }
  const empty = check(new Map());
  refused++;
  if (!empty.problems.some((p) => p.startsWith('no job found'))) {
    failures.push(`an empty tree: expected a 'no job found' problem, got ${JSON.stringify(empty.problems)}`);
  }

  if (failures.length > 0) {
    console.error(`workflow timeouts self-test:\n${failures.join('\n')}`);
    process.exit(1);
  }
  const sample = check(new Map([['.github/workflows/t.yml', wf(...bare)]])).problems[0];
  console.log(`workflow timeouts self-test: a job with no timeout is refused with\n  ${sample}`);
  console.log(`workflow timeouts self-test: ${refused} planted cases refused, ${passing} good workflows pass`);
  process.exit(0);
}

const names = readdirSync(join(root, workflowDir))
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();
const files = new Map(names.map((f) => [`${workflowDir}/${f}`, readFileSync(join(root, workflowDir, f), 'utf8')]));
const { jobs, problems } = check(files);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error('Give each job with runs-on a job-level timeout-minutes, at least twice its slowest passing run (TYRE-478).');
  process.exit(1);
}
const withRunsOn = jobs.filter((j) => j.runsOn).length;
console.log(
  `workflow timeouts: ${withRunsOn} runs-on jobs carry timeout-minutes; ${jobs.length - withRunsOn} reusable-workflow calls cannot`,
);
