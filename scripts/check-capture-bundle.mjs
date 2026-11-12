// The capture route must not pay for the manager app (TYRE-238, ADR-0015).
// web/CLAUDE.md, The design system, lists what this checks.
import { appendFileSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "web/dist");
const budgetPath = resolve(root, "web/bundle-budget.json");

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

// The three figures, in the order they print.
const FIGURES = [
  {
    key: "entryClosureGzipBytes",
    name: "entry JS",
    unit: "gzip bytes",
    row: "Entry JS (gzip)",
  },
  {
    key: "entryCssGzipBytes",
    name: "entry CSS",
    unit: "gzip bytes",
    row: "Entry CSS (gzip)",
  },
  {
    key: "entryFontBytes",
    name: "entry fonts",
    unit: "bytes",
    row: "Entry fonts",
  },
];

// An unknown argument is refused, so a flag typed from habit is not taken
// for a passing check (TYRE-474).
function parseArgs(args) {
  if (args.length === 0) return { mode: "check" };
  if (args.length === 1 && args[0] === "--self-test")
    return { mode: "self-test" };
  const operand = (a) => !a.startsWith("--");
  if (args.length === 2 && args[0] === "--figures" && operand(args[1]))
    return { mode: "figures", dist: args[1] };
  if (
    args.length === 3 &&
    args[0] === "--report" &&
    operand(args[1]) &&
    operand(args[2])
  )
    return { mode: "report", base: args[1], pr: args[2] };
  return {
    mode: "refused",
    problem:
      `unknown arguments: ${args.join(" ")}. Run with no argument to check, or with --self-test, --figures <dist> or --report <base.json> <pr.json>. ` +
      "No flag writes web/bundle-budget.json; a ceiling is raised by hand (U200).",
  };
}

function readDist(distDir) {
  const path = resolve(distDir, ".vite/manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      problem: `no manifest at ${path}; run "npm run build" in web/ first (${err.message})`,
    };
  }
  const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
  if (!entryKey) return { problem: `manifest at ${path} has no entry chunk` };
  return { manifest, entryKey, problem: null };
}

// The one implementation of the entry's closure: its chunks in gzip bytes, and
// the CSS and fonts they pull in.
function entryFigures(manifest, entryKey, readBytes) {
  const { order } = closures(manifest, entryKey);
  const chunks = order.map((key) => {
    const file = manifest[key].file;
    return { key, file, gzipBytes: gzipSync(readBytes(file)).length };
  });
  const assets = closureAssets(manifest, order, readBytes);
  return {
    chunks,
    cssFiles: assets.cssFiles,
    fontFiles: assets.fontFiles,
    figures: {
      entryClosureGzipBytes: chunks.reduce((sum, c) => sum + c.gzipBytes, 0),
      entryCssGzipBytes: assets.cssGzipBytes,
      entryFontBytes: assets.fontBytes,
    },
  };
}

