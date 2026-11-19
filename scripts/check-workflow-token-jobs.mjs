// A job in .github/workflows that grants id-token: write runs no package
// manager, and no workflow grants it at workflow level, so dependency code
// never runs where it could mint the deploy identity's token (TYRE-437,
// TYRE-438).
//
// There is no YAML library at the repo root, so this reads lines and relies on
// the two-space job indent every workflow here uses, as
// scripts/check-workflow-timeouts.mjs does. Text it cannot place is refused,
// never skipped (TYRE-49).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = '.github/workflows';

// Keys may be quoted, and a flow mapping counts as well as a block. Trailing
// comments are read with the line, so they can only refuse.
const grantsToken = /['"]?id-token['"]?\s*:\s*['"]?write/;
const jobWriteAll = /^\s+['"]?permissions['"]?\s*:\s*['"]?write-all\b/;
const jobPermissions = /^ {4}['"]?permissions['"]?\s*:/;
const marginPermissions = /^['"]?permissions['"]?\s*:(.*)$/;
// make, because its targets run npm (make web-bundle). A bash or node call
// to a repo script is not followed: a script that starts npm is a diff a
// reviewer reads.
const packageManager = /\b(npm|npx|pnpm|yarn|corepack|make)\b/;

export function check(files) {
  const jobs = [];
  const problems = [];
  for (const [file, text] of files) {
    const lines = text.split(/\r?\n/);
    let sawJobs = false;
    let inJobs = false;
    let sawMarginPermissions = false;
    let inMarginPermissions = false;
    let workflowGrant = null;
    const fileJobs = [];
    let job = null;

    const close = () => {
      if (job !== null) fileJobs.push(job);
      job = null;
    };

    lines.forEach((line, i) => {
      const n = i + 1;
      if (/^\s*(#.*)?$/.test(line)) return;
      if (/^\S/.test(line)) {
        close();
        inJobs = /^jobs:\s*(#.*)?$/.test(line);
        if (inJobs) sawJobs = true;
        const p = marginPermissions.exec(line);
        inMarginPermissions = p !== null;
        if (p !== null) {
          sawMarginPermissions = true;
          if (workflowGrant === null && (/^\s*['"]?write-all\b/.test(p[1]) || grantsToken.test(p[1]))) workflowGrant = n;
        }
        return;
      }
      if (inMarginPermissions) {
        if (workflowGrant === null && grantsToken.test(line)) workflowGrant = n;
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
        job = { file, id: m[1], line: n, ownPermissions: false, grants: false, tool: null, toolLine: 0 };
        return;
      }
      if (job === null) return;
      if (jobPermissions.test(line)) job.ownPermissions = true;
      if (grantsToken.test(line) || jobWriteAll.test(line)) job.grants = true;
      if (job.tool === null) {
        const m = packageManager.exec(line);
        if (m !== null) {
          job.tool = m[1];
          job.toolLine = n;
        }
      }
    });
    close();

    if (!sawJobs) problems.push(`${file}: no jobs: key at the margin`);
    // Without a margin key, a job with no permissions: of its own inherits
    // the caller's grant, and ci.yml's deploy callers grant id-token: write.
    if (!sawMarginPermissions) {
      problems.push(
        `${file}: no workflow-level permissions: key, so a job without its own inherits the caller's or the repository's; set one (TYRE-438)`,
      );
    }
    if (workflowGrant !== null) {
      problems.push(`${file}:${workflowGrant}: id-token: write at workflow level reaches every job; grant it per job (TYRE-438)`);
    }
    for (const j of fileJobs) {
      const token = j.grants || (!j.ownPermissions && workflowGrant !== null);
      jobs.push({ file: j.file, id: j.id, line: j.line, token });
      if (token && j.tool !== null) {
        problems.push(
          `${file}:${j.line}: job '${j.id}' grants id-token: write and runs ${j.tool} at line ${j.toolLine}; build in a job without the token (TYRE-438)`,
        );
      }
    }
  }
  // A gate that reads nothing would report agreement it did not check.
  if (jobs.length === 0) problems.push(`no job found in ${workflowDir}`);
  return { jobs, problems };
}

const args = process.argv.slice(2);

if (args.includes('--self-test')) {
  const wfWith = (perm, ...jobLines) =>
    ['on:', '  push:', '    branches: [main]', ...perm, 'jobs:', ...jobLines, ''].join('\n');
  const wf = (...jobLines) => wfWith(['permissions:', '  contents: read'], ...jobLines);
  const wfToken = ['permissions:', '  id-token: write', '  contents: read'];
  const job = (id, perm, ...steps) => [
    `  ${id}:`,
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 5',
    ...perm,
    '    steps:',
    ...steps,
  ];
  const token = ['    permissions:', '      id-token: write', '      contents: read'];
  const run = (cmd) => `      - run: ${cmd}`;
  const runsNpm = "job 'web' grants id-token: write and runs npm";
  const cases = [
    ['a token job running npm ci', wf(...job('web', token, run('npm ci'))), [runsNpm]],
    ['a token job running npx vite build', wf(...job('web', token, run('npx vite build'))), ['runs npx']],
    [
      "a token job whose setup-node has cache: npm",
      wf(...job('web', token, '      - uses: actions/setup-node@x', '        with:', '          cache: npm')),
      [runsNpm],
    ],
    ['a token job running pnpm install', wf(...job('web', token, run('pnpm install'))), ['runs pnpm']],
    ['a token job running make web-bundle', wf(...job('web', token, run('make web-bundle'))), ['runs make']],
    ['a token job running corepack enable', wf(...job('web', token, run('corepack enable'))), ['runs corepack']],
    ['a token job running a repo script', wf(...job('api', token, run('bash scripts/deploy-gate.sh x'))), null],
    [
      'no workflow-level permissions:, a job with none of its own running npm ci',
      wfWith([], ...job('web', [], run('npm ci'))),
      ['no workflow-level permissions: key'],
    ],
    [
      'no workflow-level permissions:, every job with its own and no npm',
      wfWith([], ...job('api', token, run('true'))),
      ['no workflow-level permissions: key'],
    ],
    ['a job without the token running npm ci', wf(...job('web', [], run('npm ci'))), null],
    ['a token job running no package manager', wf(...job('api', token, run('az account show'))), null],
    [
      'npm only in a full-line comment of a token job',
      wf(...job('api', token, '      # npm ci runs in web-build', run('true'))),
      null,
    ],
    [
      'id-token: none and npm ci',
      wf(...job('web', ['    permissions:', '      id-token: none'], run('npm ci'))),
      null,
    ],
    ['workflow-level id-token: write', wfWith(wfToken, ...job('api', [], run('true'))), ['at workflow level']],
    ['workflow-level permissions: write-all', wfWith(['permissions: write-all'], ...job('api', [], run('true'))), ['at workflow level']],
    [
      'workflow-level flow mapping { id-token: write }',
      wfWith(['permissions: { id-token: write }'], ...job('api', [], run('true'))),
      ['at workflow level'],
    ],
    [
      "workflow-level id-token: write and a job with no permissions: running npm ci (today's deploy.yml)",
      wfWith(wfToken, ...job('web', [], run('npm ci'))),
      ['at workflow level', runsNpm],
    ],
    [
      'workflow-level id-token: write and a job whose own permissions: { contents: read } runs npm ci',
      wfWith(wfToken, ...job('web', ['    permissions: { contents: read }'], run('npm ci'))),
      ['at workflow level'],
      "job 'web'",
    ],
    ['job-level permissions: write-all with npm ci', wf(...job('web', ['    permissions: write-all'], run('npm ci'))), [runsNpm]],
    [
      'job-level flow mapping { id-token: write, contents: read } with npm ci',
      wf(...job('web', ['    permissions: { id-token: write, contents: read }'], run('npm ci'))),
      [runsNpm],
    ],
    [
      "a quoted key 'id-token': write with npm ci",
      wf(...job('web', ['    permissions:', "      'id-token': write"], run('npm ci'))),
      [runsNpm],
    ],
    ['CR LF line ends, a token job running npm ci', wf(...job('web', token, run('npm ci'))).replace(/\n/g, '\r\n'), [runsNpm]],
    [
      "a reusable-workflow caller granting the token (ci.yml's shape)",
      wf(
        '  deploy-staging:',
        '    permissions:',
        '      id-token: write',
        '      contents: read',
        '    uses: ./.github/workflows/deploy.yml',
        '    with:',
        '      target: staging',
      ),
      null,
    ],
    [
      'a token job and a separate npm job (the target shape)',
      wf(...job('api', token, run('az account show')), ...job('web-build', [], run('npm ci'))),
      null,
    ],
    ['a quoted job id', wf("  'build':", '    runs-on: ubuntu-latest', '    timeout-minutes: 5'), ['cannot read']],
    ['a workflow with no jobs key', 'on: push\npermissions:\n  contents: read\n', ['no jobs: key']],
  ];

  const failures = [];
  let refused = 0;
  let passing = 0;
  for (const [label, text, expects, absent] of cases) {
    const { problems } = check(new Map([['.github/workflows/t.yml', text]]));
    const joined = problems.join('\n');
    if (expects === null) {
      passing++;
      if (problems.length > 0) failures.push(`${label}: expected no problem, got\n${joined}`);
    } else {
      refused++;
      for (const expect of expects) {
        if (!joined.includes(expect)) failures.push(`${label}: expected '${expect}', got\n${joined || '(nothing)'}`);
      }
      if (absent !== undefined && joined.includes(absent)) failures.push(`${label}: '${absent}' must not be named, got\n${joined}`);
    }
  }
  const empty = check(new Map());
  refused++;
  if (!empty.problems.some((p) => p.startsWith('no job found'))) {
    failures.push(`an empty tree: expected a 'no job found' problem, got ${JSON.stringify(empty.problems)}`);
  }

  if (failures.length > 0) {
    console.error(`workflow token jobs self-test:\n${failures.join('\n')}`);
    process.exit(1);
  }
  const sample = check(new Map([['.github/workflows/t.yml', wf(...job('web', token, run('npm ci')))]])).problems[0];
  console.log(`workflow token jobs self-test: a token job running npm is refused with\n  ${sample}`);
  console.log(`workflow token jobs self-test: ${refused} planted cases refused, ${passing} good workflows pass`);
  process.exit(0);
}

const names = readdirSync(join(root, workflowDir))
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();
const files = new Map(names.map((f) => [`${workflowDir}/${f}`, readFileSync(join(root, workflowDir, f), 'utf8')]));
const { jobs, problems } = check(files);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error('Grant id-token: write per job, and run npm only in a job without it (TYRE-438).');
  process.exit(1);
}
const tokenJobs = jobs.filter((j) => j.token).length;
console.log(
  `workflow token jobs: ${jobs.length} jobs read; ${tokenJobs} grant id-token: write and run no package manager`,
);
