import { describe, expect, it } from "vitest";

import { cssRules, declarations } from "../test/cssRules";
import { contrastRatio } from "./derive";
import { themes, type ColorToken, type ThemeName } from "./tokens";

// IR-UI-005 (SRS §3.1): the capture interface holds 7:1 for text and 4.5:1
// for a mark that carries a state, in Daylight and in Night shift. U157's
// erratum holds text on the tenant's brand fill at 4.5:1, the floor
// deriveBrandTheme guarantees for any tenant colour (derive.test.ts). U158:
// the floors cover everything a driver sees, so the shell, sign-in and base
// sheets the driver routes render are read too. Of Tread's sheets only the
// driver's own shell is listed: the shared ones carry manager variants no
// driver reaches.
const sheets = import.meta.glob<string>(
  [
    "/src/capture/**/*.css",
    "/src/driver/**/*.css",
    "/src/shell/shell.css",
    "/src/auth/auth.css",
    "/src/ui/base.css",
    "/src/ui/DriverShell.css",
  ],
  { query: "?raw", import: "default", eager: true },
);

// DevBar and the tenant switcher render in development only.
const DEV_ONLY = [".dev-bar", ".shell-tenant"];

const devOnly = (selectors: string[]) =>
  selectors.every((s) => DEV_ONLY.some((prefix) => s.startsWith(prefix)));

const THEME_NAMES: ThemeName[] = ["light", "dark"];

// Every ground a driver's screen sets text or a mark on.
const GROUNDS: ColorToken[] = ["canvas", "surface", "surface-muted", "warn-soft", "critical-soft"];

// Text that may sit on any ground above; a link is --interactive.
const TEXT: ColorToken[] = ["ink", "ink-secondary", "critical-text", "interactive"];

// Text on a fill, with the fill and its floor. A hovered or pressed brand
// fill keeps the brand's floor.
const ON_FILL: [ColorToken, ColorToken, number][] = [
  ["on-ok", "ok", 7],
  ["on-warn", "warn", 7],
  ["on-brand", "brand", 4.5],
  ["on-brand", "brand-hover", 4.5],
  ["on-brand", "brand-pressed", 4.5],
];

// A tile's border, an alert's bar, the active ring and field, a ticked box,
// the current page's underline.
const MARKS: ColorToken[] = [
  "ok-text",
  "warn-text",
  "critical-text",
  "unmeasured",
  "interactive",
  "ink-muted",
  "ink",
];

// --line draws dividers and resting edges, which carry no state.
const DIVIDER: ColorToken = "line";

const FILLS = ON_FILL.map(([, fill]) => fill);

const isBackground = (property: string) =>
  property === "background" || property === "background-color";

const isMark = (property: string) => /^(?:border|outline|box-shadow)/.test(property);

