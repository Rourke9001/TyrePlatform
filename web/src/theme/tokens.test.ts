import { describe, expect, it } from "vitest";

import { contrastRatio, deriveBrandTheme } from "./derive";
import {
  PLATFORM_BRAND,
  brandVars,
  cssVars,
  palette,
  provenanceColor,
  severityColor,
  statusColor,
  themeCss,
  themes,
  treadBandRamp,
  treadBandStep,
  type ColorToken,
  type ThemeName,
} from "./tokens";

// dataviz's ordinal rule: one hue, monotone lightness, the light end still
// legible on the surface (2:1). The categorical validator fails a one-hue
// ramp by design; these two are the checks that apply (U46).
describe("the tread band ramp", () => {
  it("clears 2:1 at the light end and darkens at every step", () => {
    const ratios = treadBandRamp.map((hex) => contrastRatio(hex, palette.surface));
    expect(ratios[0]).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeGreaterThan(ratios[i - 1]);
    }
  });

  // tread_bands is tenant configuration (rule 5): the seeded five is one
  // case, not the shape. The ends are pinned so the darkest step always
  // means the deepest tread whatever the count. treadBandStep returns the
  // 1-based ramp step, not a hex: components read colour only through the
  // `--band-N` custom properties (TYRE-238 review).
  it("maps any band count onto the ramp with the ends pinned", () => {
    expect(treadBandStep(1, 5)).toBe(1);
    expect(treadBandStep(3, 5)).toBe(3);
    expect(treadBandStep(5, 5)).toBe(5);
    expect(treadBandStep(1, 3)).toBe(1);
    expect(treadBandStep(2, 3)).toBe(3);
    expect(treadBandStep(3, 3)).toBe(5);
    expect(treadBandStep(1, 1)).toBe(1);
    expect(treadBandStep(7, 7)).toBe(5);
    expect(treadBandStep(9, 7)).toBe(5);
  });
});

describe("cssVars", () => {
  it("exposes every semantic role as a custom property", () => {
    const vars = cssVars(deriveBrandTheme(palette.brand));
    expect(vars["--severity-info"]).toBe(severityColor.INFO);
    expect(vars["--severity-warning"]).toBe(severityColor.WARNING);
    expect(vars["--severity-critical"]).toBe(severityColor.CRITICAL);
    expect(vars["--provenance-actual"]).toBe(provenanceColor.actual);
    expect(vars["--provenance-estimated"]).toBe(provenanceColor.estimated);
    expect(vars["--provenance-audit"]).toBe(provenanceColor.audit);
    expect(vars["--provenance-unvalued"]).toBe(provenanceColor.unvalued);
    treadBandRamp.forEach((hex, i) => {
      expect(vars[`--band-${i + 1}`]).toBe(hex);
    });
    expect(vars["--text-hero"]).toBe("3rem");
    expect(vars["--space-7"]).toBe("48px");
    expect(vars["--target-min"]).toBe("2.75rem");
    // NFR-USE-004: the glove target for sign-in, as the capture keypad's.
    expect(vars["--target-glove"]).toBe("3.5rem");
    expect(vars["--radius-pill"]).toBe("999px");
    expect(vars["--elevation-overlay"]).toBeDefined();
    expect(vars).toHaveProperty("--interactive", palette.interactive);
  });
});

// U53 (TYRE-276): links, quiet buttons and focus rings use one fixed colour,
// so it is checked here once instead of per tenant. Text needs 4.5:1 and a
// focus indicator 3:1, so text is the binding floor on both surfaces the
// token is drawn on (a quiet button's hover and a highlighted option sit on
// the sunken one).
describe("the interactive colour", () => {
  it("clears 4.5:1 on the surface and on the sunken surface", () => {
    expect(contrastRatio(palette.interactive, palette.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.interactive, palette.surfaceSunken)).toBeGreaterThanOrEqual(4.5);
  });

  it("never follows the tenant's brand and never repeats an alarm hue", () => {
    for (const brand of ["#E2202A", "#c0361c", "#F2C744", "#7A2E8D", "#1F7A5A", palette.brand]) {
      expect(cssVars(deriveBrandTheme(brand))).toHaveProperty("--interactive", palette.interactive);
    }
    const alarms: string[] = [...Object.values(severityColor), ...Object.values(statusColor)];
    expect(alarms.map((hex) => hex.toLowerCase())).not.toContain(palette.interactive.toLowerCase());
  });
});

const THEME_NAMES: ThemeName[] = ["light", "dark"];

// Written out, not read from themes, so a name dropped from tokens.ts fails
// here instead of shrinking the list the test walks (TYRE-445).
const COLOUR_NAMES = [
  "canvas",
  "surface",
  "surface-muted",
  "surface-inverse",
  "ink",
  "ink-secondary",
  "ink-muted",
  "on-inverse",
  "line",
  "line-strong",
  "interactive",
  "interactive-hover",
  "interactive-soft",
  "on-interactive",
  "brand",
  "brand-hover",
  "brand-pressed",
  "on-brand",
  "ok",
  "on-ok",
  "ok-text",
  "warn",
  "on-warn",
  "warn-text",
  "critical",
  "on-critical",
  "critical-text",
  "critical-soft",
  "warn-soft",
  "info-soft",
  "unmeasured",
  "scrim",
  "viewer",
  "on-viewer",
  "data-1",
  "data-2",
  "data-3",
  "data-4",
  "data-5",
];

const BRAND_NAMES = ["brand", "brand-hover", "brand-pressed", "on-brand"];

// Each theme's declaration blocks, keyed by selector list.
function blocks(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of themeCss().matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.set(m[1].trim(), m[2]);
  return out;
}

function declares(block: string | undefined, name: string): boolean {
  return new RegExp(`(?:^|;)\\s*--${name}\\s*:`).test(block ?? "");
}

