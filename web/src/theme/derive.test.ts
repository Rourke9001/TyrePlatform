import { describe, expect, it } from "vitest";
import { contrastRatio, deriveBrandTheme } from "./derive";
import { palette } from "./tokens";

// WCAG 2.1 AA normal-text contrast (NFR-USE-007). The derivation must clear
// this for ANY tenant primary — a non-technical admin picks one colour and
// cannot be allowed to make the app illegible (TYRE-27).
const AA = 4.5;

describe("contrastRatio", () => {
  it("is 21:1 for black on white", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 1);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#14586E", "#FFFFFF")).toBeCloseTo(
      contrastRatio("#FFFFFF", "#14586E"),
      5,
    );
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
    expect(t.onPrimary).toBe(palette.ink);
    expect(contrastRatio(t.onPrimary, t.primary)).toBeGreaterThanOrEqual(AA);
  });

  it("adjusts a mid-tone primary until AA holds", () => {
    // #808080 clears at best ~4.15:1 against both white and ink, so the
    // derivation must move the tone, not just pick a text colour.
    const t = deriveBrandTheme("#808080");
    expect(t.primary).not.toBe("#808080");
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
});
