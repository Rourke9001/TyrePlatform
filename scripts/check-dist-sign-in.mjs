// TYRE-79: a production build carries its sign-in configuration. Without the
// three VITE_AUTH_* values in web/.env.production, authConfigured() folds to
// false (web/src/api/token.ts) and the PWA ships unable to sign anyone in,
// a smaller bundle the budget passes. This reads the built artefact for each
// value and never prints one.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KEYS = ["VITE_AUTH_AUTHORITY", "VITE_AUTH_CLIENT_ID", "VITE_AUTH_API_SCOPE"];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// KEY=VALUE lines only. A form vite reads and this does not, such as an
// inline comment, fails the check rather than passing it.
function readEnv(file) {
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

function problems(envFile, dir) {
  if (!existsSync(envFile)) return [`${envFile} is missing`];
  const env = readEnv(envFile);
  const texts = readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".js"))
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"));
  const out = [];
  for (const key of KEYS) {
    if (!env[key]) out.push(`${key} is missing or empty in ${envFile}`);
    else if (!texts.some((t) => t.includes(env[key]))) out.push(`no built .js file carries ${key}`);
  }
  return out;
}

// A gate that finds nothing has to be shown able to find something (TYRE-49).
if (process.argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "dist-sign-in-"));
  try {
    const envFile = join(dir, ".env.production");
    const dist = join(dir, "dist");
    writeFileSync(envFile, "");
    mkdirSync(dist);
    writeFileSync(join(dist, "a.js"), 'const s = {authority: "https://idp.test/", client_id: "pwa", scope: "api://x/s"};');
    if (problems(envFile, dist).length !== KEYS.length) throw new Error("an empty env file was passed");
    const env = (clientKey) =>
      `VITE_AUTH_AUTHORITY=https://idp.test/\n${clientKey}=pwa\nVITE_AUTH_API_SCOPE=api://x/s\n`;
    writeFileSync(envFile, env("VITE_AUTH_CLIENT_ID"));
    if (problems(envFile, dist).length !== 0) throw new Error("a configured build was flagged");
    writeFileSync(envFile, env("VITE_AUTH_CLIENTID"));
    if (problems(envFile, dist).length !== 1) throw new Error("a renamed key was passed");
    writeFileSync(envFile, env("VITE_AUTH_CLIENT_ID"));
    writeFileSync(join(dist, "a.js"), "const a = 1;");
    if (problems(envFile, dist).length !== KEYS.length) throw new Error("a build without the values was passed");
    rmSync(envFile);
    if (problems(envFile, dist).length !== 1) throw new Error("a missing env file was passed");
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
  found = problems(resolve(root, "web/.env.production"), dist);
} catch (err) {
  console.error(`could not read the build: ${err.message}`);
  process.exit(2);
}
if (found.length > 0) {
  for (const f of found) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("OK: web/dist carries all three VITE_AUTH_* values");
