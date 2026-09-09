#!/usr/bin/env node
// TYRE-22. Deterministic half of the comment standard (docs/comments.md).
//
// Only the mechanically detectable violations live here: history-narration
// phrasing, review-process residue, untracked TODOs, and the prose tells the
// standard's "Prose" section bans (TYRE-237). Judgement calls (why vs what,
// bloat) belong to the /comment-audit pass. A regex guessing at those would
// either miss everything or block legitimate comments, and this check
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
const BLOCK_ONLY = new Set(['.css']);
const HASH = new Set(['.py', '.sh', '.bash', '.yml', '.yaml', '.toml']);
// A bare dotfile has no extension as far as extname() is concerned, so these
// are keyed by name.
const HASH_NAMES = new Set(['Makefile', 'Dockerfile', '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig', '.npmrc']);
const DASH = new Set(['.sql']);

// docs/ and markdown are prose: comparing alternatives and recording history
// is their job, so the narration rules must not apply there.
function exemptPath(p) {
  const norm = p.replace(/\\/g, '/');
  return norm.includes('/docs/') || norm.startsWith('docs/') || norm.endsWith('.md');
}

const ticketOrReqId = /\b[A-Z][A-Z0-9]{1,9}-\d+\b|\bQ\d+\b/;

// Built from code points so this file passes its own check.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const CURLY = String.fromCharCode(0x2018, 0x2019, 0x201c, 0x201d);

// `scope: 'line'` rules read the whole source line, not just its comment:
// a string literal is prose the user reads, so the punctuation tells apply
// there too. `strip` removes the one legal use before the match: a quoted
// lone U+2014 is a display glyph for an absent value, not prose.
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
  {
    name: 'em-dash',
    scope: 'line',
    strip: (s) => s.replace(new RegExp(`(["'\`])${EM_DASH}\\1`, 'g'), ''),
    re: new RegExp(EM_DASH),
    advice: 'em dash in prose; end the sentence or use a comma (docs/comments.md, Prose)',
  },
  {
    name: 'en-dash-as-dash',
    scope: 'line',
    re: new RegExp(`\\s${EN_DASH}\\s`),
    advice: 'spaced en dash used as a dash; end the sentence or use a comma (docs/comments.md, Prose)',
  },
  {
    name: 'curly-quotes',
    scope: 'line',
    re: new RegExp(`[${CURLY}]`),
    advice: 'curly quote; use straight quotes (docs/comments.md, Prose)',
  },
  {
    name: 'filler-vocabulary',
    re: /\b(delv(e|es|ing)|leverag(e|es|ing)|utili[sz](e|es|ing)|facilitat(e|es|ing)|pivotal|testament|tapestry|showcas(e|es|ing)|in order to|it is (important|worth) (to note|noting)|it should be noted)\b/i,
    advice: 'filler or inflated word; use the plain one (docs/comments.md, Prose)',
  },
];

function markersFor(path) {
  const ext = extname(path).toLowerCase();
  if (SLASH.has(ext)) return { line: '//', block: true };
  if (BLOCK_ONLY.has(ext)) return { line: null, block: true };
  if (DASH.has(ext)) return { line: '--', block: true };
  if (HASH.has(ext) || HASH_NAMES.has(basename(path))) return { line: '#', block: false };
  return null;
}

// Line-oriented on purpose: violations are phrases, so nothing is gained by a
// real parser, and a parser per language is exactly the maintenance burden a
// blocking check must not carry. The cost is that a marker inside a string
// literal reads as a comment. Acceptable: the phrase list is narrow enough
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
  if (markers.line !== null) {
    const i = line.indexOf(markers.line);
    if (i !== -1) text += line.slice(i + markers.line.length);
  }
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
    for (const rule of RULES) {
      let subject = rule.scope === 'line' ? line : text;
      if (rule.strip) subject = rule.strip(subject);
      if (!subject) continue;
      const m = rule.re.exec(subject);
      if (!m) continue;
      if (rule.exempt && rule.exempt(subject)) continue;
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
    console.error(`${f.path}:${f.line}: [${f.rule}] "${f.match}": ${f.advice}`);
  }
  console.error(`\n${findings.length} comment(s) violate docs/comments.md. Rephrase rather than suppress.`);
  exit(1);
}