const LIGHT = ':root,[data-theme="light"]';
const DARK = ':root[data-theme="dark"],[data-theme="dark"]';

// NFR-USE-007 and NFR-USE-003: 7:1 for ink, 4.5:1 for other text, 3:1 for a
// control's border and the focus colour, in Daylight and in Night shift.
describe("Tread's colours", () => {
  it("every text pair clears its ratio in both themes", () => {
    const pairs: [ColorToken, ColorToken, number][] = [
      ["ink", "surface", 7],
      ["ink", "surface-muted", 7],
      ["ink", "canvas", 7],
      ["ink-secondary", "surface", 4.5],
      ["ink-secondary", "surface-muted", 4.5],
      ["ink-muted", "surface", 4.5],
      ["ink-muted", "surface-muted", 4.5],
      ["on-ok", "ok", 4.5],
      ["on-warn", "warn", 4.5],
      ["on-critical", "critical", 4.5],
      ["on-interactive", "interactive", 4.5],
      ["on-inverse", "surface-inverse", 4.5],
      ["ok-text", "surface", 4.5],
      ["warn-text", "surface", 4.5],
      ["critical-text", "surface", 4.5],
      ["line-strong", "surface", 3],
      ["interactive", "surface", 3],
    ];
    const short: string[] = [];
    for (const theme of THEME_NAMES) {
      for (const [fg, bg, min] of pairs) {
        const ratio = contrastRatio(themes[theme][fg], themes[theme][bg]);
        if (ratio < min)
          short.push(`${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}, needs ${min}`);
      }
    }
    expect(short).toEqual([]);
  });

  // The two ends of the status scale must part by lightness as well as hue,
  // for a reader who cannot tell red from green (NFR-USE-009).
  it("ok and critical fills differ by 3:1 in both themes", () => {
    for (const theme of THEME_NAMES) {
      expect(contrastRatio(themes[theme].ok, themes[theme].critical), theme).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  it("names exactly the 39 colours in each theme", () => {
    for (const theme of THEME_NAMES) {
      expect(Object.keys(themes[theme]).sort()).toEqual([...COLOUR_NAMES].sort());
    }
  });

  // The brand slot's defaults are the platform colour run through the same
  // rule ThemeProvider applies to a tenant's (TYRE-27).
  it("holds the platform brand's derivation in the brand slot", () => {
    const t = deriveBrandTheme(PLATFORM_BRAND);
    for (const theme of THEME_NAMES) {
      expect(themes[theme].brand).toBe(t.brand);
      expect(themes[theme]["brand-hover"]).toBe(t.brandHover);
      expect(themes[theme]["brand-pressed"]).toBe(t.brandPressed);
      expect(themes[theme]["on-brand"]).toBe(t.onBrand);
    }
  });
});

describe("themeCss", () => {
  it('emits a [data-theme="light"] block', () => {
    expect([...blocks().keys()]).toContain(LIGHT);
  });

  // The dark block leaves the brand slot alone, so a [data-theme="dark"]
  // subtree keeps the tenant brand ThemeProvider sets on the root (U53).
  it("themeCss declares each of the 39 names in the light block and every non-brand colour in the dark block", () => {
    const light = blocks().get(LIGHT);
    const dark = blocks().get(DARK);
    expect(COLOUR_NAMES.filter((name) => !declares(light, name))).toEqual([]);
    const nonBrand = COLOUR_NAMES.filter((name) => !BRAND_NAMES.includes(name));
    expect(nonBrand.filter((name) => !declares(dark, name))).toEqual([]);
    expect(BRAND_NAMES.filter((name) => declares(dark, name))).toEqual([]);
  });

  it("writes each colour's value for its theme", () => {
    const light = blocks().get(LIGHT) ?? "";
    const dark = blocks().get(DARK) ?? "";
    expect(light).toContain(`--ink:${themes.light.ink}`);
    expect(dark).toContain(`--ink:${themes.dark.ink}`);
    expect(dark).toContain(`--canvas:${themes.dark.canvas}`);
  });

  it("puts shadows in both blocks and the scale in the light block only", () => {
    const light = blocks().get(LIGHT);
    const dark = blocks().get(DARK);
    for (const name of ["shadow-raised", "shadow-overlay", "shadow-sheet"]) {
      expect(declares(light, name), name).toBe(true);
      expect(declares(dark, name), name).toBe(true);
    }
    for (const name of [
      "space-1",
      "space-5",
      "space-12",
      "radius-md",
      "radius-pill",
      "target-min",
      "target-glove",
      "target-key",
      "appbar",
      "sidebar",
      "measure",
      "font-sans",
      "font-mono",
      "type-body-size",
      "type-body-line",
      "type-body-weight",
      "type-readout-size",
      "tracking-eyebrow",
    ]) {
      expect(declares(light, name), name).toBe(true);
      expect(declares(dark, name), name).toBe(false);
    }
  });

  // NFR-USE-004's three targets, and the spacing step that moved: space-5
  // is 20px on Tread's scale.
  it("sets the targets and the spacing scale to Tread's values", () => {
    const light = blocks().get(LIGHT) ?? "";
    expect(light).toContain("--target-min:44px");
    expect(light).toContain("--target-glove:56px");
    expect(light).toContain("--target-key:64px");
    expect(light).toContain("--space-5:20px");
    expect(light).toContain("--space-12:48px");
  });
});

describe("brandVars", () => {
  it("brandVars returns exactly four properties", () => {
    const t = deriveBrandTheme("#c4271b");
    expect(brandVars(t)).toEqual({
      "--brand": t.brand,
      "--brand-hover": t.brandHover,
      "--brand-pressed": t.brandPressed,
      "--on-brand": t.onBrand,
    });
  });
});
