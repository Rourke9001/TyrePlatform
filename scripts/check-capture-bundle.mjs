// The capture route must not pay for the manager app (TYRE-238, ADR-0015).
// Three checks, all read from dist/.vite/manifest.json:
// 1. The entry's static closure stays within web/bundle-budget.json in three
//    figures: JS and CSS in gzip bytes, fonts in raw bytes (woff and woff2
//    are already compressed). A lazy chunk loads with its route, so it is not
//    counted. A rise fails until --record writes the new figures, with the
//    reason given in the PR. --record-css writes the CSS and font figures and
//    leaves the JS one as it is (TYRE-445).
// 2. No module under src/capture/ or src/driver/ is reachable from the entry
//    only through a dynamic import (ADR-0009): the driver's flow never waits
//    on a chunk fetch.
// 3. oidc-client-ts stays out of the entry (TYRE-317, ADR-0016).
// Every finding is printed before the one exit, so a tolerated rise in one
// figure cannot hide another.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "web/dist");
const budgetPath = resolve(root, "web/bundle-budget.json");
const record = process.argv.includes("--record");
const recordCss = process.argv.includes("--record-css");

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
    for (const dep of [
      ...(chunk.imports ?? []),
      ...(chunk.dynamicImports ?? []),
    ])
      visitAll(dep);
  })(entryKey);
  return { seen, order, reachable };
}

function authChunkFindings(manifest, entryKey, readChunk) {
  const { seen, order, reachable } = closures(manifest, entryKey);
  const out = [];
  if (seen.has(AUTH_CHUNK))
    out.push(`${AUTH_CHUNK} is in the entry's static closure`);
  if (!reachable.has(AUTH_CHUNK))
    out.push(`${AUTH_CHUNK} is not reachable from the entry at all`);
  // A library bump that renamed the marker would otherwise pass vacuously.
  if (
    reachable.has(AUTH_CHUNK) &&
    !readChunk(manifest[AUTH_CHUNK].file).includes(LIBRARY_MARKER)
  ) {
    out.push(
      `${manifest[AUTH_CHUNK].file} no longer carries "${LIBRARY_MARKER}"; the guard cannot see the library`,
    );
  }
  for (const key of order) {
    if (readChunk(manifest[key].file).includes(LIBRARY_MARKER)) {
      out.push(
        `${manifest[key].file} carries oidc-client-ts ("${LIBRARY_MARKER}")`,
      );
    }
  }
  return out;
}

// A file listed by two chunks is one download, so it counts once.
const FONT_FILE = /\.woff2?$/;
function closureAssets(manifest, order, readBytes) {
  const css = new Map();
  const fonts = new Map();
  for (const key of order) {
    for (const file of manifest[key].css ?? [])
      if (!css.has(file)) css.set(file, gzipSync(readBytes(file)).length);
    for (const file of manifest[key].assets ?? [])
      if (FONT_FILE.test(file) && !fonts.has(file))
        fonts.set(file, readBytes(file).length);
  }
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    cssFiles: [...css.keys()],
    fontFiles: [...fonts.keys()],
    cssGzipBytes: sum(css),
    fontBytes: sum(fonts),
  };
}

function budgetFindings(got, budget) {
  const out = [];
  const figures = [
    ["entry closure", "gzip bytes", got.jsGzipBytes, "entryClosureGzipBytes"],
    ["entry CSS", "gzip bytes", got.cssGzipBytes, "entryCssGzipBytes"],
    ["entry fonts", "bytes", got.fontBytes, "entryFontBytes"],
  ];
  for (const [label, unit, value, field] of figures) {
    if (typeof budget[field] !== "number") {
      out.push(
        `web/bundle-budget.json has no ${field}; run --record (or --record-css for the CSS and font figures) on a known-good tree`,
      );
    } else if (value > budget[field]) {
      out.push(
        `${label} ${value} ${unit} exceeds the budget ${budget[field]} (${field}, recorded ${budget.recordedAt}). ` +
          "Put the new import behind React.lazy, or if the growth is the capture route's own, record it with --record and say why in the PR.",
      );
    }
  }
  return out;
}

