// TYRE-317: a production web build carries no trace of the dev identity
// path. The dev header names and the dev localStorage keys exist only under
// import.meta.env.DEV (web/src/api/client.ts, devTenant.ts, token.ts). This
// reads the built artefact, not the source, because a guard that does not
// fold away at build time still ships the string.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN = ["X-Tenant-ID", "X-User-ID", "tyre.dev."];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function findings(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const text = readFileSync(file, "utf8");
    for (const s of FORBIDDEN) if (text.includes(s)) out.push(`${file}: ${s}`);
  }
  return out;
}

// A gate that finds nothing has to be shown able to find something (TYRE-49).
if (process.argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "dist-dev-strings-"));
  try {
    writeFileSync(join(dir, "clean.js"), "const a = 1;");
    if (findings(dir).length !== 0) throw new Error("a clean file was flagged");
    writeFileSync(join(dir, "dirty.js"), 'h["X-User-ID"] = u;');
    if (findings(dir).length !== 1) throw new Error("a planted header name was missed");
  } catch (err) {
    console.error(`self-test: ${err.message}`);
    process.exit(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("self-test: OK");
  process.exit(0);
}

const dist = resolve(root, "web/dist");
if (!existsSync(dist)) {
  console.error('no web/dist; run "npm run build" in web/ first');
  process.exit(2);
}
let found;
try {
  found = findings(dist);
} catch (err) {
  console.error(`could not read web/dist: ${err.message}`);
  process.exit(2);
}
if (found.length > 0) {
  for (const f of found) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("OK: no dev identity strings in web/dist");
