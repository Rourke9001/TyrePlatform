import { describe, expect, it } from "vitest";

import { cssRules, declarations } from "../test/cssRules";
import { BRAND_SLOT } from "./tokens";

// U53 (TYRE-276): the tenant's brand colours chrome and filled controls only.
// jsdom never applies a stylesheet, so this reads the CSS and component
// source and fails on any brand read outside the list below.
const sheets = import.meta.glob<string>("/src/**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

// The source files, to find who reads or writes a brand property.
const sources = import.meta.glob<string>(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/test/**"],
  { query: "?raw", import: "default", eager: true },
);

// Chrome and filled controls, whose text is --on-brand, derived to clear
// 4.5:1 on the brand (TYRE-27). Keyed by file, selector and property, so an
// allowed rule that gains a brand outline or an alias still fails (TYRE-343).
// After wave 0 a lane that needs another entry asks the orchestrator
// (TYRE-443).
const BRAND_ALLOWED: Record<string, Record<string, string[]>> = {
  // Today's screens: filled buttons and the go key.
  "/src/capture/capture.css": {
    ".cap-key--go": ["border-color", "background", "color"],
    ".cap-key--go:active": ["background"],
    ".cap-primary": ["border", "background", "color"],
    ".cap-primary:active": ["background", "border-color"],
  },
  "/src/ui/legacy/ui.css": {
    ".btn-primary": ["background", "color"],
    ".btn-primary:hover": ["background"],
    ".btn-primary:active": ["background"],
    '.btn-primary:hover:not(:disabled, [aria-disabled="true"])': ["background"],
    '.btn-primary:active:not(:disabled, [aria-disabled="true"])': ["background"],
  },
  // Tread's chrome, as its component source writes it: the logo tile, the
  // primary button, an icon button on the brand band, the keypad's go key,
  // the active nav marker, and the driver and phone app bars.
  "/src/ui/AppShell.css": {
    '.tr-nav[aria-current="page"]::before': ["background"],
    ".tr-shell__top": ["background", "color"],
  },
  "/src/ui/BrandMark.css": {
    ".tr-brandmark__tile": ["background", "color"],
    ".tr-brandmark__tile--on-brand": ["box-shadow"],
  },
  "/src/ui/Button.css": {
    ".tr-btn--primary": ["background", "color"],
    ".tr-btn--primary:hover:not(:disabled)": ["background"],
    ".tr-btn--primary:active:not(:disabled)": ["background"],
  },
  "/src/ui/DriverShell.css": {
    ".tr-driver__bar": ["background", "color"],
  },
  "/src/ui/IconButton.css": {
    ".tr-iconbtn--on-brand": ["color"],
    ".tr-iconbtn--on-brand:hover:not(:disabled)": ["background"],
    ".tr-iconbtn--on-brand:disabled": ["color"],
  },
  "/src/ui/Keypad.css": {
    ".tr-key--go": ["background", "color"],
    ".tr-key--go:active:not(:disabled)": ["background"],
  },
};

type Files = Record<string, string>;

const show = (file: string, selector: string, property: string) =>
  `${file}: ${selector} { ${property} }`;

const ALLOWED = new Set(
  Object.entries(BRAND_ALLOWED).flatMap(([file, rules]) =>
    Object.entries(rules).flatMap(([selector, properties]) =>
      properties.map((property) => show(file, selector, property)),
    ),
  ),
);

// The names come from tokens.ts's brand slot, so a slot token added there is
// checked here unedited.
const names = (slot: readonly string[]) => `(?:${slot.map((n) => `--${n}`).join("|")})`;
const BRAND = names(BRAND_SLOT);
// Reads with a fallback, var(--brand, x), and with spaces count (TYRE-336).
const BRAND_READ = new RegExp(String.raw`var\(\s*${BRAND}\s*[,)]`);
const BRAND_LITERAL = new RegExp(String.raw`["'\`]${BRAND}["'\`]`);
const BRAND_FILL_READ = new RegExp(
  String.raw`var\(\s*${names(BRAND_SLOT.filter((n) => !n.startsWith("on-")))}\s*[,)]`,
);

// themeCss writes the platform default and brandVars the tenant's, which
// ThemeProvider applies to the root; both live in tokens.ts.
const BRAND_WRITERS = new Set(["/src/theme/tokens.ts"]);

function brandReads(css: Files) {
  return Object.entries(css).flatMap(([file, text]) =>
    cssRules(text).flatMap((rule) =>
      declarations(rule.body)
        .filter((d) => BRAND_READ.test(d.value))
        .flatMap((d) => rule.selectors.map((selector) => ({ file, selector, ...d }))),
    ),
  );
}

// An alias, `--x: var(--brand)`, is a property the list never names, so it
// fails here wherever it is declared.
function outsideChrome(css: Files): string[] {
  return brandReads(css)
    .map((r) => show(r.file, r.selector, r.property))
    .filter((read) => !ALLOWED.has(read));
}

// Text in a brand colour fails on some ground for some tenant: the platform
// brand is 2.21:1 on Night shift's surface, a light one fails on white.
// Text on a brand fill is --on-brand (U53).
function brandText(css: Files): string[] {
  return brandReads(css)
    .filter((r) => r.property === "color" && BRAND_FILL_READ.test(r.value))
    .map((r) => show(r.file, r.selector, r.property));
}

// A stylesheet or component that set --brand itself could put the tenant
// colour, or a stale one, under a subtree ThemeProvider does not govern;
// one that read it inline would escape the list above.
function writersAndInlineReads(css: Files, source: Files): string[] {
  const slot = new Set(BRAND_SLOT.map((n) => `--${n}`));
  const inCss = Object.entries(css).flatMap(([file, text]) =>
    cssRules(text).flatMap((rule) =>
      declarations(rule.body)
        .filter((d) => slot.has(d.property))
        .map((d) => show(file, rule.selectors.join(", "), d.property)),
    ),
  );
  const inSource = Object.entries(source)
    .filter(
      ([file, text]) =>
        !BRAND_WRITERS.has(file) && (BRAND_LITERAL.test(text) || BRAND_READ.test(text)),
    )
    .map(([file]) => file);
  return [...inCss, ...inSource];
}

describe("the tenant brand stays in chrome (U53)", () => {
  // Without this, a glob or parser that found nothing would pass the rest.
  it("sees the stylesheets and the chrome rules in them", () => {
    expect(Object.keys(sheets).length).toBeGreaterThanOrEqual(6);
    const selectors = brandReads(sheets).map((r) => r.selector);
    expect(selectors).toContain(".tr-brandmark__tile");
    expect(selectors).toContain(".cap-primary");
    expect(Object.keys(sources)).toContain("/src/theme/tokens.ts");
    expect(sources["/src/theme/ThemeProvider.tsx"]).toContain("brandVars(");
  });

  it("colours no in-content text, outline or ring with the brand", () => {
    expect(outsideChrome(sheets)).toEqual([]);
  });

  it("sets no text in a brand colour", () => {
    expect(brandText(sheets)).toEqual([]);
  });

  it("writes the brand tokens only through themeCss and ThemeProvider", () => {
    expect(writersAndInlineReads(sheets, sources)).toEqual([]);
  });
});

// TYRE-343 (f): each hole the checks above close, planted here rather than
// in a stylesheet, must fail them.
describe("the brand checks catch each planted read", () => {
  const capture = "/src/capture/capture.css";
  const elsewhere = "/src/fleet/fleet.css";

  it.each<[string, Files]>([
    [
      "(a) an allowed rule's other property",
      { [capture]: ".cap-primary { outline-color: var(--brand); }" },
    ],
    [
      "(a) an allowed selector in another file",
      { [elsewhere]: ".cap-primary { background: var(--brand); }" },
    ],
    [
      "(b) a rule in @media",
      { [elsewhere]: "@media (min-width: 640px) { .x { color: var(--brand); } }" },
    ],
    [
      "(b) a rule in @supports",
      { [elsewhere]: "@supports (display: grid) { .x { border-color: var(--brand); } }" },
    ],
    [
      "(b) a nested rule",
      {
        [capture]:
          ".cap-primary { background: var(--brand); .x { outline: 2px solid var(--brand); } }",
      },
    ],
    [
      "(b) a parent's own read before a nested rule",
      { [elsewhere]: ".x { border-color: var(--brand); .y { margin: 0; } }" },
    ],
    ["(e) a read with a fallback", { [elsewhere]: ".x { background: var(--brand, #000); }" }],
    ["(e) a read with spaces", { [elsewhere]: ".x { background: var( --brand ); }" }],
    ["(e) an alias in an allowed rule", { [capture]: ".cap-primary { --accent: var(--brand); }" }],
    ["(e) an alias elsewhere", { [elsewhere]: ".x { --accent: var(--on-brand); }" }],
  ])("%s", (_, css) => {
    expect(outsideChrome(css)).not.toEqual([]);
  });

  // (d): every name in tokens.ts's slot is a brand read.
  it.each(BRAND_SLOT)("(d) a read of --%s", (name) => {
    expect(outsideChrome({ [elsewhere]: `.x { fill: var(--${name}); }` })).not.toEqual([]);
  });

  it.each(["brand", "brand-hover", "brand-pressed"])("text in --%s on an allowed rule", (name) => {
    expect(brandText({ [capture]: `.cap-primary { color: var(--${name}); }` })).not.toEqual([]);
  });

  it.each<[string, Files, Files]>([
    ["a stylesheet that sets the brand", { [elsewhere]: ".x { --brand: #e2202a; }" }, {}],
    [
      "(c) a component that reads the brand inline",
      {},
      { "/src/fleet/Badge.tsx": 'const style = { color: "var(--brand)" };' },
    ],
    [
      "(c) a read with a fallback inline",
      {},
      { "/src/fleet/Badge.tsx": "const c = `var(--brand-hover, red)`;" },
    ],
    [
      "a component that sets the brand",
      {},
      { "/src/fleet/Badge.tsx": 'el.style.setProperty("--on-brand", c);' },
    ],
  ])("%s", (_, css, source) => {
    expect(writersAndInlineReads(css, source)).not.toEqual([]);
  });
});
