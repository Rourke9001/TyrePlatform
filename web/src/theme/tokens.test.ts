import { describe, expect, it } from "vitest";

import { contrastRatio, deriveBrandTheme } from "./derive";
import {
  cssVars,
  palette,
  provenanceColor,
  severityColor,
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
  // means the deepest tread whatever the count.
  it("maps any band count onto the ramp with the ends pinned", () => {
    expect(treadBandStep(1, 5)).toBe(treadBandRamp[0]);
    expect(treadBandStep(3, 5)).toBe(treadBandRamp[2]);
    expect(treadBandStep(5, 5)).toBe(treadBandRamp[4]);
    expect(treadBandStep(1, 3)).toBe(treadBandRamp[0]);
    expect(treadBandStep(2, 3)).toBe(treadBandRamp[2]);
    expect(treadBandStep(3, 3)).toBe(treadBandRamp[4]);
    expect(treadBandStep(1, 1)).toBe(treadBandRamp[0]);
    expect(treadBandStep(7, 7)).toBe(treadBandRamp[4]);
    expect(treadBandStep(9, 7)).toBe(treadBandRamp[4]);
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
    expect(vars["--radius-pill"]).toBe("999px");
    expect(vars["--elevation-overlay"]).toBeDefined();
  });
});
