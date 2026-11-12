// @vitest-environment node
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import stylelint from "stylelint";
import { describe, expect, it } from "vitest";

// TYRE-27, TYRE-445, TYRE-49: a gate that finds nothing has to be shown able
// to find something. Planted text goes through the real stylelint and eslint
// configs, and each list is compared exactly. Each TS path stands in for an
// existing file, since the type-aware parser needs a file it can find (as
// web/lint/legacyImports.test.ts says).
const WEB = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd: WEB });

// The four colour bans' messages, exactly as web/eslint.config.js writes them.
const remedy = "Read the token's custom property instead (web/CLAUDE.md, TYRE-27).";
const TAG: Partial<Record<string, string>> = {
  [`A hex colour outside src/theme/tokens.ts. ${remedy}`]: "hex",
  [`A colour function outside src/theme/tokens.ts. ${remedy}`]: "colourFunction",
  [`A hex colour in a style value. ${remedy}`]: "hexInStyle",
  [`A named colour in a style value. ${remedy}`]: "namedInStyle",
};

// stylelint groups warnings by rule, not by line, so every list is sorted
// before it is compared.
function byLine(a: string, b: string): number {
  return parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b);
}

function want(list: string[]): string[] {
  return [...list].sort(byLine);
}

async function css(rel: string, code: string): Promise<string[]> {
  const { results } = await stylelint.lint({ code, codeFilename: rel, cwd: WEB });
  if (results.length !== 1) throw new Error(`${rel}: stylelint returned ${results.length} results`);
  const result = results[0];
  if (result.ignored) throw new Error(`${rel}: stylelint ignored the planted stylesheet`);
  if (result.invalidOptionWarnings.length > 0) {
    const text = result.invalidOptionWarnings.map((w) => w.text).join("; ");
    throw new Error(`${rel}: stylelint rejected a rule option: ${text}`);
  }
  if (result.parseErrors.length > 0) {
    throw new Error(`${rel}: the planted stylesheet did not parse`);
  }
  return result.warnings.map((w) => `${w.line}: ${w.rule}`).sort(byLine);
}

async function tsx(filePath: string, code: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath });
  const messages = results.flatMap((r) => r.messages);
  const fatal = messages.find((m) => m.fatal);
  if (fatal) throw new Error(`${filePath}: the planted file did not parse: ${fatal.message}`);
  return messages
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => `${m.line}: ${TAG[m.message] ?? "app"}`)
    .sort(byLine);
}

const lines = (...l: string[]) => l.join("\n") + "\n";

