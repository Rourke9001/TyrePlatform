#!/usr/bin/env node
// TYRE-22. Deterministic half of the comment standard (docs/comments.md).
//
// Only the mechanically detectable violations live here: history-narration
// phrasing, review-process residue, untracked TODOs. Judgement calls (why vs
// what, bloat) belong to the /comment-audit pass — a regex guessing at those
// would either miss everything or block legitimate comments, and this check
// blocks, so precision beats recall throughout.
//
// Runs three ways off the same rule set: per-file from the Claude Code edit
// hook (pass file paths as args), across all tracked files from `make lint`
// and CI (no args). One implementation so the hook and CI cannot disagree.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { argv, exit } from 'node:process';
import { basename, extname } from 'node:path';

const SLASH = new Set(['.go', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.bicep']);
const HASH = new Set(['.py', '.sh', '.bash', '.yml', '.yaml', '.toml', '.npmrc']);
const HASH_NAMES = new Set(['Makefile', 'Dockerfile', '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig']);
const DASH = new Set(['.sql']);

// docs/ and markdown are prose: comparing alternatives and recording history
// is their job, so the narration rules must not apply there.
function exemptPath(p) {
  const norm = p.replace(/\\/g, '/');
  return norm.includes('/docs/') || norm.startsWith('docs/') || norm.endsWith('.md');
}

const ticketOrReqId = /\b[A-Z][A-Z0-9]{1,9}-\d+\b|\bQ\d+\b/;

const RULES = [
  {
    name: 'change-narration',
    re: /\b(previously|used to (be|do|have|use|call|run|return)|the old (way|version|code|implementation|behaviou?r)|renamed from|moved here from|refactored (from|out of)|instead of the old|(as|like) before|no longer(?! than)|the (new|previous) (version|implementation))\b/i,
    advice: 'narrates code history; state the constraint the current code satisfies (git holds the history)',
  },
  {
    name: 'process-residue',
    re: /\b(as discussed|per (the )?review|addressing (review )?feedback|review comment)\b/i,
    advice: 'references a conversation the reader cannot see; keep the conclusion, drop the process',
  },
  {
    name: 'untracked-todo',
    re: /\b(TODO|FIXME|HACK|XXX)\b/,
    advice: 'needs a ticket or requirement ID on the same line; an untracked TODO is a decision nobody made',
    exempt: (text) => ticketOrReqId.test(text),
  },
];

function markersFor(path) {
  const ext = extname(path).toLowerCase();
  if (SLASH.has(ext)) return { line: '//', block: true };
  if (DASH.has(ext)) return { line: '--', block: true };
  if (HASH.has(ext) || HASH_NAMES.has(basename(path))) return { line: '#', block: false };
  return null;
}

// Line-oriented on purpose: violations are phrases, so nothing is gained by a
// real parser, and a parser per language is exactly the maintenance burden a
// blocking check must not carry. The cost is that a marker inside a string
// literal reads as a comment — acceptable, the phrase list is narrow enough
// that a string tripping it deserves a second look anyway.
function commentTextOf(line, markers, state) {
  let text = '';
  if (state.inBlock) {
    const end = line.indexOf('*/');
    if (end === -1) return { text: line, state };
    text += line.slice(0, end) + ' ';
    line = line.slice(end + 2);
    state.inBlock = false;
  }
  const start = line.indexOf('/*');
  if (markers.block && start !== -1) {
    const end = line.indexOf('*/', start + 2);
    if (end === -1) {
      state.inBlock = true;
      return { text: text + line.slice(start + 2), state };
    }
    text += line.slice(start + 2, end) + ' ';
    line = line.slice(0, start) + line.slice(end + 2);
  }
  const i = line.indexOf(markers.line);
  if (i !== -1) text += line.slice(i + markers.line.length);
  return { text, state };
}

function checkFile(path) {
  const markers = markersFor(path);
  if (!markers || exemptPath(path)) return [];
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const findings = [];
  let state = { inBlock: false };
  content.split(/\r?\n/).forEach((line, idx) => {
    const r = commentTextOf(line, markers, state);
    state = r.state;
    const text = r.text.trim();
    if (!text) return;
    for (const rule of RULES) {
      const m = rule.re.exec(text);
      if (!m) continue;
      if (rule.exempt && rule.exempt(text)) continue;
      findings.push({ path, line: idx + 1, rule: rule.name, match: m[0], advice: rule.advice });
    }
  });
  return findings;
}

const files = argv.slice(2).length
  ? argv.slice(2)
  : execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);

const findings = files.flatMap(checkFile);

if (findings.length) {
  for (const f of findings) {
    console.error(`${f.path}:${f.line}: [${f.rule}] "${f.match}" — ${f.advice}`);
  }
  console.error(`\n${findings.length} comment(s) violate docs/comments.md. Rephrase rather than suppress.`);
  exit(1);
}
