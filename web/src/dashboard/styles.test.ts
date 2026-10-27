import { describe, expect, it } from "vitest";

import analyticsCss from "./analytics.css?raw";
import unitListCss from "./dashboard.css?raw";

// jsdom lays nothing out, so a target size or a clip is read from the rule
// the class carries.
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(code)?.[1] ?? "";
}

describe("the unit list's sheet", () => {
  // WCAG 2.4.7: base.css draws a 3px focus outline 2px outside each row
  // link, which a clipping list would cut off; the card's corners come from
  // rounding the end rows instead.
  it("never clips a row's focus ring, and rounds the end rows to the card", () => {
    const code = unitListCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/overflow\s*:\s*(hidden|clip)/);
    expect(ruleBody(unitListCss, ".unit-rows > li:first-child > .tr-row")).toMatch(
      /border-radius:\s*var\(--radius-lg\)\s+var\(--radius-lg\)\s+0\s+0/,
    );
    expect(ruleBody(unitListCss, ".unit-rows > li:last-child > .tr-row")).toMatch(
      /border-radius:\s*0\s+0\s+var\(--radius-lg\)\s+var\(--radius-lg\)/,
    );
    // A lone row is both ends; the last-child rule alone would square its
    // top corners, so this rule comes after it.
    expect(ruleBody(unitListCss, ".unit-rows > li:only-child > .tr-row")).toMatch(
      /border-radius:\s*var\(--radius-lg\);/,
    );
    expect(code.indexOf("li:only-child")).toBeGreaterThan(code.indexOf("li:last-child"));
  });
});

describe("the overview's sheet", () => {
  // NFR-USE-004: each severity line's link is a 44px target, not a line of
  // text.
  it("gives each severity link the 44px floor", () => {
    const body = ruleBody(analyticsCss, ".severity-lines a");
    expect(body).toMatch(/display:\s*inline-flex/);
    expect(body).toMatch(/align-items:\s*center/);
    expect(body).toMatch(/min-height:\s*var\(--target-min\)/);
  });
});