// A guard that finds nothing has to be shown able to find something (TYRE-49).
if (process.argv.includes("--self-test")) {
  const lazy = {
    "index.html": {
      file: "entry.js",
      isEntry: true,
      dynamicImports: [AUTH_CHUNK],
    },
    [AUTH_CHUNK]: { file: "oidc.js" },
  };
  const eager = {
    "index.html": { file: "entry.js", isEntry: true, imports: [AUTH_CHUNK] },
    [AUTH_CHUNK]: { file: "oidc.js" },
  };
  const absent = { "index.html": { file: "entry.js", isEntry: true } };
  const text = (files) => (file) => files[file] ?? "";
  const cases = [
    [
      "lazy and clean",
      authChunkFindings(
        lazy,
        "index.html",
        text({ "oidc.js": LIBRARY_MARKER }),
      ),
      0,
    ],
    [
      "imported statically",
      authChunkFindings(
        eager,
        "index.html",
        text({ "oidc.js": LIBRARY_MARKER }),
      ),
      2,
    ],
    [
      "library bundled into the entry",
      authChunkFindings(
        lazy,
        "index.html",
        text({ "entry.js": LIBRARY_MARKER, "oidc.js": LIBRARY_MARKER }),
      ),
      1,
    ],
    [
      "library marker gone from the auth chunk",
      authChunkFindings(lazy, "index.html", text({})),
      1,
    ],
    ["never reached", authChunkFindings(absent, "index.html", text({})), 1],
  ];
  const bytes = (files) => (file) => Buffer.from(files[file] ?? "");
  const twice = {
    "index.html": {
      file: "entry.js",
      isEntry: true,
      imports: ["_a"],
      css: ["a.css"],
      assets: ["f.woff2", "f.woff", "logo.png"],
    },
    _a: { file: "a.js", css: ["a.css", "b.css"], assets: ["f.woff2"] },
  };
  const files = {
    "a.css": "a{color:red}".repeat(50),
    "b.css": "b{color:blue}".repeat(50),
    "f.woff2": "WOFF2",
    "f.woff": "WOFF",
    "logo.png": "PNGPNGPNGPNG",
  };
  const sums = closureAssets(twice, ["index.html", "_a"], bytes(files));
  const wantCss =
    gzipSync(Buffer.from(files["a.css"])).length +
    gzipSync(Buffer.from(files["b.css"])).length;
  if (
    sums.cssGzipBytes !== wantCss ||
    sums.fontBytes !== 9 ||
    sums.cssFiles.length !== 2
  ) {
    console.error(
      `self-test: CSS and font sums: expected css ${wantCss} and fonts 9, got ${JSON.stringify(sums)}`,
    );
    process.exit(1);
  }
  const budgetCases = [
    [
      "every figure within budget",
      budgetFindings(
        { jsGzipBytes: 5, cssGzipBytes: 6, fontBytes: 7 },
        { entryClosureGzipBytes: 5, entryCssGzipBytes: 6, entryFontBytes: 7 },
      ),
      0,
    ],
    [
      "CSS alone over budget",
      budgetFindings(
        { jsGzipBytes: 5, cssGzipBytes: 7, fontBytes: 7 },
        { entryClosureGzipBytes: 5, entryCssGzipBytes: 6, entryFontBytes: 7 },
      ),
      1,
    ],
    [
      "JS and CSS both over budget",
      budgetFindings(
        { jsGzipBytes: 6, cssGzipBytes: 7, fontBytes: 7 },
        { entryClosureGzipBytes: 5, entryCssGzipBytes: 6, entryFontBytes: 7 },
      ),
      2,
    ],
    [
      "budget without the CSS and font figures",
      budgetFindings(
        { jsGzipBytes: 5, cssGzipBytes: 6, fontBytes: 7 },
        { entryClosureGzipBytes: 5 },
      ),
      2,
    ],
  ];
  const both = budgetCases[2][1];
  if (!both[0].includes("entry closure") || !both[1].includes("entry CSS")) {
    console.error(
      `self-test: two findings must name both figures, got ${JSON.stringify(both)}`,
    );
    process.exit(1);
  }
  for (const [name, found] of budgetCases) {
    for (const f of found) console.log(`self-test (${name}): ${f}`);
  }
  cases.push(...budgetCases);
  for (const [name, found, want] of cases) {
    if (found.length !== want) {
      console.error(
        `self-test: ${name}: expected ${want} finding(s), got ${JSON.stringify(found)}`,
      );
      process.exit(1);
    }
  }
  console.log("self-test: OK");
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(
    readFileSync(resolve(dist, ".vite/manifest.json"), "utf8"),
  );
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

const findings = authChunkFindings(manifest, entryKey, (file) =>
  readFileSync(resolve(dist, file), "utf8"),
).map((f) => `FAIL: ${f}`);

const lazyDriver = [...reachable].filter(
  (key) => !seen.has(key) && /^src\/(capture|driver)\//.test(key),
);
for (const key of lazyDriver) {
  findings.push(
    `FAIL: ${key} is reachable from the entry only through a dynamic import. ` +
      "The capture and driver modules load with the entry (ADR-0009, CLAUDE.md rule 7); import it statically.",
  );
}

const chunks = order.map((key) => {
  const file = manifest[key].file;
  const bytes = gzipSync(readFileSync(resolve(dist, file))).length;
  return { key, file, gzipBytes: bytes };
});
const total = chunks.reduce((sum, c) => sum + c.gzipBytes, 0);
const assets = closureAssets(manifest, order, (file) =>
  readFileSync(resolve(dist, file)),
);

console.log(`entry closure: ${chunks.length} chunks, ${total} gzip bytes`);
for (const c of chunks)
  console.log(`  ${c.gzipBytes.toString().padStart(8)}  ${c.file}`);
console.log(
  `entry CSS: ${assets.cssFiles.length} files, ${assets.cssGzipBytes} gzip bytes`,
);
console.log(
  `entry fonts: ${assets.fontFiles.length} files, ${assets.fontBytes} bytes`,
);

let budget = null;
try {
  budget = JSON.parse(readFileSync(budgetPath, "utf8"));
} catch {
  budget = null;
}

if (record || recordCss) {
  if (findings.length > 0) {
    for (const f of findings) console.error(f);
    process.exit(1);
  }
  if (recordCss && !budget) {
    console.error(
      "no web/bundle-budget.json; --record-css keeps its JS figure, so run --record first",
    );
    process.exit(2);
  }
  const next = record
    ? {
        entryClosureGzipBytes: total,
        entryCssGzipBytes: assets.cssGzipBytes,
        entryFontBytes: assets.fontBytes,
        recordedAt: new Date().toISOString().slice(0, 10),
        chunks: chunks.map((c) => c.file),
      }
    : {
        ...budget,
        entryCssGzipBytes: assets.cssGzipBytes,
        entryFontBytes: assets.fontBytes,
      };
  writeFileSync(budgetPath, JSON.stringify(next, null, 2) + "\n");
  console.log(
    `recorded ${record ? `${total} JS, ` : ""}${assets.cssGzipBytes} CSS and ${assets.fontBytes} font bytes to web/bundle-budget.json`,
  );
  process.exit(0);
}

if (!budget) {
  console.error(
    "no web/bundle-budget.json; run with --record on a known-good tree first",
  );
  process.exit(2);
}
for (const f of budgetFindings(
  {
    jsGzipBytes: total,
    cssGzipBytes: assets.cssGzipBytes,
    fontBytes: assets.fontBytes,
  },
  budget,
))
  findings.push(`FAIL: ${f}`);
if (findings.length > 0) {
  for (const f of findings) console.error(f);
  process.exit(1);
}
console.log(
  `OK: within budget ${budget.entryClosureGzipBytes} JS, ${budget.entryCssGzipBytes} CSS, ${budget.entryFontBytes} fonts (recorded ${budget.recordedAt})`,
);