// CSS's named colours, a third copy: stylelint's own list checks this one,
// and this one checks the eslint config's. transparent and currentColor name
// no colour of their own, so they stay allowed.
const NAMED_COLOURS = `
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
  .split(/\s+/);

const QUIET_CSS = "/* #123456 and rgb( in a comment */\n.a { color: var(--ink); }\n";
const KEYWORDS_CSS = [
  ".tan { white-space: nowrap; color: transparent; }",
  ".a { border-color: currentColor; }",
  ".b { background: color-mix(in srgb, var(--warn) 80%, var(--ink)); }",
].join("\n");
const ANCHORS_CSS = [
  "#fee-section .a { color: var(--ink); }",
  ".a:hover #bad { color: var(--ink); }",
  '.b:not([href="#add"]) { color: var(--ink); }',
  ".c { color: var(--ink); a:hover #bad { color: var(--ink); } }",
  "a:hover #bad { color: var(--ink); }",
].join("\n");
const PATHS_CSS = [
  '.a { background: url("./red.svg"); }',
  ".b { mask: url(./icons/white.svg) no-repeat; }",
  '.c { background: URL("./red.svg"); }',
  ".d { background: url(red.svg); }",
  '.e { mask: url(#fade); fill: url("#bead"); }',
].join("\n");
const FONTS_CSS = '@font-face { src: url("./a.woff2"); }\n';

const PLANTED_CSS = ".a {\n  color: #123456;\n}\n";
const NAMED_CSS = [
  ".a { color: red; }",
  ".b {",
  "  box-shadow:",
  "    0 0 0 1px black;",
  "}",
  ".c { background: oklch(70% 0.1 200); }",
  ".d { outline-color: color(display-p3 1 0 0); }",
  ".e { fill: lab(50% 40 59); border-color: hwb(0 0% 0%); }",
  ".f { color: lch(50% 40 60); stroke: oklab(0.6 0.1 0.1); }",
].join("\n");
const NESTED_CSS = [
  ".a {",
  "  &:hover { color: var(--ink); }",
  "  border-color: red;",
  "}",
  ".b {",
  "  @media (min-width: 40rem) { color: var(--ink); }",
  "  background: #123456;",
  "}",
].join("\n");
const DATA_CSS = [
  ".b { background: url(\"data:image/svg+xml;utf8,<svg fill='red'/>\"); }",
  ".c { background: url(\"data:image/svg+xml;charset=utf-8,%3Csvg fill='rgb(1,2,3)'/%3E\"); }",
  ".d { background: url(\"data:image/svg+xml,%3Csvg fill='%23ff0000'/%3E\"); }",
  ".e { mask: url(\"DATA:image/svg+xml;utf8,<svg fill='red'/>\") center; color: var(--ink); }",
  '.f { background: url("data:image/svg+xml,%3Csvg%20fill%3D%22red%22%2F%3E"); }',
  ".k { background: url(data:image/svg+xml;base64,PHN2Zy8+); }",
  '.g { content: "url("; }',
  ".h { color: red; }",
  ".i { width: calc(1px); }",
  ".l { background-image: image-set(\"data:image/svg+xml;utf8,<svg fill='red'/>\" 1x); }",
  '.m { background-image: -webkit-image-set("data:image/svg+xml,%3Csvg%20fill%3D%22red%22%2F%3E" 1x); }',
  '@import "data:text/css,.x%7Bcolor:red%7D";',
].join("\n");

const CLEAN_TSX = "export const a = 1;\n";
const QUIET_TSX = [
  "// #abcdef in a line comment, hsl( too",
  "/* rgba( in a block */",
  'const ellipsis = "&#8230;";',
].join("\n");
const WORDS_TSX = [
  "const c = bandColor(1);",
  'const label = "Red tyre";',
  'const k = "green-ish";',
  'const band = { label: "Green" };',
  'const link = <a href="#add-driver">Add</a>;',
  "const shade = color(1);",
  'const grad = <path fill="url(#fade)" />;',
].join("\n");
const PLANTED_TSX = [
  'const glob = "./*.gallery.tsx";',
  'const a = { color: "rgba(0, 0, 0, 0.5)" };',
  "const b = `hsl(${1}, 50%, 50%)`;",
  "// */",
  'const d = <path fill="white" />;',
  "const e = { color: 'Tomato' };",
  'const f = <div style={{ border: "1px solid red" }} />;',
  'const g = { boxShadow: "0 0 0 1px black" };',
  'const h = { background: "oklch(70% 0.1 200)" };',
].join("\n");
const TOKENS_TS = 'export const ink = "#111417";\n';
const BOX_TEST_TSX = 'const c = "#ffffff";\n';
const FIXTURES_TS = 'const c = "rgb(0, 0, 0)";\n';

const CSS_FORMS_REFUSED = lines(
  ".a { color: RGB(0 0 0); }",
  '@import url("data:text/css,.x%7Bcolor:red%7D");',
  '@import "./plain.css";',
  ".b { background-image: image-set(url(./a.png) 1x); }",
  '.c { background-image: image("./a.png"); }',
  ".d { --brand: #abcdef; --shade: red; }",
  ".e { color: color-mix(in srgb, red 50%, var(--ink)); }",
  '.f { background: URL("data:image/png;base64,AAAA"); }',
  '.g { background: url( "data:image/png;base64,AAAA" ); }',
  ".h { background: Url(DATA:image/png;base64,AAAA); }",
  ".i { background: url(",
  '  "data:image/png;base64,AAAA"); }',
  '@IMPORT url("data:text/css,.x%7Bcolor:red%7D");',
  ".j { color: rgba(0, 0, 0, 0.5); background: hsl(0 0% 0%); border-color: hsla(0, 0%, 0%, 1); outline-color: rgb(0 0 0); }",
  '.k { background-image: IMAGE-SET("./a.png" 1x); mask-image: IMAGE("./a.png"); }',
  '.l { background: src("data:image/png;base64,AAAA"); mask: SRC("./a.svg"); }',
);
const CSS_FORMS_REFUSED_WANT = [
  "1: function-disallowed-list",
  "2: at-rule-disallowed-list",
  "3: at-rule-disallowed-list",
  "4: function-disallowed-list",
  "5: function-disallowed-list",
  "6: color-named",
  "6: color-no-hex",
  "7: color-named",
  "8: function-url-scheme-disallowed-list",
  "9: function-url-scheme-disallowed-list",
  "10: function-url-scheme-disallowed-list",
  "11: function-url-scheme-disallowed-list",
  "13: at-rule-disallowed-list",
  "14: function-disallowed-list",
  "14: function-disallowed-list",
  "14: function-disallowed-list",
  "14: function-disallowed-list",
  "15: function-disallowed-list",
  "15: function-disallowed-list",
  "16: function-disallowed-list",
  "16: function-disallowed-list",
];

const CSS_FORMS_QUIET = lines(
  '.a::before { content: "#fff"; }',
  '.b::before { content: "rgb("; }',
  '.c::before { content: "data:"; }',
  ".d { mask: url(./a.svg#fff); }",
  ".e { background: url( #fade ); }",
  'a[href^="data:"] { color: var(--ink); }',
  '@supports (background: url("data:image/png;base64,AAAA")) { .f { color: var(--ink); } }',
  '@namespace svg url("data:x");',
  '.g::before { content: "Red"; }',
  ".h { grid-area: tan; }",
  '@font-face { font-family: "x"; src: url("./a.woff2") format("woff2"); }',
);

const DISABLED_CSS = lines(
  "/* stylelint-disable */",
  ".a { color: red; }",
  "/* stylelint-enable */",
  "/* stylelint-disable-next-line color-no-hex */",
  ".b { color: #fff; }",
  ".c { color: red; } /* stylelint-disable-line */",
);

// The regex literal holds "//", which must not open a comment.
const TICKET_TSX = lines(
  String.raw`const re = /https?:\/\//; const c = { color: "#fff" };`,
  'const t = { color: on ? "red" : "blue" };',
  'const order = "Order #1234";',
  'const l = <a href="/vehicles#cafe">x</a>;',
);

