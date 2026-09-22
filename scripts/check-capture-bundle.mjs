// The capture route must not pay for the manager app (TYRE-238, ADR-0015).
// The figure gated is the JavaScript a first load of the entry executes:
// the entry chunk plus everything it imports statically, followed through
// dist/.vite/manifest.json, gzip bytes. Dynamic imports are excluded on
// purpose: a lazy chunk loads when its route is visited, not before the
// driver's flow. The budget only ratchets down; --record writes the current
// figure, and a rise fails the gate.
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
  console.error(`no manifest at web/dist/.vite/manifest.json; run "npm run build" in web/ first (${err.message})`);
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
