import { describe, expect, it } from "vitest";

// U53 (TYRE-276): the tenant's brand colours chrome and filled controls only.
// jsdom never applies a stylesheet, so this reads the CSS source and fails on
// any rule outside the list below that reads a brand custom property.
const sheets = import.meta.glob<string>("/src/**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

// The source files, to find who writes a brand property.
const sources = import.meta.glob<string>(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/test/**"],
  { query: "?raw", import: "default", eager: true },
);

// Chrome and filled controls, whose text is --on-brand, derived to clear
// 4.5:1 on the brand (TYRE-27). After wave 0 a lane that needs another
// entry asks the orchestrator (TYRE-443).
const BRAND_ALLOWED = new Set([
  // Today's screens: filled buttons.
  ".btn-primary",
  ".btn-primary:hover",
  ".btn-primary:active",
  '.btn-primary:hover:not(:disabled, [aria-disabled="true"])',
  '.btn-primary:active:not(:disabled, [aria-disabled="true"])',
  ".cap-key--go",
  ".cap-key--go:active",
  ".cap-primary",
  ".cap-primary:active",
  ".cap-check",
  ".auth-primary",
  '.auth-primary:hover:not([aria-disabled="true"])',
  '.auth-primary:active:not([aria-disabled="true"])',
  // Tread's chrome, as its component source writes it: the logo tile, the
  // primary button, an icon button on the brand band, the keypad's go key,
  // the active nav marker, and the driver and phone app bars.
  ".tr-brandmark__tile",
  ".tr-brandmark__tile--on-brand",
  ".tr-btn--primary",
  ".tr-btn--primary:hover:not(:disabled)",
  ".tr-btn--primary:active:not(:disabled)",
  ".tr-iconbtn--on-brand",
  ".tr-iconbtn--on-brand:hover",
  ".tr-key--go",
  '.tr-nav[aria-current="page"]::before',
  ".tr-driver__bar",
  ".tr-shell__top",
]);

const BRAND_NAME = String.raw`--(?:on-)?brand(?:-hover|-pressed)?`;
const BRAND_READ = new RegExp(String.raw`var\(${BRAND_NAME}\)`);
const BRAND_DECLARED = new RegExp(String.raw`(?:^|[;{\s])${BRAND_NAME}\s*:`);
const BRAND_LITERAL = new RegExp(String.raw`["'\`]${BRAND_NAME}["'\`]`);

// themeCss writes the platform default and brandVars the tenant's, which
// ThemeProvider applies to the root; both live in tokens.ts.
const BRAND_WRITERS = new Set(["/src/theme/tokens.ts"]);

// A selector list splits on top-level commas only: `:not(a, b)` is one.
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim().replace(/\s+/g, " ")).filter((s) => s !== "");
}

function rules(): { file: string; selectors: string[]; body: string }[] {
  const found: { file: string; selectors: string[]; body: string }[] = [];
  for (const [file, css] of Object.entries(sheets)) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      found.push({ file, selectors: splitSelectors(m[1]), body: m[2] });
    }
  }
  return found;
}

function brandRules(): { file: string; selector: string }[] {
  return rules()
    .filter((r) => BRAND_READ.test(r.body))
    .flatMap((r) => r.selectors.map((selector) => ({ file: r.file, selector })));
}

describe("the tenant brand stays in chrome (U53)", () => {
  // Without this, a glob or parser that found nothing would pass the next test.
  it("sees the stylesheets and the chrome rules in them", () => {
    expect(Object.keys(sheets).length).toBeGreaterThanOrEqual(6);
    const selectors = brandRules().map((r) => r.selector);
    expect(selectors).toContain(".btn-primary");
    expect(selectors).toContain(".cap-primary");
    expect(Object.keys(sources)).toContain("/src/theme/tokens.ts");
    expect(sources["/src/theme/ThemeProvider.tsx"]).toContain("brandVars(");
  });

  // Text in a brand colour fails on some ground for some tenant: the platform
  // brand is 2.21:1 on Night shift's surface, a light one fails on white.
  // Text on a brand fill is --on-brand, derived to clear 4.5:1 (U53).
  it("sets no text in a brand colour", () => {
    const brandText = /(?:^|[;\s])color\s*:[^;]*var\(\s*--brand(?:-hover|-pressed)?\s*[,)]/;
    const offenders = rules()
      .filter((r) => brandText.test(r.body))
      .map((r) => `${r.file}: ${r.selectors.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  it("colours no in-content text, outline or ring with the brand", () => {
    const offenders = brandRules()
      .filter((r) => !BRAND_ALLOWED.has(r.selector))
      .map((r) => `${r.file}: ${r.selector}`);
    expect(offenders).toEqual([]);
  });

  // A stylesheet or component that set --brand itself could put the tenant
  // colour, or a stale one, under a subtree ThemeProvider does not govern.
  it("writes the brand tokens only through themeCss and ThemeProvider", () => {
    const inCss = rules()
      .filter((r) => BRAND_DECLARED.test(r.body))
      .map((r) => `${r.file}: ${r.selectors.join(", ")}`);
    expect(inCss).toEqual([]);
    const inSource = Object.entries(sources)
      .filter(([file, text]) => !BRAND_WRITERS.has(file) && BRAND_LITERAL.test(text))
      .map(([file]) => file);
    expect(inSource).toEqual([]);
  });
});