const TSX_SHAPES_REFUSED = lines(
  'const p1 = "#fff";',
  'const p2 = { boxShadow: "0 0 0 1px #abcdef" };',
  'const p3 = <stop stopColor="red" />;',
  'el.style.color = "red";',
  'color = "red";',
  '{ const fill = "white"; }',
  '{ const fill: "white" = x; }',
  'function f(color = "red") { return color; }',
  'class K { fill = "red"; }',
  'const p10 = <a href="#add">x</a>;',
  'const p11 = { color: "#FFF", stroke: "RED" };',
  "const p12 = { color: `${tone} red` };",
  'const { color: c2 = "red" } = props;',
  'const p14 = { color() { return "red"; } };',
  'const p15 = <Chip color="red" />;',
  'const p16 = { "color": "red" };',
  'class M { "stroke" = "red"; }',
  'const p18 = { backgroundColor: "red", borderTopColor: "red", outlineColor: "red", floodColor: "red", lightingColor: "red", textShadow: "0 0 red", caretColor: "red", accentColor: "red", textDecorationColor: "red", columnRuleColor: "red" };',
  'const p19 = { color: "#fff8", fill: "#ffffff80" };',
  'const p20 = ["lab(50% 40 59)", "lch(50% 40 60)", "hwb(0 0% 0%)", "oklab(0.6 0.1 0.1)", "hsla(0, 0%, 0%, 1)", "color(display-p3 1 0 0)", "rgb(0 0 0)", "hsl(0 0% 0%)"];',
  'const p21 = { ["fill"]: "red" };',
  'el.style["color"] = "red";',
  'class N2 { ["stroke"] = "red"; }',
  'enum E { color = "red" }',
  'enum E2 { "fill" = "red" }',
  'class C6 { accessor fill = "red"; }',
  'const p27 = { background: "red", outline: "red" };',
  'const p28 = " #fff ";',
  'const p29 = <stop stop-color="red" />;',
  'const p30 = <feFlood flood-color="black" />;',
  'const p31 = <feDiffuseLighting lighting-color="white" />;',
  'const p32 = <stop stop-color="0 #abcdef" />;',
  'class C10 { accessor "fill" = "red"; }',
);
const TSX_SHAPES_REFUSED_WANT = [
  "1: hex",
  "2: hexInStyle",
  "3: namedInStyle",
  "4: namedInStyle",
  "5: namedInStyle",
  "6: namedInStyle",
  "7: namedInStyle",
  "8: namedInStyle",
  "9: namedInStyle",
  "10: hex",
  "11: hex",
  "11: hexInStyle",
  "11: namedInStyle",
  "12: namedInStyle",
  "13: namedInStyle",
  "14: namedInStyle",
  "15: namedInStyle",
  "16: namedInStyle",
  "17: namedInStyle",
  ...Array<string>(10).fill("18: namedInStyle"),
  "19: hex",
  "19: hex",
  "19: hexInStyle",
  "19: hexInStyle",
  ...Array<string>(8).fill("20: colourFunction"),
  "21: namedInStyle",
  "22: namedInStyle",
  "23: namedInStyle",
  "24: namedInStyle",
  "25: namedInStyle",
  "26: namedInStyle",
  "27: namedInStyle",
  "27: namedInStyle",
  "28: hex",
  "29: namedInStyle",
  "30: namedInStyle",
  "31: namedInStyle",
  "32: hexInStyle",
  "33: namedInStyle",
];