// A ceiling alone would let a lazy driver module pass by shrinking the entry;
// a chunk fetched in front of capture is the round trip ADR-0009 (rule 7)
// rules out. The manifest keys a dynamic entry by its source path, which is
// what this reads.
function lazyDriverFindings(manifest, entryKey) {
  const { seen, reachable } = closures(manifest, entryKey);
  return [...reachable]
    .filter((key) => !seen.has(key) && /^src\/(capture|driver)\//.test(key))
    .map(
      (key) =>
        `${key} is reachable from the entry only through a dynamic import. ` +
        "The capture and driver modules load with the entry (ADR-0009, CLAUDE.md rule 7); import it statically.",
    );
}

// Infinity (from 1e999), a fraction and a negative are not byte counts.
function isByteCount(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function loadBudget(readText) {
  let text;
  try {
    text = readText();
  } catch (err) {
    return {
      budget: null,
      problem:
        err.code === "ENOENT"
          ? "no web/bundle-budget.json. It holds the capture entry's three ceilings and their reasons (U200); restore it from develop."
          : `web/bundle-budget.json cannot be read (${err.message})`,
    };
  }
  let budget;
  try {
    budget = JSON.parse(text);
  } catch (err) {
    return {
      budget: null,
      problem: `web/bundle-budget.json does not parse (${err.message}). Fix the hand edit, or restore the file from develop.`,
    };
  }
  if (budget === null || typeof budget !== "object" || Array.isArray(budget)) {
    return {
      budget: null,
      problem:
        "web/bundle-budget.json is not a JSON object holding the three ceilings (U200).",
    };
  }
  const bad = FIGURES.filter(({ key }) => {
    const entry = budget[key];
    return !(
      entry !== null &&
      typeof entry === "object" &&
      isByteCount(entry.ceiling) &&
      typeof entry.reason === "string" &&
      entry.reason.trim() !== ""
    );
  });
  if (bad.length > 0) {
    return {
      budget: null,
      problem: bad
        .map(
          ({ key }) =>
            `web/bundle-budget.json: ${key} needs a "ceiling" in whole bytes and a non-empty "reason" (U200).`,
        )
        .join("\n"),
    };
  }
  return { budget, problem: null };
}

function budgetFindings(figures, budget) {
  const out = [];
  for (const { key, name, unit } of FIGURES) {
    const value = figures[key];
    const { ceiling } = budget[key];
    if (value > ceiling) {
      out.push(
        `${name} is ${value} ${unit}, ${value - ceiling} past its ceiling of ${ceiling} (${key} in web/bundle-budget.json). ` +
          "Put the new import behind React.lazy (never oidc-client-ts, U175). " +
          "If the growth is the capture route's own, raise the ceiling by hand in web/bundle-budget.json with its reason, and say why in the PR (U84, U200).",
      );
    }
  }
  return out;
}

// A figure past its ceiling, or a budget that cannot be read, cannot hide
// another finding: all of them print before the exit (U200).
function verdict(findings, loaded, figures) {
  if (loaded.problem !== null) {
    return { errors: [...findings, loaded.problem], code: 2 };
  }
  const errors = [
    ...findings,
    ...budgetFindings(figures, loaded.budget).map((f) => `FAIL: ${f}`),
  ];
  return { errors, code: errors.length > 0 ? 1 : 0 };
}

// The figures file a job wrote from a build. A failed run leaves it empty or
// partial, and the report refuses that rather than print a row of undefined.
function readFigures(text) {
  let figures;
  try {
    figures = JSON.parse(text);
  } catch (err) {
    return {
      figures: null,
      problem: `the figures file does not parse (${err.message})`,
    };
  }
  if (figures === null || typeof figures !== "object" || Array.isArray(figures))
    return {
      figures: null,
      problem:
        "the figures file is not a JSON object holding the three figures",
    };
  const bad = FIGURES.filter(({ key }) => !isByteCount(figures[key]));
  if (bad.length > 0)
    return {
      figures: null,
      problem: `the figures file needs a whole-byte count for ${bad.map((f) => f.key).join(", ")}`,
    };
  return {
    figures: Object.fromEntries(FIGURES.map(({ key }) => [key, figures[key]])),
    problem: null,
  };
}

function formatChange(base, pr) {
  if (pr === base) return "no change";
  const sign = pr > base ? "+" : "-";
  const abs = Math.abs(pr - base);
  // A base of 0 has no percentage to give.
  if (base === 0) return `${sign}${abs}`;
  return `${sign}${abs} (${sign}${((abs / base) * 100).toFixed(2)}%)`;
}

function formatRoom(ceiling, pr) {
  const room = ceiling - pr;
  return room < 0 ? `${room}, past the ceiling` : String(room);
}

function reportTable(base, pr, budget) {
  const rows = FIGURES.map(
    ({ key, row }) =>
      `| ${row} | ${base[key]} | ${pr[key]} | ${formatChange(base[key], pr[key])} | ${budget[key].ceiling} | ${formatRoom(budget[key].ceiling, pr[key])} |`,
  );
  return [
    "### Capture bundle size",
    "",
    "Base is the base branch's tip, the merge commit's first parent; this PR is the merge commit CI builds. JS and CSS are gzip bytes, fonts raw bytes.",
    "",
    "| Figure | Base | This PR | Change | Ceiling | Room left |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "A rise is a decision, so the PR names the import that grew the entry. The fix for an unplanned rise is the import (U84).",
  ].join("\n");
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.mode === "refused") {
  console.error(parsed.problem);
  process.exit(2);
}

// A guard that finds nothing has to be shown able to find something (TYRE-49).
if (parsed.mode === "self-test") {
  const fail = (message) => {
    console.error(`self-test: ${message}`);
    process.exit(1);
  };
  const same = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want))
      fail(
        `${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
  };
  const includes = (name, text, ...parts) => {
    for (const part of parts)
      if (!String(text).includes(part))
        fail(
          `${name}: expected ${JSON.stringify(text)} to include ${JSON.stringify(part)}`,
        );
  };
  const noFlag = /(^|\s)--[a-z]/;

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

  // One implementation of the entry's closure, shared by the check and the
  // figures mode: b.js is imported twice and counts once, and lazy.js and its
  // CSS stay out.
  const closureManifest = {
    "index.html": {
      file: "entry.js",
      isEntry: true,
      imports: ["_a", "_b"],
      dynamicImports: ["lazy"],
      css: ["e.css"],
    },
    _a: { file: "a.js", imports: ["_b"] },
    _b: { file: "b.js" },
    lazy: { file: "lazy.js", css: ["l.css"] },
  };
  const closureFiles = {
    "entry.js": "entry".repeat(40),
    "a.js": "alpha".repeat(30),
    "b.js": "bravo".repeat(20),
    "lazy.js": "lazy".repeat(50),
    "e.css": "e{margin:0}".repeat(30),
    "l.css": "l{margin:1px}".repeat(30),
  };
  const gz = (name) => gzipSync(Buffer.from(closureFiles[name])).length;
  const measured = entryFigures(
    closureManifest,
    "index.html",
    bytes(closureFiles),
  );
  same(
    "closure chunks",
    measured.chunks.map((c) => c.file),
    ["entry.js", "a.js", "b.js"],
  );
  same("closure figures", measured.figures, {
    entryClosureGzipBytes: gz("entry.js") + gz("a.js") + gz("b.js"),
    entryCssGzipBytes: gz("e.css"),
    entryFontBytes: 0,
  });

  // The lazy-driver check (ADR-0009, rule 7) has to be shown able to fire.
  const lazyCapture = {
    "index.html": {
      file: "entry.js",
      isEntry: true,
      dynamicImports: ["src/capture/Sheet.tsx"],
    },
    "src/capture/Sheet.tsx": { file: "sheet.js" },
  };
  const eagerCapture = {
    "index.html": {
      file: "entry.js",
      isEntry: true,
      imports: ["src/capture/Sheet.tsx"],
    },
    "src/capture/Sheet.tsx": { file: "sheet.js" },
  };
  const lazyFound = lazyDriverFindings(lazyCapture, "index.html");
  same("a capture module only lazily reachable: count", lazyFound.length, 1);
  if (
    !lazyFound[0].startsWith(
      "src/capture/Sheet.tsx is reachable from the entry only through a dynamic import",
    )
  )
    fail(`lazy capture module: got ${JSON.stringify(lazyFound)}`);
  same(
    "a capture module imported statically",
    lazyDriverFindings(eagerCapture, "index.html"),
    [],
  );

  // The ceilings (U200). A figure passes at its ceiling and fails one byte
  // past it.
  const [JS, CSS, FONT] = FIGURES.map((f) => f.key);
  const figs = (js, css, fonts) => ({
    [JS]: js,
    [CSS]: css,
    [FONT]: fonts,
  });
  const ceilings = (js, css, fonts) => {
    const values = [js, css, fonts];
    return Object.fromEntries(
      FIGURES.map(({ key }, i) => [key, { ceiling: values[i], reason: "r" }]),
    );
  };
  same(
    "at every ceiling",
    budgetFindings(figs(5, 6, 7), ceilings(5, 6, 7)),
    [],
  );
  const limits = [5, 6, 7];
  for (const [i, f] of FIGURES.entries()) {
    const values = limits.map((v, j) => (j === i ? v + 1 : v));
    const found = budgetFindings(figs(...values), ceilings(...limits));
    same(`${f.name} one byte past: count`, found.length, 1);
    includes(
      `${f.name} one byte past`,
      found[0],
      f.name,
      f.key,
      "1 past its ceiling",
      "React.lazy",
      "by hand",
      "U84",
      "U200",
    );
    if (noFlag.test(found[0])) fail(`${f.name} one byte past names a flag`);
    console.log(`self-test (${f.name}): ${found[0]}`);
  }
  const two = budgetFindings(figs(6, 7, 7), ceilings(5, 6, 7));
  same("two past: count", two.length, 2);
  includes("two past, first", two[0], "entry JS");
  includes("two past, second", two[1], "entry CSS");

  const load = (value) =>
    loadBudget(() =>
      typeof value === "string" ? value : JSON.stringify(value),
    );
  const withKey = (key, entry) => ({ ...ceilings(5, 6, 7), [key]: entry });
  same("valid budget", load(ceilings(5, 6, 7)), {
    budget: ceilings(5, 6, 7),
    problem: null,
  });
  const noFile = loadBudget(() => {
    throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  });
  if (!/^no web\/bundle-budget\.json/.test(noFile.problem ?? ""))
    fail(`no file: got ${JSON.stringify(noFile)}`);
  const refusals = [
    ["no file", noFile, [], []],
    ["does not parse", load("{"), ["does not parse"], []],
    ["array", load("[]"), ["not a JSON object"], []],
    ["null", load("null"), ["not a JSON object"], []],
    ["number", load("5"), ["not a JSON object"], []],
    ["no ceiling", load(withKey(JS, { reason: "r" })), [JS], []],
    [
      "ceiling a string",
      load(withKey(JS, { ceiling: "5", reason: "r" })),
      [JS],
      [],
    ],
    ["no reason", load(withKey(CSS, { ceiling: 6 })), [CSS], []],
    [
      "reason of spaces",
      load(withKey(FONT, { ceiling: 7, reason: "  " })),
      [FONT],
      [],
    ],
    [
      "ceiling that parses to Infinity",
      load(
        `{"${JS}":{"ceiling":1e999,"reason":"r"},"${CSS}":{"ceiling":6,"reason":"r"},"${FONT}":{"ceiling":7,"reason":"r"}}`,
      ),
      [JS],
      [CSS, FONT],
    ],
    [
      "ceiling negative",
      load(withKey(JS, { ceiling: -1, reason: "r" })),
      [JS],
      [],
    ],
    [
      "ceiling fractional",
      load(withKey(JS, { ceiling: 1.5, reason: "r" })),
      [JS],
      [],
    ],
    [
      "key left out",
      load(
        Object.fromEntries(
          Object.entries(ceilings(5, 6, 7)).filter(([k]) => k !== FONT),
        ),
      ),
      [FONT],
      [],
    ],
    [
      "old bare-number shape",
      load({ [JS]: 168821, [CSS]: 6607, [FONT]: 70188 }),
      [JS, CSS, FONT],
      [],
    ],
  ];
  for (const [name, loaded, want, unwanted] of refusals) {
    if (loaded.budget !== null || typeof loaded.problem !== "string")
      fail(`${name}: expected a refusal, got ${JSON.stringify(loaded)}`);
    includes(name, loaded.problem, ...want);
    for (const part of unwanted)
      if (loaded.problem.includes(part))
        fail(`${name}: ${JSON.stringify(loaded.problem)} names ${part}`);
    if (noFlag.test(loaded.problem)) fail(`${name}: the refusal names a flag`);
  }

  // Every finding prints before the verdict, so neither a figure past its
  // ceiling nor an unreadable budget hides an earlier finding.
  const refused = verdict(["FAIL: earlier"], load("{"), figs(5, 6, 7));
  same("a refused budget keeps earlier findings: code", refused.code, 2);
  same("a refused budget keeps earlier findings", refused.errors, [
    "FAIL: earlier",
    load("{").problem,
  ]);
  const past = verdict(
    ["FAIL: earlier"],
    { budget: ceilings(5, 6, 7), problem: null },
    figs(6, 6, 7),
  );
  same("a figure past keeps earlier findings: code", past.code, 1);
  same(
    "a figure past keeps earlier findings: first",
    past.errors[0],
    "FAIL: earlier",
  );
  if (!(past.errors[1] ?? "").startsWith("FAIL: entry JS"))
    fail(`a figure past: got ${JSON.stringify(past)}`);
  same(
    "pass",
    verdict([], { budget: ceilings(5, 6, 7), problem: null }, figs(5, 6, 7)),
    { errors: [], code: 0 },
  );

  same("no arguments", parseArgs([]), { mode: "check" });
  same("self-test argument", parseArgs(["--self-test"]), {
    mode: "self-test",
  });
  for (const args of [
    ["--ceiling"],
    ["--write"],
    ["--self-test", "--write"],
    ["extra"],
  ]) {
    const got = parseArgs(args);
    same(`unknown ${args.join(" ")}`, got.mode, "refused");
    includes(
      `unknown ${args.join(" ")}`,
      got.problem,
      "unknown arguments",
      ...args,
    );
  }

  same("figures mode", parseArgs(["--figures", "dist"]), {
    mode: "figures",
    dist: "dist",
  });
  same("report mode", parseArgs(["--report", "a.json", "b.json"]), {
    mode: "report",
    base: "a.json",
    pr: "b.json",
  });
  for (const args of [
    ["--figures"],
    ["--figures", "a", "b"],
    ["--figures", "--self-test"],
    ["--report", "a.json"],
    ["--report", "a", "b", "c"],
  ])
    same(`bad operands ${args.join(" ")}`, parseArgs(args).mode, "refused");

  // A figures file the job wrote from a failed run is empty or partial; the
  // report refuses it rather than print a row of undefined (TYRE-474).
  same("figures read", readFigures(JSON.stringify(figs(1, 2, 3))), {
    figures: figs(1, 2, 3),
    problem: null,
  });
  const withFigure = (key, value) =>
    JSON.stringify({ ...figs(1, 2, 3), [key]: value });
  const figureRefusals = [
    ["empty", "", ["does not parse"]],
    ["open brace", "{", ["does not parse"]],
    ["null", "null", ["not a JSON object"]],
    ["number", "5", ["not a JSON object"]],
    ["key left out", JSON.stringify({ [JS]: 1, [CSS]: 2 }), [FONT]],
    ["a string", withFigure(CSS, "6607"), [CSS]],
    ["negative", withFigure(JS, -1), [JS]],
    ["fractional", withFigure(JS, 1.5), [JS]],
  ];
  for (const [name, input, want] of figureRefusals) {
    const got = readFigures(input);
    if (got.figures !== null || typeof got.problem !== "string")
      fail(`figures ${name}: expected a refusal, got ${JSON.stringify(got)}`);
    includes(`figures ${name}`, got.problem, ...want);
  }

  same(
    "change",
    [
      formatChange(1000, 1010),
      formatChange(200, 190),
      formatChange(300, 300),
      formatChange(0, 50),
      formatChange(0, 0),
    ],
    ["+10 (+1.00%)", "-10 (-5.00%)", "no change", "+50", "no change"],
  );
  same(
    "room",
    [formatRoom(1100, 1010), formatRoom(300, 300), formatRoom(1005, 1010)],
    ["90", "0", "-5, past the ceiling"],
  );
  const tableFixtures = [
    [
      "fixture A",
      reportTable(
        figs(1000, 200, 300),
        figs(1010, 190, 300),
        ceilings(1100, 220, 330),
      ),
      [
        "| Entry JS (gzip) | 1000 | 1010 | +10 (+1.00%) | 1100 | 90 |",
        "| Entry CSS (gzip) | 200 | 190 | -10 (-5.00%) | 220 | 30 |",
        "| Entry fonts | 300 | 300 | no change | 330 | 30 |",
      ],
    ],
    [
      "fixture B",
      reportTable(
        figs(1000, 0, 300),
        figs(1010, 50, 300),
        ceilings(1005, 40, 300),
      ),
      [
        "| Entry JS (gzip) | 1000 | 1010 | +10 (+1.00%) | 1005 | -5, past the ceiling |",
        "| Entry CSS (gzip) | 0 | 50 | +50 | 40 | -10, past the ceiling |",
        "| Entry fonts | 300 | 300 | no change | 300 | 0 |",
      ],
    ],
  ];
  for (const [name, table, rows] of tableFixtures) {
    const lines = table.split("\n");
    for (const row of [
      "| Figure | Base | This PR | Change | Ceiling | Room left |",
      ...rows,
    ])
      if (!lines.includes(row))
        fail(`${name}: no line ${JSON.stringify(row)} in\n${table}`);
    includes(name, table, "(U84)");
    for (const bad of ["NaN", "Infinity", "undefined"])
      if (table.includes(bad)) fail(`${name}: the table holds ${bad}`);
  }

  console.log("self-test: OK");
  process.exit(0);
}

// The figures mode reads no budget and runs no check, so it can measure a base
// whose imports or budget differ (TYRE-474 spec, The size report). Stdout holds
// the JSON and nothing else, since the job redirects it to a file.
if (parsed.mode === "figures") {
  const distDir = resolve(process.cwd(), parsed.dist);
  console.error(`figures from ${distDir}`);
  const built = readDist(distDir);
  if (built.problem !== null) {
    console.error(built.problem);
    process.exit(2);
  }
  const measured = entryFigures(built.manifest, built.entryKey, (file) =>
    readFileSync(resolve(distDir, file)),
  );
  console.log(JSON.stringify(measured.figures));
  process.exit(0);
}

if (parsed.mode === "report") {
  const inputs = {};
  for (const [label, path] of [
    ["base", parsed.base],
    ["pr", parsed.pr],
  ]) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      console.error(`cannot read ${path} (${err.message})`);
      process.exit(2);
    }
    const got = readFigures(text);
    if (got.problem !== null) {
      console.error(`${path}: ${got.problem}`);
      process.exit(2);
    }
    inputs[label] = got.figures;
  }
  const loadedBudget = loadBudget(() => readFileSync(budgetPath, "utf8"));
  if (loadedBudget.problem !== null) {
    console.error(loadedBudget.problem);
    process.exit(2);
  }
  const table = reportTable(inputs.base, inputs.pr, loadedBudget.budget);
  console.log(table);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    // A report that fails must be seen, so a failed write is red.
    try {
      appendFileSync(summary, `${table}\n`);
    } catch (err) {
      console.error(
        `cannot write the job summary to ${summary} (${err.message})`,
      );
      process.exit(2);
    }
  }
  process.exit(0);
}

const read = readDist(dist);
if (read.problem !== null) {
  console.error(read.problem);
  process.exit(2);
}
const { manifest, entryKey } = read;

const findings = [
  ...authLibraryFindings(manifest, entryKey, (file) =>
    readFileSync(resolve(dist, file), "utf8"),
  ),
  ...lazyDriverFindings(manifest, entryKey),
].map((f) => `FAIL: ${f}`);

const { chunks, cssFiles, fontFiles, figures } = entryFigures(
  manifest,
  entryKey,
  (file) => readFileSync(resolve(dist, file)),
);

console.log(
  `entry closure: ${chunks.length} chunks, ${figures.entryClosureGzipBytes} gzip bytes`,
);
for (const c of chunks)
  console.log(`  ${c.gzipBytes.toString().padStart(8)}  ${c.file}`);
console.log(
  `entry CSS: ${cssFiles.length} files, ${figures.entryCssGzipBytes} gzip bytes`,
);
console.log(
  `entry fonts: ${fontFiles.length} files, ${figures.entryFontBytes} bytes`,
);

const loaded = loadBudget(() => readFileSync(budgetPath, "utf8"));
const { errors, code } = verdict(findings, loaded, figures);
if (code !== 0) {
  for (const e of errors) console.error(e);
  process.exit(code);
}
console.log(
  `OK: ${FIGURES.map((f) => {
    const ceiling = loaded.budget[f.key].ceiling;
    return `${f.name} ${figures[f.key]} of ${ceiling} ${f.unit} (${ceiling - figures[f.key]} left)`;
  }).join(", ")}`,
);
