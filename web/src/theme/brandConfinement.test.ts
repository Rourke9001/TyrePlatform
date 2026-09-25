import { describe, expect, it } from "vitest";

// U53 (TYRE-276): the tenant's brand colours chrome and filled controls only.
// jsdom never applies a stylesheet, so this reads the CSS source and fails on
// any rule outside the list below that reads a brand custom property.
const sheets = import.meta.glob<string>("/src/**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

// Chrome (the wordmark, the nav's current page) and filled controls, whose
// text is --on-primary, derived to clear 4.5:1 on the brand (TYRE-27).
const BRAND_ALLOWED = new Set([
  ".shell-wordmark",
  '.shell-nav a[aria-current="page"]',
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
]);

const BRAND_VAR = /var\(--(?:on-)?primary(?:-hover|-pressed)?\)/;

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

function brandRules(): { file: string; selector: string }[] {
  const found: { file: string; selector: string }[] = [];
  for (const [file, css] of Object.entries(sheets)) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!BRAND_VAR.test(m[2])) continue;
      for (const selector of splitSelectors(m[1])) found.push({ file, selector });
    }
  }
  return found;
}

describe("the tenant brand stays in chrome (U53)", () => {
  // Without this, a glob or parser that found nothing would pass the next test.
  it("sees the stylesheets and the chrome rules in them", () => {
    expect(Object.keys(sheets).length).toBeGreaterThanOrEqual(6);
    const selectors = brandRules().map((r) => r.selector);
    expect(selectors).toContain(".shell-wordmark");
    expect(selectors).toContain(".cap-primary");
  });

  it("colours no in-content text, outline or ring with the brand", () => {
    const offenders = brandRules()
      .filter((r) => !BRAND_ALLOWED.has(r.selector))
      .map((r) => `${r.file}: ${r.selector}`);
    expect(offenders).toEqual([]);
  });
});
