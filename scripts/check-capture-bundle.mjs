// The capture route must not pay for the manager app (TYRE-238, ADR-0015).
// web/CLAUDE.md, The design system, lists what this checks.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "web/dist");
const budgetPath = resolve(root, "web/bundle-budget.json");
const record = process.argv.includes("--record");
const recordCss = process.argv.includes("--record-css");

// U175, ADR-0016's amendment: the driver's renewal, sign-in and sign-out wait
// on the sign-in library, so it ships in the entry, never in a chunk fetched
// later that can fail and stay failed. _signoutStart is one of its method
// names, a property that minification keeps.
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

function authLibraryFindings(manifest, entryKey, readChunk) {
  const { seen, order } = closures(manifest, entryKey);
  const out = [];
  // Without the marker anywhere in the closure, a renamed marker fails here
  // rather than passing vacuously.
  if (
    !order.some((key) => readChunk(manifest[key].file).includes(LIBRARY_MARKER))
  )
    out.push(
      `the entry's static closure does not carry oidc-client-ts ("${LIBRARY_MARKER}"), so a renewal, sign-in or sign-out would wait on a chunk fetch (U175)`,
    );
  for (const [key, chunk] of Object.entries(manifest)) {
    if (seen.has(key) || !chunk.file.endsWith(".js")) continue;
    if (readChunk(chunk.file).includes(LIBRARY_MARKER))
      out.push(
        `${chunk.file} carries oidc-client-ts ("${LIBRARY_MARKER}") outside the entry's static closure`,
      );
  }
  // Vite inlines a static import, so this key exists only if a regression
  // splits the module out again.
  if (manifest[AUTH_CHUNK] && !seen.has(AUTH_CHUNK))
    out.push(`${AUTH_CHUNK} is reachable only through a dynamic import`);
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
  // A budget recorded before cssRecordedAt existed dates every figure by
  // recordedAt.
  const cssDate = budget.cssRecordedAt ?? budget.recordedAt;
  const figures = [
    [
      "entry closure",
      "gzip bytes",
      got.jsGzipBytes,
      "entryClosureGzipBytes",
      budget.recordedAt,
      "--record",
    ],
    [
      "entry CSS",
      "gzip bytes",
      got.cssGzipBytes,
      "entryCssGzipBytes",
      cssDate,
      "--record-css",
    ],
    [
      "entry fonts",
      "bytes",
      got.fontBytes,
      "entryFontBytes",
      cssDate,
      "--record-css",
    ],
  ];
  for (const [label, unit, value, field, date, flag] of figures) {
    if (typeof budget[field] !== "number") {
      out.push(
        `web/bundle-budget.json has no ${field}; run --record (or --record-css for the CSS and font figures) on a known-good tree`,
      );
    } else if (value > budget[field]) {
      out.push(
        `${label} ${value} ${unit} exceeds the budget ${budget[field]} (${field}, recorded ${date}). ` +
          `Put the new import behind React.lazy (never oidc-client-ts, U175), or if the growth is the capture route's own, record it with ${flag} and say why in the PR.`,
      );
    }
  }
  return out;
}

// A missing budget and one that does not parse are refused apart: a merge
// conflict in a file re-recorded by PR after PR is not a missing file.
function loadBudget(readText) {
  let text;
  try {
    text = readText();
  } catch (err) {
    return {
      budget: null,
      problem:
        err.code === "ENOENT"
          ? "no web/bundle-budget.json; run with --record on a known-good tree first"
          : `web/bundle-budget.json cannot be read (${err.message})`,
    };
  }
  try {
    const budget = JSON.parse(text);
    if (budget !== null && typeof budget === "object") {
      return { budget, problem: null };
    }
  } catch (err) {
    return {
      budget: null,
      problem: `web/bundle-budget.json does not parse (${err.message}); resolve it, or re-record with --record on a known-good tree`,
    };
  }
  return {
    budget: null,
    problem:
      "web/bundle-budget.json is not a JSON object; re-record with --record on a known-good tree",
  };
}

// Every finding prints before the run's verdict, so a tolerated rise in one
// figure, or a budget that cannot be read, cannot hide another.
function verdict(findings, loaded, got) {
  if (loaded.problem !== null) {
    return { errors: [...findings, loaded.problem], code: 2 };
  }
  const errors = [
    ...findings,
    ...budgetFindings(got, loaded.budget).map((f) => `FAIL: ${f}`),
  ];
  return { errors, code: errors.length > 0 ? 1 : 0 };
}

