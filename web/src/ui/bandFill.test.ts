import { describe, expect, it } from "vitest";

import { bandBlend, bandFallback, bandFill } from "./bandFill";

const ordinals = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("bandFill", () => {
  // U46: five bands or fewer keep the ramp's own steps, unchanged.
  it("gives five or fewer bands the ramp's stops", () => {
    expect(ordinals(5).map((k) => bandFill(k, 5))).toEqual([
      "var(--band-1)",
      "var(--band-2)",
      "var(--band-3)",
      "var(--band-4)",
      "var(--band-5)",
    ]);
    expect(ordinals(3).map((k) => bandFill(k, 3))).toEqual([
      "var(--band-1)",
      "var(--band-3)",
      "var(--band-5)",
    ]);
  });

  // U56 (TYRE-275): seven bands get seven fills, lightest first. The stops
  // darken monotonically (tokens.test.ts), and oklab mixing is linear in
  // lightness, so a strictly rising place along the ramp is a strictly
  // darkening fill.
  it("gives every band above five its own fill, in ramp order", () => {
    const fills = ordinals(7).map((k) => bandFill(k, 7));
    expect(new Set(fills).size).toBe(7);
    expect(fills[0]).toBe("var(--band-1)");
    expect(fills[1]).toBe("color-mix(in oklab, var(--band-1) 33.3%, var(--band-2))");
    expect(fills[3]).toBe("var(--band-3)");
    expect(fills[6]).toBe("var(--band-5)");
  });

  it("stays distinct and monotone at twelve bands", () => {
    const places = ordinals(12).map((k) => {
      const { lower, weight } = bandBlend(k, 12);
      return lower + weight;
    });
    places.slice(1).forEach((place, i) => {
      expect(place).toBeGreaterThan(places[i]);
    });
    expect(new Set(ordinals(12).map((k) => bandFill(k, 12))).size).toBe(12);
  });

  // Below color-mix's browser floor a bar inherits its group's fill: the
  // nearest stop, U46's step for the band, never black.
  it("falls back to the nearest stop for every band", () => {
    expect(ordinals(7).map((k) => bandFallback(k, 7))).toEqual([
      "var(--band-1)",
      "var(--band-2)",
      "var(--band-2)",
      "var(--band-3)",
      "var(--band-4)",
      "var(--band-4)",
      "var(--band-5)",
    ]);
  });
});
