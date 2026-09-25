import { describe, expect, it } from "vitest";

import { contrastRatio, deriveBrandTheme } from "./derive";
import {
  cssVars,
  palette,
  provenanceColor,
  severityColor,
  statusColor,
  treadBandRamp,
  treadBandStep,
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