// --record-css keeps the JS figure, its date and its chunk list, since the JS
// figure is the one --record alone may move.
function nextBudget(budget, got, chunkFiles, cssOnly, today) {
  return {
    entryClosureGzipBytes: cssOnly
      ? budget.entryClosureGzipBytes
      : got.jsGzipBytes,
    entryCssGzipBytes: got.cssGzipBytes,
    entryFontBytes: got.fontBytes,
    recordedAt: cssOnly ? budget.recordedAt : today,
    cssRecordedAt: today,
    chunks: cssOnly ? budget.chunks : chunkFiles,
  };
}

// A guard that finds nothing has to be shown able to find something (TYRE-49).
if (process.argv.includes("--self-test")) {
  // U175: the library ships in the entry. Each fixture below fires the rules
  // named in its expected texts, and no others.
  const inClosure = `the entry's static closure does not carry oidc-client-ts ("${LIBRARY_MARKER}"), so a renewal, sign-in or sign-out would wait on a chunk fetch (U175)`;
  const outside = (file) =>
    `${file} carries oidc-client-ts ("${LIBRARY_MARKER}") outside the entry's static closure`;
  const dynamicOnly = `${AUTH_CHUNK} is reachable only through a dynamic import`;
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
  // What Vite emits for a static import it inlines: no key of its own.
  const inlined = { "index.html": { file: "entry.js", isEntry: true } };
  const withLazyCopy = {
    "index.html": {
      file: "entry.js",
      isEntry: true,
      dynamicImports: ["_copy"],
    },
    _copy: { file: "copy.js" },
  };
  const text = (files) => (file) => files[file] ?? "";
  const authCases = [
    [
      "imported statically, its own chunk",
      authLibraryFindings(
        eager,
        "index.html",
        text({ "oidc.js": LIBRARY_MARKER }),
      ),
      [],
    ],
    [
      "inlined into the entry",
      authLibraryFindings(
        inlined,
        "index.html",
        text({ "entry.js": LIBRARY_MARKER }),
      ),
      [],
    ],
    [
      "lazy",
      authLibraryFindings(
        lazy,
        "index.html",
        text({ "oidc.js": LIBRARY_MARKER }),
      ),
      [inClosure, outside("oidc.js"), dynamicOnly],
    ],
    [
      "in the entry and in a lazy chunk too",
      authLibraryFindings(
        withLazyCopy,
        "index.html",
        text({ "entry.js": LIBRARY_MARKER, "copy.js": LIBRARY_MARKER }),
      ),
      [outside("copy.js")],
    ],
    [
      "in the entry, with the auth module still a dynamic import",
      authLibraryFindings(
        lazy,
        "index.html",
        text({ "entry.js": LIBRARY_MARKER }),
      ),
      [dynamicOnly],
    ],
    // A library bump that renamed the marker fails here rather than passing.
    [
      "the marker nowhere",
      authLibraryFindings(inlined, "index.html", text({})),
      [inClosure],
    ],
  ];
  for (const [name, found, want] of authCases) {
    if (JSON.stringify(found) !== JSON.stringify(want)) {
      console.error(
        `self-test: ${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(found)}`,
      );
      process.exit(1);
    }
  }
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
  // A CSS or font rise must not be told to run --record, which would also
  // re-record the JS figure, and each figure cites its own date.
  const dated = {
    entryClosureGzipBytes: 5,
    entryCssGzipBytes: 6,
    entryFontBytes: 7,
    recordedAt: "2026-01-01",
    cssRecordedAt: "2026-02-02",
    chunks: ["old.js"],
  };
  const oneDate = { ...dated, cssRecordedAt: undefined };
  const flagCases = [
    [
      "JS",
      { jsGzipBytes: 6, cssGzipBytes: 6, fontBytes: 7 },
      dated,
      "2026-01-01",
      "--record",
    ],
    [
      "CSS",
      { jsGzipBytes: 5, cssGzipBytes: 7, fontBytes: 7 },
      dated,
      "2026-02-02",
      "--record-css",
    ],
    [
      "fonts",
      { jsGzipBytes: 5, cssGzipBytes: 6, fontBytes: 8 },
      dated,
      "2026-02-02",
      "--record-css",
    ],
    [
      "CSS, one date",
      { jsGzipBytes: 5, cssGzipBytes: 7, fontBytes: 7 },
      oneDate,
      "2026-01-01",
      "--record-css",
    ],
  ];
  for (const [name, got, budget, date, flag] of flagCases) {
    const found = budgetFindings(got, budget);
    const flags = found[0]?.match(/--record(?:-css)?/g) ?? [];
    if (
      found.length !== 1 ||
      !found[0].includes(`recorded ${date}`) ||
      flags.join() !== flag
    ) {
      console.error(
        `self-test: ${name} over budget must cite ${date} and name only ${flag}, got ${JSON.stringify(found)}`,
      );
      process.exit(1);
    }
  }
  const got = { jsGzipBytes: 9, cssGzipBytes: 8, fontBytes: 4 };
  const cssOnly = nextBudget(dated, got, ["new.js"], true, "2026-03-03");
  const full = nextBudget(dated, got, ["new.js"], false, "2026-03-03");
  const wantCssOnly = {
    ...dated,
    entryCssGzipBytes: 8,
    entryFontBytes: 4,
    cssRecordedAt: "2026-03-03",
  };
  const wantFull = {
    entryClosureGzipBytes: 9,
    entryCssGzipBytes: 8,
    entryFontBytes: 4,
    recordedAt: "2026-03-03",
    cssRecordedAt: "2026-03-03",
    chunks: ["new.js"],
  };
  for (const [name, gotBudget, want] of [
    ["--record-css", cssOnly, wantCssOnly],
    ["--record", full, wantFull],
  ]) {
    if (JSON.stringify(gotBudget) !== JSON.stringify(want)) {
      console.error(
        `self-test: ${name} wrote ${JSON.stringify(gotBudget)}, expected ${JSON.stringify(want)}`,
      );
      process.exit(1);
    }
  }
  // A budget file re-recorded by PR after PR can hold a merge conflict. It
  // is refused as unreadable, not as missing, and the findings already
  // collected still print (TYRE-443).
  const conflicted = loadBudget(
    () => '<<<<<<< HEAD\n{"entryClosureGzipBytes": 1}\n=======\n',
  );
  const missing = loadBudget(() => {
    throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  });
  const refused = verdict(["FAIL: earlier"], conflicted, got);
  if (
    conflicted.budget !== null ||
    !/does not parse/.test(conflicted.problem ?? "") ||
    !/^no web\/bundle-budget\.json/.test(missing.problem ?? "") ||
    refused.code !== 2 ||
    refused.errors[0] !== "FAIL: earlier" ||
    refused.errors[1] !== conflicted.problem
  ) {
    console.error(
      `self-test: an unreadable budget: got ${JSON.stringify({ conflicted, missing, refused })}`,
    );
    process.exit(1);
  }
  for (const [name, found] of budgetCases) {
    for (const f of found) console.log(`self-test (${name}): ${f}`);
  }
  for (const [name, found, want] of budgetCases) {
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

const findings = authLibraryFindings(manifest, entryKey, (file) =>
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

const loaded = loadBudget(() => readFileSync(budgetPath, "utf8"));
const { budget } = loaded;
const got = {
  jsGzipBytes: total,
  cssGzipBytes: assets.cssGzipBytes,
  fontBytes: assets.fontBytes,
};

if (record || recordCss) {
  if (findings.length > 0) {
    for (const f of findings) console.error(f);
    process.exit(1);
  }
  if (recordCss && !budget) {
    console.error(
      `${loaded.problem}. --record-css keeps the JS figure, so run --record instead`,
    );
    process.exit(2);
  }
  const next = nextBudget(
    budget,
    got,
    chunks.map((c) => c.file),
    !record,
    new Date().toISOString().slice(0, 10),
  );
  writeFileSync(budgetPath, JSON.stringify(next, null, 2) + "\n");
  console.log(
    `recorded ${record ? `${total} JS, ` : ""}${assets.cssGzipBytes} CSS and ${assets.fontBytes} font bytes to web/bundle-budget.json`,
  );
  process.exit(0);
}

const { errors, code } = verdict(findings, loaded, got);
if (code !== 0) {
  for (const e of errors) console.error(e);
  process.exit(code);
}
console.log(
  `OK: within budget ${budget.entryClosureGzipBytes} JS (recorded ${budget.recordedAt}), ${budget.entryCssGzipBytes} CSS and ${budget.entryFontBytes} fonts (recorded ${budget.cssRecordedAt ?? budget.recordedAt})`,
);
