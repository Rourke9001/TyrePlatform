#!/usr/bin/env node
// TYRE-445, TYRE-27: a colour reaches a component only through custom
// properties. themeCss writes them from web/src/theme/tokens.ts, and
// ThemeProvider writes the four brand ones from tenant configuration.
// Outside tokens.ts this refuses, in a stylesheet, a hex literal, a colour
// function or a named colour in a declaration's value; in a component, a hex
// literal or colour function inside a string, and a named colour in a string
// written straight after a style key or a fill, stroke or color prop.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A hex ends where a word would, so "#add-driver" is an anchor, not #add.
const HEX = String.raw`#[0-9a-fA-F]{3,8}(?![\w-])`;
const FUNCTION = String.raw`\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(`;
// CSS's named colours. transparent and currentColor name no colour of their
// own, so they stay allowed.
const NAMED = `
  aliceblue antiquewhite aqua aquamarine azure beige bisque black
  blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse
  chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
  darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
  darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet
  deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
  forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green
  greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender
  lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
  lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue
  lightyellow lime limegreen linen magenta maroon mediumaquamarine
  mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
  mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange
  orangered orchid palegoldenrod palegreen paleturquoise palevioletred
  papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red
  rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna
  silver skyblue slateblue slategray slategrey snow springgreen steelblue
  tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
  yellowgreen
`
  .trim()
  .split(/\s+/)
  .join("|");
const WORD = String.raw`(?<![-\w.#])(?:${NAMED})(?![-\w])`;
// A value follows "property:" at the start of a declaration and ends at ";"
// or "}". A selector ends at "{", so a pseudo-class's colon opens nothing.
const CSS_COLOUR = new RegExp(
  String.raw`(?<=[{;]\s*[-\w]+\s*:[^;{}]*)(?:${HEX}|${FUNCTION}|${WORD})(?=[^;{}]*[;}])`,
  "gi",
);
const STRING = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g;
const TS_LITERAL = new RegExp(`${HEX}|${FUNCTION}`, "g");
const TS_NAMED = new RegExp(WORD, "gi");
// A label or a code may say "Green"; a colour word counts only where a
// style key or a fill, stroke or color prop takes the string.
const STYLE_KEY =
  /\b(?:color|fill|stroke|stopColor|floodColor|lightingColor|background\w*|border\w*|outline\w*|boxShadow|textShadow|caretColor|accentColor|textDecorationColor|columnRuleColor)\s*[:=]\s*\{?\s*$/;
const ENTITY = /&#x?[0-9a-fA-F]+;/g;
const SCANNED = /\.(ts|tsx|css)$/;

// tokens.ts is the one home. Tests pin literal values on purpose.
function exempt(rel) {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return (
    rel === "theme/tokens.ts" ||
    rel.startsWith("test/") ||
    base.includes(".test.")
  );
}

// Comments are blanked, strings kept: a literal in a string is the case
// that matters. A string is tracked so a glob such as "./*.gallery.tsx"
// cannot open a comment that hides the code after it.
function code(text, css) {
  const out = [...text];
  let quote = null;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote || (c === "\n" && quote !== "`")) quote = null;
    } else if (c === '"' || c === "'" || (c === "`" && !css)) {
      quote = c;
    } else if (c === "/" && out[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? out.length : end + 2;
      for (; i < stop; i++) if (out[i] !== "\n") out[i] = " ";
      i--;
    } else if (!css && c === "/" && out[i + 1] === "/") {
      for (; i < out.length && out[i] !== "\n"; i++) out[i] = " ";
    }
  }
  return out.join("").replace(ENTITY, (m) => " ".repeat(m.length));
}

// The whole file is matched at once, so a value that runs onto the next
// line is still read.
function scanFile(rel, text) {
  const css = rel.endsWith(".css");
  const body = code(text, css);
  const found = [];
  const report = (index, match) =>
    found.push(`${rel}:${body.slice(0, index).split("\n").length}: ${match}`);
  if (css) {
    for (const m of body.matchAll(CSS_COLOUR)) report(m.index, m[0]);
    return found;
  }
  for (const s of body.matchAll(STRING)) {
    const inner = s[0].slice(1, -1);
    const start = s.index + 1;
    for (const m of inner.matchAll(TS_LITERAL)) report(start + m.index, m[0]);
    if (STYLE_KEY.test(body.slice(Math.max(0, s.index - 40), s.index))) {
      for (const m of inner.matchAll(TS_NAMED)) report(start + m.index, m[0]);
    }
  }
  return found;
}