// The colour tokens a value reads; space, type and radius tokens are not
// colours.
function tokensIn(value: string): ColorToken[] {
  return [...value.matchAll(/var\(\s*--([a-z0-9-]+)/g)]
    .map((m) => m[1])
    .filter((name): name is ColorToken => name in themes.light);
}

// color-mix(in srgb, ...) mixes the encoded channels, as a browser does.
const MIX =
  /^color-mix\(\s*in srgb\s*,\s*var\(--([a-z0-9-]+)\)\s+(\d+(?:\.\d+)?)%\s*,\s*var\(--([a-z0-9-]+)\)\s*\)$/;

function mixHex(a: string, b: string, share: number): string {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [ca, cb] = [channels(a), channels(b)];
  return `#${ca
    .map((v, i) => Math.round(v * share + cb[i] * (1 - share)))
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}

// The rule a hovered, pressed or focused state restyles, whose text it keeps.
const restyled = (selector: string) =>
  selector.replace(/:(?:hover|active|focus-visible|focus)|:not\([^)]*\)/g, "");

// A fill's text is that fill's own token, set by the rule or by the rule it
// restyles. A mixed fill is worked out and held to its text's floor.
function fillPairs(files: Record<string, string> = sheets): string[] {
  const all = Object.entries(files).flatMap(([file, css]) =>
    cssRules(css)
      .filter((rule) => !devOnly(rule.selectors))
      .map((rule) => ({ file, selectors: rule.selectors, decls: declarations(rule.body) })),
  );
  const textOf = (selector: string): ColorToken | undefined => {
    for (const wanted of [selector, restyled(selector)]) {
      for (const rule of all) {
        if (!rule.selectors.includes(wanted)) continue;
        const color = rule.decls.find((d) => d.property === "color");
        const token = color ? tokensIn(color.value)[0] : undefined;
        if (token) return token;
      }
    }
    return undefined;
  };
  const out: string[] = [];
  for (const rule of all) {
    for (const { property, value } of rule.decls) {
      if (!isBackground(property)) continue;
      const mix = MIX.exec(value);
      const [fill] = tokensIn(value);
      const pair = mix ? undefined : ON_FILL.find(([, f]) => f === fill);
      if (!mix && !pair) continue;
      for (const selector of rule.selectors) {
        const text = textOf(selector);
        const where = `${rule.file}: ${selector}`;
        if (pair) {
          if (text !== pair[0]) out.push(`${where} sets --${fill} under ${text ?? "no text"}`);
          continue;
        }
        const [, a, share, b] = mix ?? [];
        const floor = text === "on-brand" ? 4.5 : 7;
        for (const theme of THEME_NAMES) {
          const t: Record<string, string> = themes[theme];
          const ground = mixHex(t[a], t[b], Number(share) / 100);
          const ratio = text && t[a] && t[b] ? contrastRatio(t[text], ground) : 0;
          if (ratio < floor)
            out.push(`${theme}: ${where} has ${text ?? "no text"} at ${ratio.toFixed(2)}`);
        }
      }
    }
  }
  return out;
}

// Each colour a driver's stylesheet reads, with the role this file checks it
// in, or "unchecked" when no table above holds that use.
function unchecked(files: Record<string, string> = sheets): string[] {
  const out: string[] = [];
  for (const [file, css] of Object.entries(files)) {
    for (const rule of cssRules(css)) {
      if (devOnly(rule.selectors)) continue;
      const decls = declarations(rule.body);
      const own = decls.filter((d) => isBackground(d.property)).flatMap((d) => tokensIn(d.value));
      // A halo in a ground colour gives the focus ring a ground on a fill;
      // the ring's own colour takes the mark check (base.css).
      const halo = rule.selectors.every((s) => s.includes(":focus-visible"));
      const solid = decls
        .filter(
          (d) =>
            (isMark(d.property) || isBackground(d.property)) && !d.value.includes("color-mix("),
        )
        .flatMap((d) => tokensIn(d.value));
      for (const { property, value } of decls) {
        if (/-(?:radius|width|style)$/.test(property)) continue;
        // Dimming takes text and marks under their floors by an amount no
        // token states (TYRE-155's absent spare).
        const alpha = value.endsWith("%") ? parseFloat(value) / 100 : parseFloat(value);
        if ((property === "opacity" && alpha < 1) || property === "filter") {
          out.push(`${file}: ${rule.selectors.join(", ")} { ${property}: ${value} }`);
          continue;
        }
        // fillPairs works a mixed fill out against its text.
        if (isBackground(property) && MIX.test(value)) continue;
        // A see-through colour composites under its floor, so only a ring
        // may use one, echoing a token the rule draws solid as a mark or a
        // fill. That solid use takes the role check below.
        if (/color-mix\(.*\btransparent\b/.test(value)) {
          const ring = /^(?:box-shadow|outline)/.test(property);
          for (const token of tokensIn(value).filter((t) => !ring || !solid.includes(t))) {
            out.push(
              `${file}: ${rule.selectors.join(", ")} { ${property}: see-through --${token} }`,
            );
          }
          continue;
        }
        for (const token of tokensIn(value)) {
          const allowed =
            property === "color"
              ? [...TEXT, ...ON_FILL.filter(([, fill]) => own.includes(fill)).map(([text]) => text)]
              : isBackground(property)
                ? [...GROUNDS, ...FILLS, DIVIDER]
                : isMark(property)
                  ? [
                      ...MARKS,
                      DIVIDER,
                      ...own,
                      ...(halo && property === "box-shadow" ? GROUNDS : []),
                    ]
                  : // A ticked box's fill is the state, so it is a mark.
                    property === "accent-color"
                    ? MARKS
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
  it("sees the driver's stylesheets and a mark in them", () => {
    expect(Object.keys(sheets)).toEqual(
      expect.arrayContaining([
        "/src/capture/capture.css",
        "/src/shell/shell.css",
        "/src/auth/auth.css",
        "/src/ui/base.css",
        "/src/ui/DriverShell.css",
      ]),
    );
    const unmeasured = cssRules(sheets["/src/capture/capture.css"]).find((r) =>
      r.selectors.includes(".cap-pos--unmeasured"),
    );
    expect(unmeasured?.body).toContain("var(--unmeasured)");
  });

  it("puts each fill's own text on it, pressed fills included", () => {
    expect(fillPairs()).toEqual([]);
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

describe("the capture contrast check catches each planted case", () => {
  const planted = "/src/capture/planted.css";

  it.each([
    ["a dimmed rule", ".x { opacity: 0.6; }"],
    ["a dimmed rule in percent", ".x { opacity: 60%; }"],
    ["a filtered rule", ".x { filter: brightness(0.8); }"],
    ["a box ticked in the brand", ".x { accent-color: var(--brand); }"],
    ["a fill's text with no fill", ".x { color: var(--on-warn); }"],
    ["a mixed text colour", ".x { color: color-mix(in srgb, var(--ink) 50%, var(--surface)); }"],
    [
      "see-through text beside a solid mark",
      ".x { border-color: var(--ink); color: color-mix(in srgb, var(--ink) 60%, transparent); }",
    ],
    [
      "a see-through ring with no solid mark",
      ".x { box-shadow: 0 0 0 3px color-mix(in srgb, var(--interactive) 25%, transparent); }",
    ],
    [
      "a see-through ring whose token only text draws solid",
      ".x { color: var(--interactive); box-shadow: 0 0 0 3px color-mix(in srgb, var(--interactive) 25%, transparent); }",
    ],
    [
      "a see-through ring in a text colour",
      ".x { color: var(--ink-secondary); outline: 2px solid color-mix(in srgb, var(--ink-secondary) 50%, transparent); }",
    ],
  ])("%s", (_, css) => {
    expect(unchecked({ [planted]: css })).not.toEqual([]);
  });

  // The real sheets show a ring echoing a border; this is the fill half.
  it("lets a see-through ring echo its rule's own fill", () => {
    const css =
      ".x { background: var(--warn); color: var(--on-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 25%, transparent); }";
    expect(unchecked({ [planted]: css })).toEqual([]);
  });

  it.each([
    ["a fill with no text of its own", ".x { background: var(--warn); }"],
    ["a fill under another fill's text", ".x { background: var(--ok); color: var(--ink); }"],
    [
      "a pressed mix under its text's floor",
      ".k { background: var(--warn); color: var(--on-warn); }\n" +
        ".k:active { background: color-mix(in srgb, var(--warn) 80%, var(--on-warn)); }",
    ],
  ])("%s", (_, css) => {
    expect(fillPairs({ [planted]: css })).not.toEqual([]);
  });
});