const TSX_SHAPES_QUIET = lines(
  'const q1 = <path fill="none" stroke="currentColor" />;',
  'const q2 = { color: "transparent" };',
  'const q3 = { border: "1px solid var(--ink)" };',
  'const q4 = "0 0 0 1px #abcdef";',
  'type T = { color: "red" | "blue" };',
  'function g(color: "red") { return color; }',
  'const q7 = on ? color : "red";',
  'const q8 = { [color]: "red" };',
  'class L { label = "Red"; }',
  'const q10 = "#12345";',
  'const q11 = "#1234567";',
  'el.style[color] = "red";',
  'const q13 = { "background-color": "red" };',
  'const q14 = { background: "url(./red.svg)", outline: "icons/red", fill: "var(--red)", stroke: "red-500", color: "x.red", border: "red.svg", boxShadow: "url(#red)" };',
  'const q15 = { background: "url(sprite.svg#fee-section)" };',
  'const q16 = "RGB(0 0 0)";',
  'const q17 = "bandcolor(1)";',
  'class N { [fill] = "red"; }',
  'class K2 { color() { return "red"; } get fill() { return "red"; } }',
  'const q20 = { color: "&#8230;", border: "&#160;" };',
  'class C9 { accessor [fill] = "red"; }',
  'const q22 = { stroke: "infrared", Color: "red" };',
  'const q23 = <div data-color="red" />;',
);

const EXEMPT_TSX = lines(
  'export const ink = "#111417";',
  'export const c = "rgb(0, 0, 0)";',
  'export const shade = { color: "red" };',
);

