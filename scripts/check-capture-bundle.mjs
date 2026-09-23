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

// Depth-first over static imports; a chunk reached twice counts once.
const seen = new Set();
const order = [];
function visit(key) {
  if (seen.has(key)) return;
  seen.add(key);
  order.push(key);
  for (const dep of manifest[key].imports ?? []) visit(dep);
}
visit(entryKey);

// The budget is a ceiling, so a lazy driver module would pass it by
// shrinking the entry; a chunk fetched in front of capture is the round trip
// ADR-0009 (rule 7) rules out. The manifest keys a dynamic entry by its
// source path, which is what this reads, and it refuses --record too.
const reachable = new Set();
function visitAll(key) {
  if (reachable.has(key)) return;
  reachable.add(key);
  const chunk = manifest[key];
  for (const dep of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visitAll(dep);
}
visitAll(entryKey);
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
