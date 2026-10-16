#!/usr/bin/env node
// TYRE-51. The one writer of both deployed web files: the web origin's
// staticwebapp.config.json, with the API origin filled into its CSP, and the
// config.json the app reads that origin from (ADR-0019; section 4 of
// docs/superpowers/specs/2026-10-16-platform-readiness-design.md). The
// deploy calls it, and so does the production browser check, so both run
// the headers this writes.
//
//   node scripts/write-web-config.mjs --api-origin <origin> --dist <dir>
//   node scripts/write-web-config.mjs --self-test
//
// Exit 0 written, 1 refused (each problem on stderr), 2 usage or a missing
// input.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readEnv } from "./read-env.mjs";

const PLACEHOLDER = "__API_ORIGIN__";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(root, "web/staticwebapp.config.json");
const ENV_FILE = resolve(root, "web/.env.production");

// The app's parseApiOrigin takes any origin; the deployed one is https, with
// a host of letters, digits, dots and hyphens alone. new URL also takes ;, *
// and ' in a host, and each changes what the CSP it is filled into says.
function isHttpsOrigin(o) {
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(o)) return false;
  try {
    const u = new URL(o);
    return u.protocol === "https:" && u.origin === o;
  } catch {
    return false;
  }
}

function connectSources(config) {
  const csp = config.globalHeaders?.["Content-Security-Policy"] ?? "";
  const directive = csp
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .find(([name]) => name === "connect-src");
  return directive ? directive.slice(1) : [];
}

function prepare({ source, envFile, dist, apiOrigin }) {
  const problems = [];
  if (!isHttpsOrigin(apiOrigin)) {
    problems.push(`--api-origin must be an https origin alone, got ${JSON.stringify(apiOrigin)}`);
  }
  if (!existsSync(join(dist, "index.html"))) problems.push(`${dist} has no index.html; build the web first`);
  const text = readFileSync(source, "utf8");
  if (!text.includes(PLACEHOLDER)) {
    problems.push(`${source} does not carry ${PLACEHOLDER}, so its CSP cannot name the API origin`);
    return { problems };
  }
  // split and join, never String.replace, whose replacement string reads $
  // patterns (docs/lessons.md, 2026-09-30).
  const filled = text.split(PLACEHOLDER).join(apiOrigin);
  let config;
  try {
    config = JSON.parse(filled);
  } catch (err) {
    problems.push(`${source} is not JSON once filled: ${err.message}`);
    return { problems };
  }
  for (const key of ["globalHeaders", "navigationFallback"]) {
    if (typeof config[key] !== "object" || config[key] === null) problems.push(`${source} has no ${key}`);
  }
  // The CIAM host in the CSP must be the one the bundle signs in against,
  // or sign-in is blocked on the web origin and nowhere else.
  const authority = readEnv(envFile).VITE_AUTH_AUTHORITY;
  let ciam = null;
  try {
    ciam = new URL(authority).origin;
  } catch {
    problems.push(`${envFile} has no usable VITE_AUTH_AUTHORITY`);
  }
  const connect = connectSources(config);
  if (ciam !== null && !connect.includes(ciam)) {
    problems.push(`the CSP's connect-src does not name ${ciam}, the origin of VITE_AUTH_AUTHORITY`);
  }
  if (problems.length > 0) return { problems };
  return { problems, swa: filled, config: `${JSON.stringify({ apiOrigin })}\n` };
}

function write(prepared, dist) {
  writeFileSync(join(dist, "staticwebapp.config.json"), prepared.swa);
  writeFileSync(join(dist, "config.json"), prepared.config);
}