const TIME_TSX = lines(
  'export const f = new Intl.DateTimeFormat("en-ZA");',
  "export const s = new Date().toLocaleString();",
  'export const c = { color: "red" };',
);
const TIME_TEST_TSX = lines(
  'export const f = new Intl.DateTimeFormat("en-ZA");',
  'export const c = { color: "red" };',
  "export const s = new Date().toLocaleString();",
);
const BOUNDARY_TSX = lines(
  'import { Component } from "react";',
  "export class B extends Component { render() { return null; } }",
  'export const c = { color: "red" };',
  "export const s = new Date().toLocaleString();",
);
const E2E_TSX = lines(
  'export const c = { color: "red" };',
  'export const h = "#fff";',
  "export const s = new Date().toLocaleString();",
);

const UI = "src/ui/TyreTile.tsx";

describe("the colour gate in a stylesheet", { timeout: 120_000 }, () => {
  it("refuses a hex, a named colour, a colour function and a data: URL in a value", async () => {
    expect(await css("src/ui/planted.css", PLANTED_CSS)).toEqual(want(["2: color-no-hex"]));
    expect(await css("src/ui/named.css", NAMED_CSS)).toEqual(
      want([
        "1: color-named",
        "4: color-named",
        "6: function-disallowed-list",
        "7: function-disallowed-list",
        "8: function-disallowed-list",
        "8: function-disallowed-list",
        "9: function-disallowed-list",
        "9: function-disallowed-list",
      ]),
    );
    expect(await css("src/ui/nested.css", NESTED_CSS)).toEqual(
      want(["3: color-named", "7: color-no-hex"]),
    );
    expect(await css("src/ui/data.css", DATA_CSS)).toEqual(
      want([
        "1: function-url-scheme-disallowed-list",
        "2: function-url-scheme-disallowed-list",
        "3: function-url-scheme-disallowed-list",
        "4: function-url-scheme-disallowed-list",
        "5: function-url-scheme-disallowed-list",
        "6: function-url-scheme-disallowed-list",
        "8: color-named",
        "10: function-disallowed-list",
        "11: function-disallowed-list",
        "12: at-rule-disallowed-list",
      ]),
    );
  });

  it("passes comments, keywords, selectors, paths and an SVG fragment", async () => {
    expect(await css("src/ui/quiet.css", QUIET_CSS)).toEqual([]);
    expect(await css("src/ui/keywords.css", KEYWORDS_CSS)).toEqual([]);
    expect(await css("src/ui/anchors.css", ANCHORS_CSS)).toEqual([]);
    expect(await css("src/ui/paths.css", PATHS_CSS)).toEqual([]);
    expect(await css("src/theme/fonts.css", FONTS_CSS)).toEqual([]);
  });

  it("refuses RGB(), @import, the bare-string image functions and every spelling of url()", async () => {
    expect(await css("src/ui/added.css", CSS_FORMS_REFUSED)).toEqual(want(CSS_FORMS_REFUSED_WANT));
  });

  it("passes a colour or data: written where nothing paints or loads it", async () => {
    expect(await css("src/ui/quiet-added.css", CSS_FORMS_QUIET)).toEqual([]);
  });

  it("refuses a colour under an inline stylelint-disable", async () => {
    expect(await css("src/ui/disabled.css", DISABLED_CSS)).toEqual(
      want(["2: color-named", "5: color-no-hex", "6: color-named"]),
    );
  });
});