function scanTree(src) {
  const found = [];
  let files = 0;
  for (const entry of readdirSync(src, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile() || !SCANNED.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const rel = relative(src, file).split("\\").join("/");
    if (exempt(rel)) continue;
    files += 1;
    found.push(...scanFile(rel, readFileSync(file, "utf8")));
  }
  return { files, found };
}

// A gate that finds nothing has to be shown able to find something (TYRE-49).
if (process.argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "colour-literals-"));
  const plant = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  try {
    plant("ui/clean.tsx", "export const a = 1;\n");
    plant(
      "ui/quiet.css",
      "/* #123456 and rgb( in a comment */\n.a { color: var(--ink); }\n",
    );
    plant(
      "ui/Quiet.tsx",
      [
        "// #abcdef in a line comment, hsl( too",
        "/* rgba( in a block */",
        'const ellipsis = "&#8230;";',
      ].join("\n"),
    );
    plant(
      "ui/keywords.css",
      [
        ".tan { white-space: nowrap; color: transparent; }",
        ".a { border-color: currentColor; }",
        ".b { background: color-mix(in srgb, var(--warn) 80%, var(--ink)); }",
      ].join("\n"),
    );
    plant(
      "ui/Words.tsx",
      [
        "const c = bandColor(1);",
        'const label = "Red tyre";',
        'const k = "green-ish";',
        'const band = { label: "Green" };',
        'const link = <a href="#add-driver">Add</a>;',
        "const shade = color(1);",
      ].join("\n"),
    );
    plant(
      "ui/anchors.css",
      [
        "#fee-section .a { color: var(--ink); }",
        ".a:hover #bad { color: var(--ink); }",
        '.b:not([href="#add"]) { color: var(--ink); }',
        ".c { color: var(--ink); a:hover #bad { color: var(--ink); } }",
      ].join("\n"),
    );
    plant("theme/tokens.ts", 'export const ink = "#111417";\n');
    plant("theme/fonts.css", '@font-face { src: url("./a.woff2"); }\n');
    plant("ui/Box.test.tsx", 'const c = "#ffffff";\n');
    plant("test/fixtures.ts", 'const c = "rgb(0, 0, 0)";\n');
    if (scanTree(dir).found.length !== 0) {
      throw new Error(
        `a clean or exempt file was flagged: ${scanTree(dir).found.join("; ")}`,
      );
    }
    plant("ui/planted.css", ".a {\n  color: #123456;\n}\n");
    plant(
      "ui/Planted.tsx",
      [
        'const glob = "./*.gallery.tsx";',
        'const a = { color: "rgba(0, 0, 0, 0.5)" };',
        "const b = `hsl(${1}, 50%, 50%)`;",
        "// */",
        'const d = <path fill="white" />;',
        "const e = { color: 'Tomato' };",
        'const f = <div style={{ border: "1px solid red" }} />;',
        'const g = { boxShadow: "0 0 0 1px black" };',
        'const h = { background: "oklch(70% 0.1 200)" };',
      ].join("\n"),
    );
    plant(
      "ui/named.css",
      [
        ".a { color: red; }",
        ".b {",
        "  box-shadow:",
        "    0 0 0 1px black;",
        "}",
        ".c { background: oklch(70% 0.1 200); }",
        ".d { outline-color: color(display-p3 1 0 0); }",
        ".e { fill: lab(50% 40 59); border-color: hwb(0 0% 0%); }",
        ".f { color: lch(50% 40 60); stroke: oklab(0.6 0.1 0.1); }",
      ].join("\n"),
    );
    const want = [
      "ui/planted.css:2: #123456",
      "ui/Planted.tsx:2: rgba(",
      "ui/Planted.tsx:3: hsl(",
      "ui/Planted.tsx:5: white",
      "ui/Planted.tsx:6: Tomato",
      "ui/Planted.tsx:7: red",
      "ui/Planted.tsx:8: black",
      "ui/Planted.tsx:9: oklch(",
      "ui/named.css:1: red",
      "ui/named.css:4: black",
      "ui/named.css:6: oklch(",
      "ui/named.css:7: color(",
      "ui/named.css:8: lab(",
      "ui/named.css:8: hwb(",
      "ui/named.css:9: lch(",
      "ui/named.css:9: oklab(",
    ];
    const got = scanTree(dir).found.sort();
    if (JSON.stringify(got) !== JSON.stringify(want.sort())) {
      throw new Error(
        `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
    }
  } catch (err) {
    console.error(`colour gate self-test: ${err.message}`);
    process.exit(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    "colour gate self-test: planted literals fire, comments, entities and exempt files stay quiet",
  );
  process.exit(0);
}

const { files, found } = scanTree(resolve(root, "web/src"));
if (found.length > 0) {
  for (const f of found) console.error(`web/src/${f}`);
  console.error(
    `${found.length} colour literal(s) outside web/src/theme/tokens.ts. Read the token's custom property instead (web/CLAUDE.md, TYRE-27).`,
  );
  process.exit(1);
}
console.log(`colour gate: ${files} files, no colour literal outside tokens.ts`);
