import { describe, expect, it } from "vitest";
import { contrastRatio, deriveBrandTheme } from "./derive";
import { palette, themes } from "./tokens";

// WCAG 2.1 AA normal-text contrast (NFR-USE-007). The derivation must clear
// this for ANY tenant primary. A non-technical admin picks one colour and
// cannot be allowed to make the app illegible (TYRE-27).
const AA = 4.5;

describe("contrastRatio", () => {
  it("is 21:1 for black on white", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 1);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#14586E", "#FFFFFF")).toBeCloseTo(contrastRatio("#FFFFFF", "#14586E"), 5);
  });
});

describe("deriveBrandTheme", () => {
  it("keeps the default brand and puts white on it", () => {
    const t = deriveBrandTheme(palette.brand);
    expect(t.primary).toBe(palette.brand);
    expect(t.onPrimary).toBe("#ffffff");
    expect(contrastRatio(t.onPrimary, t.primary)).toBeGreaterThanOrEqual(AA);
  });

  it("puts ink on a light primary", () => {
    const t = deriveBrandTheme("#F2C744");
    expect(t.onPrimary).toBe(themes.light.ink);
    expect(contrastRatio(t.onPrimary, t.primary)).toBeGreaterThanOrEqual(AA);
  });

  it("adjusts a mid-tone primary until AA holds", () => {
    // The mid-tone case deriveBrandTheme's loop comment documents: neither
    // text colour reaches AA, so the tone itself must move.
    expect(contrastRatio("#7a7a7a", themes.light.surface)).toBeLessThan(AA);
    expect(contrastRatio("#7a7a7a", themes.light.ink)).toBeLessThan(AA);
    const t = deriveBrandTheme("#7a7a7a");
    expect(t.primary).not.toBe("#7a7a7a");
    expect(contrastRatio(t.onPrimary, t.primary)).toBeGreaterThanOrEqual(AA);
  });

  it("darkens hover and pressed for a mid or light primary", () => {
    const t = deriveBrandTheme("#14586E");
    const lum = (hex: string) => contrastRatio(hex, "#000000");
    expect(t.primaryHover).not.toBe(t.primary);
    expect(t.primaryPressed).not.toBe(t.primaryHover);
    expect(lum(t.primaryHover)).toBeLessThan(lum(t.primary));
    expect(lum(t.primaryPressed)).toBeLessThan(lum(t.primaryHover));
  });

  it("lightens hover and pressed for a near-black primary", () => {
    const t = deriveBrandTheme("#0A0A0C");
    const lum = (hex: string) => contrastRatio(hex, "#000000");
    expect(t.onPrimary).toBe("#ffffff");
    expect(lum(t.primaryHover)).toBeGreaterThan(lum(t.primary));
    expect(lum(t.primaryPressed)).toBeGreaterThan(lum(t.primaryHover));
  });

  it("falls back to the default brand on malformed input", () => {
    for (const bad of ["", "red", "#GGGGGG", "#14586", "rgb(1,2,3)"]) {
      expect(deriveBrandTheme(bad)).toEqual(deriveBrandTheme(palette.brand));
    }
  });

  it("accepts shorthand and uppercase hex", () => {
    expect(deriveBrandTheme("#FA0").primary).toBe(deriveBrandTheme("#ffaa00").primary);
  });

  // The rule's outputs for a spread of tenant colours, so a change to the
  // tokens it reads shows here as a moved pin with a reason (TYRE-445).
  it("pins outputs for seven inputs", () => {
    const pins: [string, string, string, string, string][] = [
      // input, primary, hover, pressed, on-primary
      ["#14586e", "#14586e", "#145064", "#13495b", "#ffffff"],
      ["#c4271b", "#c4271b", "#af251b", "#9d231a", "#ffffff"],
      ["#f2ab00", "#f2ab00", "#d79903", "#c18a05", "#111417"],
      ["#000000", "#000000", "#242424", "#424242", "#ffffff"],
      ["#ffffff", "#ffffff", "#e2e3e3", "#cbcbcc", "#111417"],
      ["#7f7f7f", "#7f7f7f", "#727273", "#676768", "#111417"],
      ["not-a-colour", "#14586e", "#145064", "#13495b", "#ffffff"],
    ];
    for (const [input, ...expected] of pins) {
      const t = deriveBrandTheme(input);
      expect([t.primary, t.primaryHover, t.primaryPressed, t.onPrimary], input).toEqual(expected);
    }
  });

  // The brand fields carry the same derivation as the primary fields while
  // both names exist (TYRE-445).
  it("names the derivation for the brand slot too", () => {
    for (const input of ["#14586e", "#f2ab00", "#000000"]) {
      const t = deriveBrandTheme(input);
      expect([t.brand, t.brandHover, t.brandPressed, t.onBrand]).toEqual([
        t.primary,
        t.primaryHover,
        t.primaryPressed,
        t.onPrimary,
      ]);
    }
  });
});
