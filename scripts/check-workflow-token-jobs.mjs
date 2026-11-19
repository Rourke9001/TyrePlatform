// A job in .github/workflows that grants id-token: write runs no package
// manager, and no workflow grants it at workflow level, so dependency code
// never runs where it could mint the deploy identity's token (TYRE-437,
// TYRE-438).
//
// The build reaches the token job as an artifact, so where a job waits on an
// environment's approval and a job downloads an artifact, every upload keeps
// its artifact for as long as the run can wait (TYRE-438).
//
// There is no YAML library at the repo root, so this reads lines and relies on
// the two-space job indent every workflow here uses, as
// scripts/check-workflow-timeouts.mjs does. Text it cannot place is refused
// (TYRE-49), and an alias is such text: it is read where it is anchored, not
// where it is used. A job indented deeper than two spaces is not read, and
// the timeout check refuses its runs-on.
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
const aliasName = /^\*([^\s,[\]{}#]+)\s*(?:$|[,\]}#])/;
const environmentKey = /^ {4}['"]?environment['"]?\s*:/;
const uploadAction = /\buses['"]?\s*:\s*['"]?actions\/upload-artifact@/;
const downloadAction = /\buses['"]?\s*:\s*['"]?actions\/download-artifact@/;
const retentionKey = /(?:^|[\s{,])['"]?retention-days['"]?\s*:\s*([^\s,}#]*)/;
// A run lives up to 35 days, approval waits included
// (docs.github.com/en/actions/reference/limits, read 19 Nov 2026).
const runDays = 35;

// The index just past the quote that closes a scalar, or -1 when it runs on.
function closeQuote(line, from, quote) {
  for (let i = from; i < line.length; i++) {
    if (quote === '"' && line[i] === '\\') i++;
    else if (line[i] === quote) {
      if (quote === "'" && line[i + 1] === "'") i++;
      else return i + 1;
    }
  }
  return -1;
}

// A star is an alias only where a node opens; this reads one that opens a
// value after ': ', a list item after '- ', or an entry after '[', '{' or ','
// in a flow collection. A quoted scalar and a block scalar's lines are text,
// so shell in a run block is never read as one (YAML 1.2.2 7.1, TYRE-438).
function readAlias(line, y) {
  if (/^\s*$/.test(line)) return null;
  const indent = /^ */.exec(line)[0].length;
  if (y.quote === null && y.block !== null) {
    if (indent > y.block || /^\s*#/.test(line)) return null;
    y.block = null;
  }
  let lineStart = y.quote === null && y.depth === 0;
  if (lineStart) y.open = true;
  let owner = indent;
  let found = null;
  let i = 0;
  while (i < line.length) {
    if (y.quote !== null) {
      i = closeQuote(line, i, y.quote);
      if (i < 0) return found;
      y.quote = null;
      // A quoted key in a flow mapping may take its ':' with no space
      // (YAML 1.2.2 7.4.2).
      if (line[i] === ':') {
        y.open = true;
        i++;
      }
      continue;
    }
    const c = line[i];
    const gap = i + 1 >= line.length || /\s/.test(line[i + 1]);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return found;
    if (y.open) {
      if (c === '*') {
        const m = aliasName.exec(line.slice(i));
        if (m !== null && !lineStart && found === null) found = m[1];
        i += /^\*[^\s,[\]{}]*/.exec(line.slice(i))[0].length;
        y.open = false;
        lineStart = false;
        continue;
      }
      if (c === '-' && gap) {
        owner = i++;
        lineStart = false;
        continue;
      }
      if (c === '&' || c === '!') {
        i += /^[^\s,[\]{}]*/.exec(line.slice(i))[0].length;
        continue;
      }
      if (c === '[' || c === '{') {
        y.depth++;
        i++;
        lineStart = false;
        continue;
      }
      if (y.depth === 0 && (c === '|' || c === '>')) {
        y.block = owner;
        return found;
      }
      if (y.depth === 0) owner = i;
      y.open = false;
      lineStart = false;
      if (c === '"' || c === "'") {
        y.quote = c;
        i++;
        continue;
      }
    }
    if (c === ':' && (gap || (y.depth > 0 && /[,[\]{}]/.test(line[i + 1])))) y.open = true;
    else if (y.depth > 0 && c === ',') y.open = true;
    else if (y.depth > 0 && (c === ']' || c === '}')) y.depth--;
    i++;
  }
  return found;
}

export function check(files) {
  const jobs = [];
  const problems = [];
  let keptUploads = 0;
  for (const [file, text] of files) {
    const lines = text.split(/\r?\n/);
    let sawJobs = false;
    let inJobs = false;
    let sawMarginPermissions = false;
    let inMarginPermissions = false;
    let workflowGrant = null;
    const fileJobs = [];
    let job = null;
    // A step runs from its '- ' line to the next line at or left of the dash.
    const uploads = [];
    let step = null;

    const closeStep = () => {
      if (step !== null && step.upload) uploads.push(step);
      step = null;
    };
    const close = () => {
      closeStep();
      if (job !== null) fileJobs.push(job);
      job = null;
    };

    const yaml = { block: null, depth: 0, open: true, quote: null };

    lines.forEach((line, i) => {
      const n = i + 1;
      const alias = readAlias(line, yaml);
      if (alias !== null) {
        problems.push(`${file}:${n}: a YAML alias '*${alias}', which this check cannot read where it is used; write the value out (TYRE-438)`);
      }
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
        job = {
          file,
          id: m[1],
          line: n,
          ownPermissions: false,
          grants: false,
          tool: null,
          toolLine: 0,
          environment: false,
          downloads: false,
        };
        return;
      }
      if (job === null) return;
      if (step !== null && /^ */.exec(line)[0].length <= step.dash) closeStep();
      const item = /^( *)- /.exec(line);
      if (step === null && item !== null) step = { dash: item[1].length, upload: false, line: n, retention: null, retentionLine: n };
      if (step !== null) {
        if (uploadAction.test(line)) {
          step.upload = true;
          step.line = n;
        }
        const r = retentionKey.exec(line);
        if (r !== null && step.retention === null) {
          step.retention = r[1];
          step.retentionLine = n;
        }
      }
      if (environmentKey.test(line)) job.environment = true;
      if (downloadAction.test(line)) job.downloads = true;
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
    if (fileJobs.some((j) => j.environment) && fileJobs.some((j) => j.downloads)) {
      for (const u of uploads) {
        const days = u.retention === null ? null : /^(['"]?)(\d+)\1$/.exec(u.retention);
        if (u.retention === null) {
          problems.push(
            `${file}:${u.line}: an artifact upload with no retention-days, so the repository's setting decides whether it outlives an approval wait here; set at least ${runDays} (TYRE-438)`,
          );
        } else if (days === null) {
          problems.push(`${file}:${u.retentionLine}: a retention-days this check cannot read: '${u.retention}'`);
        } else if (Number(days[2]) < runDays) {
          problems.push(
            `${file}:${u.retentionLine}: an artifact upload with retention-days ${days[2]}, under ${runDays}: a job here downloads it after an environment's approval, and a run can wait ${runDays} days (TYRE-438)`,
          );
        } else {
          keptUploads++;
        }
      }
    }
  }
  // A gate that reads nothing would report agreement it did not check.
  if (jobs.length === 0) problems.push(`no job found in ${workflowDir}`);
  return { jobs, problems, keptUploads };
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
  const env = '    environment: production';
  const upload = (...withLines) => ['      - uses: actions/upload-artifact@x', '        with:', '          name: web-dist', ...withLines];
  const download = ['      - uses: actions/download-artifact@x', '        with:', '          name: web-dist'];
  const behindEnv = job('web', [...token, env], ...download);
  const handoff = (...withLines) => wf(...job('web-build', [], run('npm ci'), ...upload(...withLines)), ...behindEnv);
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
    [
      'a job whose permissions: is an alias of a token grant, running npm ci',
      wf(
        ...job('api', ['    permissions: &tok', '      id-token: write', '      contents: read'], run('true')),
        ...job('web', ['    permissions: *tok'], run('npm ci')),
      ),
      ["alias '*tok'"],
    ],
    [
      'a merge key of a token grant, running npm ci',
      wf(...job('api', ['    permissions: &tok', '      id-token: write'], run('true')), ...job('web', ['    permissions:', '      <<: *tok'], run('npm ci'))),
      ["alias '*tok'"],
    ],
    [
      'id-token: an alias of write, in a flow mapping, running npm ci',
      wf(...job('api', ['    permissions:', '      contents: &w write'], run('true')), ...job('web', ['    permissions: { id-token: *w }'], run('npm ci'))),
      ["alias '*w'"],
    ],
    [
      "a token job's run: an alias of npm ci",
      wf(...job('web-build', [], '      - run: &build npm ci'), ...job('web', token, '      - run: *build')),
      ["alias '*build'"],
    ],
    ['an anchor with no alias', wf(...job('api', ['    permissions: &tok', '      id-token: write'], run('true'))), null],
    [
      "shell globs in a token job's run block",
      wf(...job('api', token, '      - run: |', '          ls *.yml "${a[*]}"', '          case "$x" in', '            *"not found"*) ;;', '            *) exit 1 ;;', '          esac')),
      null,
    ],
    [
      "shell text shaped like an alias in a run: | block",
      wf(
        ...job(
          'api',
          token,
          '      - run: |',
          "          sed 's/, */,/g' file",
          '          echo "Note: *important*"',
          "          grep -E ': *x$'",
          '          echo "files: *.yml"',
        ),
      ),
      null,
    ],
    ['shell text shaped like an alias in a run: >- block', wf(...job('api', token, '      - run: >-', '          echo found: *.yml', "          sed 's/, */,/g' f")), null],
    ["a one-line run: with a comma before a star", wf(...job('api', token, run("sed 's/, */,/g' f"))), null],
    [
      'an alias in the step after a run: | block',
      wf(...job('web-build', [], '      - run: &build npm ci'), ...job('web', token, '      - run: |', '          echo "a: *b"', '      - run: *build')),
      ["alias '*build'"],
    ],
    ["an alias after a comma on a flow sequence's second line", wf(...job('web', ['    needs: [a,', '      b, *c]'], run('true'))), ["alias '*c'"]],
    [
      "an artifact kept 1 day and downloaded behind an environment (deploy.yml's web-dist)",
      handoff('          retention-days: 1'),
      ['retention-days 1, under 35'],
    ],
    ['an artifact kept 34 days, quoted', handoff("          retention-days: '34'"), ['retention-days 34, under 35']],
    ['an artifact kept 35 days', handoff('          retention-days: 35 # the run limit'), null],
    ['an artifact with no retention-days', handoff(), ['no retention-days']],
    ['retention-days as an expression', handoff('          retention-days: ${{ inputs.days }}'), ['retention-days this check cannot read']],
    [
      'retention-days 1 in a flow mapping',
      wf(...job('web-build', [], '      - uses: actions/upload-artifact@x', '        with: { name: web-dist, retention-days: 1 }'), ...behindEnv),
      ['retention-days 1, under 35'],
    ],
    [
      'retention-days 1 in a step whose with: comes before its uses:',
      wf(
        ...job('web-build', [], '      - with:', '          name: web-dist', '          retention-days: 1', '        uses: actions/upload-artifact@x'),
        ...behindEnv,
      ),
      ['retention-days 1, under 35'],
    ],
    [
      'retention-days 1 on a step after the upload does not count for it',
      wf(...job('web-build', [], ...upload(), '      - uses: some/action@x', '        with:', '          retention-days: 1'), ...behindEnv),
      ['no retention-days'],
    ],
    [
      "an artifact kept 7 days where no job waits on an environment (ci.yml's traces)",
      wf(...job('e2e', [], run('npx playwright test'), '      - uses: actions/upload-artifact@x', '        with:', '          retention-days: 7')),
      null,
    ],
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
const { jobs, problems, keptUploads } = check(files);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(
    `Grant id-token: write per job, run npm only in a job without it, and keep an artifact a job downloads after an approval for ${runDays} days (TYRE-438).`,
  );
  process.exit(1);
}
const tokenJobs = jobs.filter((j) => j.token).length;
console.log(
  `workflow token jobs: ${jobs.length} jobs read; ${tokenJobs} grant id-token: write and run no package manager; artifact uploads behind an approval that keep ${runDays} days or more: ${keptUploads}`,
);