describe("the colour gate in a component", { timeout: 120_000 }, () => {
  it("fails on a planted file that does not parse, never reads it as quiet", async () => {
    await expect(tsx(UI, "const = ;\n")).rejects.toThrow(UI);
  });

  it("refuses a colour function anywhere and a named colour under a style key", async () => {
    expect(await tsx(UI, PLANTED_TSX)).toEqual(
      want([
        "2: colourFunction",
        "3: colourFunction",
        "5: namedInStyle",
        "6: namedInStyle",
        "7: namedInStyle",
        "8: namedInStyle",
        "9: colourFunction",
      ]),
    );
  });

  it("passes comments, entities, labels, anchors and an SVG fragment", async () => {
    expect(await tsx(UI, CLEAN_TSX)).toEqual([]);
    expect(await tsx(UI, QUIET_TSX)).toEqual([]);
    expect(await tsx(UI, WORDS_TSX)).toEqual([]);
  });

  it("exempts tokens.ts and the test files, and refuses the same text elsewhere", async () => {
    const exempt = ["src/theme/tokens.ts", "src/ui/Badge.test.tsx", "src/test/fixtures.ts"];
    for (const path of exempt) {
      expect(await tsx(path, EXEMPT_TSX)).toEqual([]);
    }
    expect(await tsx(UI, EXEMPT_TSX)).toEqual(
      want(["1: hex", "2: colourFunction", "3: namedInStyle"]),
    );
    expect(await tsx("src/theme/tokens.ts", TOKENS_TS)).toEqual([]);
    expect(await tsx(UI, TOKENS_TS)).toEqual(want(["1: hex"]));
    expect(await tsx("src/ui/Badge.test.tsx", BOX_TEST_TSX)).toEqual([]);
    expect(await tsx(UI, BOX_TEST_TSX)).toEqual(want(["1: hex"]));
    expect(await tsx("src/test/fixtures.ts", FIXTURES_TS)).toEqual([]);
    expect(await tsx(UI, FIXTURES_TS)).toEqual(want(["1: colourFunction"]));
  });

  it("refuses a hex after a regex literal and both arms of a ternary, and passes an order number and a link fragment", async () => {
    expect(await tsx(UI, TICKET_TSX)).toEqual(
      want(["1: hex", "1: hexInStyle", "2: namedInStyle", "2: namedInStyle"]),
    );
  });

  it("refuses a colour in each shape the gate reads as a style value", async () => {
    expect(await tsx(UI, TSX_SHAPES_REFUSED)).toEqual(want(TSX_SHAPES_REFUSED_WANT));
  });

  it("passes a string that no style key takes", async () => {
    expect(await tsx(UI, TSX_SHAPES_QUIET)).toEqual([]);
  });

  it("keeps each file's own bans and adds the colour bans only inside its scope", async () => {
    expect(await tsx("src/time/tenantTime.ts", TIME_TSX)).toEqual(
      want(["2: app", "3: namedInStyle"]),
    );
    expect(await tsx(UI, TIME_TSX)).toEqual(want(["1: app", "2: app", "3: namedInStyle"]));

    expect(await tsx("src/time/tenantTime.test.tsx", TIME_TEST_TSX)).toEqual(want(["3: app"]));
    expect(await tsx(UI, TIME_TEST_TSX)).toEqual(want(["1: app", "2: namedInStyle", "3: app"]));

    expect(await tsx("src/shell/RouteErrorBoundary.tsx", BOUNDARY_TSX)).toEqual(
      want(["3: namedInStyle", "4: app"]),
    );
    expect(await tsx(UI, BOUNDARY_TSX)).toEqual(
      want(["1: app", "2: app", "3: namedInStyle", "4: app"]),
    );

    expect(await tsx("e2e/dashboard.spec.ts", E2E_TSX)).toEqual(want(["3: app"]));
    expect(await tsx(UI, E2E_TSX)).toEqual(want(["1: namedInStyle", "2: hex", "3: app"]));
  });
});

describe("the named colours", { timeout: 120_000 }, () => {
  it("refuses each of the 148 in a stylesheet and under a style key", async () => {
    expect(NAMED_COLOURS).toHaveLength(148);
    const cssCode = NAMED_COLOURS.map((name, i) => `.c${i} { color: ${name}; }`).join("\n") + "\n";
    const tsCode =
      NAMED_COLOURS.map((name, i) => `export const c${i} = { color: "${name}" };`).join("\n") +
      "\n";
    expect(await css("src/ui/named-all.css", cssCode)).toEqual(
      want(NAMED_COLOURS.map((_, i) => `${i + 1}: color-named`)),
    );
    expect(await tsx(UI, tsCode)).toEqual(
      want(NAMED_COLOURS.map((_, i) => `${i + 1}: namedInStyle`)),
    );
  });
});
