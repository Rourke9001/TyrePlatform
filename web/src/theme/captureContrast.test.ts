import { describe, expect, it } from "vitest";

import { cssRules, declarations } from "../test/cssRules";
import { contrastRatio } from "./derive";
import { themes, type ColorToken, type ThemeName } from "./tokens";

// IR-UI-005 (SRS §3.1): the capture interface holds 7:1 for text and 4.5:1
// for a mark that carries a state, in Daylight and in Night shift. U157's
// erratum holds text on the tenant's brand fill at 4.5:1, the floor
// deriveBrandTheme guarantees for any tenant colour (derive.test.ts).
const sheets = import.meta.glob<string>("/src/capture/**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

const THEME_NAMES: ThemeName[] = ["light", "dark"];

// Every ground capture sets text or a mark on.
const GROUNDS: ColorToken[] = ["canvas", "surface", "surface-muted", "warn-soft", "critical-soft"];

// Text that may sit on any ground above.
const TEXT: ColorToken[] = ["ink", "ink-secondary", "critical-text"];

// Text on a fill, with the fill and its floor.
const ON_FILL: [ColorToken, ColorToken, number][] = [
  ["on-ok", "ok", 7],
  ["on-warn", "warn", 7],
  ["on-brand", "brand", 4.5],
];

// A tile's border, an alert's bar, the active ring and field.
const MARKS: ColorToken[] = [
  "ok-text",
  "warn-text",
  "critical-text",
  "unmeasured",
  "interactive",
  "ink-muted",
];

// --line draws dividers and resting edges, which carry no state.
const DIVIDER: ColorToken = "line";

// A pressed key's fill lasts as long as the tap.
const PRESSED: ColorToken[] = ["brand-pressed", "on-warn"];

const FILLS = ON_FILL.map(([, fill]) => fill);

// The colour tokens a value reads; space, type and radius tokens are not
// colours.
function tokensIn(value: string): string[] {
  return [...value.matchAll(/var\(\s*--([a-z0-9-]+)/g)]
    .map((m) => m[1])
    .filter((name) => name in themes.light);
}

// Each colour a capture stylesheet reads, with the role this file checks it
// in, or "unchecked" when no table above holds that use.
function unchecked(): string[] {
  const out: string[] = [];
  for (const [file, css] of Object.entries(sheets)) {
    for (const rule of cssRules(css)) {
      const decls = declarations(rule.body);
      const own = decls
        .filter((d) => d.property === "background" || d.property === "background-color")
        .flatMap((d) => tokensIn(d.value));
      const pressed = rule.selectors.every((s) => s.includes(":active"));
      for (const { property, value } of decls) {
        if (/-(?:radius|width|style)$/.test(property)) continue;
        for (const token of tokensIn(value)) {
          const allowed =
            property === "color"
              ? [...TEXT, ...ON_FILL.map(([text]) => text)]
              : property === "background" || property === "background-color"
                ? [...GROUNDS, ...FILLS, DIVIDER, ...(pressed ? PRESSED : [])]
                : /^(?:border|outline|box-shadow)/.test(property)
                  ? [...MARKS, DIVIDER, ...own]
                  : // The checkbox's tick is drawn by the browser to contrast
                    // with the brand fill it sets.
                    property === "accent-color"
                    ? ["brand"]
                    : [];
          if (!allowed.includes(token)) {
            out.push(`${file}: ${rule.selectors.join(", ")} { ${property}: --${token} }`);
          }
        }
      }
    }
  }
  return out;
}

describe("capture contrast (IR-UI-005)", () => {
  // Without this, a glob or parser that found nothing would pass.
  it("sees the capture stylesheets and a mark in them", () => {
    expect(Object.keys(sheets)).toContain("/src/capture/capture.css");
    const unmeasured = cssRules(sheets["/src/capture/capture.css"]).find((r) =>
      r.selectors.includes(".cap-pos--unmeasured"),
    );
    expect(unmeasured?.body).toContain("var(--unmeasured)");
  });

  it("sets only the colours this file checks", () => {
    expect(unchecked()).toEqual([]);
  });

  it("holds text at 7:1 on every capture ground", () => {
    const short: string[] = [];
    for (const theme of THEME_NAMES) {
      for (const text of TEXT) {
        for (const ground of GROUNDS) {
          const ratio = contrastRatio(themes[theme][text], themes[theme][ground]);
          if (ratio < 7) short.push(`${theme}: ${text} on ${ground} is ${ratio.toFixed(2)}`);
        }
      }
      for (const [text, fill, floor] of ON_FILL) {
        const ratio = contrastRatio(themes[theme][text], themes[theme][fill]);
        if (ratio < floor) short.push(`${theme}: ${text} on ${fill} is ${ratio.toFixed(2)}`);
      }
    }
    expect(short).toEqual([]);
  });

  it("holds every state mark at 4.5:1 on every capture ground", () => {
    const short: string[] = [];
    for (const theme of THEME_NAMES) {
      for (const mark of MARKS) {
        for (const ground of GROUNDS) {
          const ratio = contrastRatio(themes[theme][mark], themes[theme][ground]);
          if (ratio < 4.5) short.push(`${theme}: ${mark} on ${ground} is ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(short).toEqual([]);
  });
});
