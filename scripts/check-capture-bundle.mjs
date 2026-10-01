// The capture route must not pay for the manager app (TYRE-238, ADR-0015).
// Two checks, both read from dist/.vite/manifest.json:
// 1. The entry's static closure, in gzip bytes, stays within
//    web/bundle-budget.json. A lazy chunk loads with its route, so it is not
//    counted; the budget only ratchets down, and --record writes the figure.
// 2. No module under src/capture/ or src/driver/ is reachable from the entry
//    only through a dynamic import (ADR-0009): the driver's flow never waits
//    on a chunk fetch.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "web/dist");
const budgetPath = resolve(root, "web/bundle-budget.json");
const record = process.argv.includes("--record");

// TYRE-317, ADR-0016: the sign-in library loads only when a renewal, a
// sign-in or a sign-out needs it, so a re-record must never take it as an
// ordinary rise. _signoutStart is one of its method names, a property that
// minification keeps.
const LIBRARY_MARKER = "_signoutStart";
const AUTH_CHUNK = "src/auth/oidc.ts";

// Depth-first over static imports (a chunk reached twice counts once), and
// separately over static and dynamic imports together.
function closures(manifest, entryKey) {
  const seen = new Set();
  const order = [];
  (function visit(key) {
    if (seen.has(key)) return;
    seen.add(key);
    order.push(key);
    for (const dep of manifest[key].imports ?? []) visit(dep);
  })(entryKey);
  const reachable = new Set();
  (function visitAll(key) {
    if (reachable.has(key)) return;
    reachable.add(key);
    const chunk = manifest[key];
    for (const dep of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visitAll(dep);
  })(entryKey);
  return { seen, order, reachable };
}

function authChunkFindings(manifest, entryKey, readChunk) {
  const { seen, order, reachable } = closures(manifest, entryKey);
  const out = [];
  if (seen.has(AUTH_CHUNK)) out.push(`${AUTH_CHUNK} is in the entry's static closure`);
  if (!reachable.has(AUTH_CHUNK)) out.push(`${AUTH_CHUNK} is not reachable from the entry at all`);
  for (const key of order) {
    if (readChunk(manifest[key].file).includes(LIBRARY_MARKER)) {
      out.push(`${manifest[key].file} carries oidc-client-ts ("${LIBRARY_MARKER}")`);
    }
  }
  return out;
}

// A guard that finds nothing has to be shown able to find something (TYRE-49).
if (process.argv.includes("--self-test")) {
  const lazy = {
    "index.html": { file: "entry.js", isEntry: true, dynamicImports: [AUTH_CHUNK] },
    [AUTH_CHUNK]: { file: "oidc.js" },
  };
  const eager = {
    "index.html": { file: "entry.js", isEntry: true, imports: [AUTH_CHUNK] },
    [AUTH_CHUNK]: { file: "oidc.js" },
  };
  const absent = { "index.html": { file: "entry.js", isEntry: true } };
  const text = (files) => (file) => files[file] ?? "";
  const cases = [
    ["lazy and clean", authChunkFindings(lazy, "index.html", text({ "oidc.js": LIBRARY_MARKER })), 0],
    ["imported statically", authChunkFindings(eager, "index.html", text({})), 1],
    ["library bundled into the entry", authChunkFindings(lazy, "index.html", text({ "entry.js": LIBRARY_MARKER })), 1],
    ["never reached", authChunkFindings(absent, "index.html", text({})), 1],
  ];
  for (const [name, found, want] of cases) {
    if (found.length !== want) {
      console.error(`self-test: ${name}: expected ${want} finding(s), got ${JSON.stringify(found)}`);
      process.exit(1);
    }
  }
  console.log("self-test: OK");
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(resolve(dist, ".vite/manifest.json"), "utf8"));
} catch (err) {
  console.error(
    `no manifest at web/dist/.vite/manifest.json; run "npm run build" in web/ first (${err.message})`,
  );
  process.exit(2);
}

const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
if (!entryKey) {
  console.error("manifest has no entry chunk");
  process.exit(2);
}

// The budget is a ceiling, so a lazy driver module would pass it by
// shrinking the entry; a chunk fetched in front of capture is the round trip
// ADR-0009 (rule 7) rules out. The manifest keys a dynamic entry by its
// source path, which is what this reads, and it refuses --record too.
const { seen, order, reachable } = closures(manifest, entryKey);

const authFindings = authChunkFindings(manifest, entryKey, (file) =>
  readFileSync(resolve(dist, file), "utf8"),
);
if (authFindings.length > 0) {
  for (const f of authFindings) console.error(`FAIL: ${f}`);
  process.exit(1);
}

const lazyDriver = [...reachable].filter(
  (key) => !seen.has(key) && /^src\/(capture|driver)\//.test(key),
);
if (lazyDriver.length > 0) {
  for (const key of lazyDriver) {
    console.error(
      `FAIL: ${key} is reachable from the entry only through a dynamic import. ` +
        "The capture and driver modules load with the entry (ADR-0009, CLAUDE.md rule 7); import it statically.",
    );
  }
  process.exit(1);
}

const chunks = order.map((key) => {
  const file = manifest[key].file;
  const bytes = gzipSync(readFileSync(resolve(dist, file))).length;
  return { key, file, gzipBytes: bytes };
});
const total = chunks.reduce((sum, c) => sum + c.gzipBytes, 0);

console.log(`entry closure: ${chunks.length} chunks, ${total} gzip bytes`);
for (const c of chunks) console.log(`  ${c.gzipBytes.toString().padStart(8)}  ${c.file}`);

if (record) {
  const budget = {
    entryClosureGzipBytes: total,
    recordedAt: new Date().toISOString().slice(0, 10),
    chunks: chunks.map((c) => c.file),
  };
  writeFileSync(budgetPath, JSON.stringify(budget, null, 2) + "\n");
  console.log(`recorded ${total} to web/bundle-budget.json`);
  process.exit(0);
}

let budget;
try {
  budget = JSON.parse(readFileSync(budgetPath, "utf8"));
} catch {
  console.error("no web/bundle-budget.json; run with --record on a known-good tree first");
  process.exit(2);
}
if (total > budget.entryClosureGzipBytes) {
  console.error(
    `FAIL: entry closure ${total} gzip bytes exceeds the budget ${budget.entryClosureGzipBytes} (recorded ${budget.recordedAt}). ` +
      "Put the new import behind React.lazy, or if the growth is the capture route's own, record it with --record and say why in the PR.",
  );
  process.exit(1);
}
console.log(`OK: within budget ${budget.entryClosureGzipBytes} (recorded ${budget.recordedAt})`);