// A gate that finds nothing has to be shown able to find something (TYRE-49).
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "write-web-config-"));
  const source = join(dir, "staticwebapp.config.json");
  const envFile = join(dir, ".env.production");
  const dist = join(dir, "dist");
  const ciam = "https://idp.test";
  const origin = "https://api.test";
  const sourceText = (connect) =>
    JSON.stringify({
      navigationFallback: { rewrite: "/index.html" },
      globalHeaders: {
        "Content-Security-Policy": `default-src 'self'; connect-src 'self' ${connect}; object-src 'none'`,
      },
    });
  const count = (what, want, got) => {
    if (got.problems.length !== want) {
      throw new Error(`${what}: want ${want} problems, got ${JSON.stringify(got.problems)}`);
    }
  };
  try {
    writeFileSync(source, sourceText(`${PLACEHOLDER} ${ciam}`));
    writeFileSync(envFile, `# a comment\nVITE_AUTH_AUTHORITY=${ciam}/tenant/v2.0\n`);
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    const input = { source, envFile, dist };

    const ok = prepare({ ...input, apiOrigin: origin });
    count("valid input", 0, ok);
    write(ok, dist);
    const config = JSON.parse(readFileSync(join(dist, "config.json"), "utf8"));
    if (JSON.stringify(config) !== JSON.stringify({ apiOrigin: origin })) {
      throw new Error(`config.json is ${JSON.stringify(config)}`);
    }
    const written = readFileSync(join(dist, "staticwebapp.config.json"), "utf8");
    if (written.includes(PLACEHOLDER)) throw new Error("the placeholder survived");
    const connect = connectSources(JSON.parse(written));
    if (!connect.includes(origin) || !connect.includes(ciam)) {
      throw new Error(`connect-src is ${connect.join(" ")}`);
    }

    for (const bad of [`${origin}/`, `${origin}/api`, "http://api.test", ""]) {
      count(`the origin ${JSON.stringify(bad)}`, 1, prepare({ ...input, apiOrigin: bad }));
    }
    // Each is its own URL's origin. The first also ends connect-src early,
    // so the CIAM origin goes missing too and the count is not fixed.
    for (const bad of [`${origin};img-src`, "https://*.test", `${origin}'x`]) {
      const got = prepare({ ...input, apiOrigin: bad });
      if (!got.problems.some((p) => p.startsWith("--api-origin"))) {
        throw new Error(`the origin ${JSON.stringify(bad)} was taken: ${JSON.stringify(got.problems)}`);
      }
    }

    writeFileSync(source, sourceText(`https://api.test ${ciam}`));
    count("a source without the placeholder", 1, prepare({ ...input, apiOrigin: origin }));

    writeFileSync(source, sourceText(`${PLACEHOLDER} https://other-idp.test`));
    count("a CSP that names another CIAM origin", 1, prepare({ ...input, apiOrigin: origin }));

    writeFileSync(source, sourceText(`${PLACEHOLDER} ${ciam}`));
    rmSync(join(dist, "index.html"));
    count("a dist without index.html", 1, prepare({ ...input, apiOrigin: origin }));
  } catch (err) {
    console.error(`self-test: ${err.message}`);
    process.exit(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("self-test: OK");
  process.exit(0);
}

function usage(message) {
  console.error(message);
  console.error("usage: node scripts/write-web-config.mjs --api-origin <origin> --dist <dir> | --self-test");
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--self-test") selfTest();
const opts = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--api-origin", "--dist"].includes(args[i]) || args[i + 1] === undefined) usage(`unexpected ${args[i]}`);
  opts[args[i]] = args[i + 1];
}
if (opts["--api-origin"] === undefined || opts["--dist"] === undefined) usage("--api-origin and --dist are both required");
const dist = resolve(opts["--dist"]);
for (const input of [SOURCE, ENV_FILE, dist]) {
  if (!existsSync(input)) usage(`${input} is missing`);
}
const prepared = prepare({ source: SOURCE, envFile: ENV_FILE, dist, apiOrigin: opts["--api-origin"] });
if (prepared.problems.length > 0) {
  for (const p of prepared.problems) console.error(`REFUSED: ${p}`);
  process.exit(1);
}
write(prepared, dist);
console.log(`wrote ${join(dist, "staticwebapp.config.json")} and ${join(dist, "config.json")} for ${opts["--api-origin"]}`);
