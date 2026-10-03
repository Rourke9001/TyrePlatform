import { treadBandRamp, treadBandStep } from "../theme/tokens";

// Beside BandChart, not in tokens.ts: tokens.ts ships in the capture
// route's entry chunk, and this serves only the dashboard (U84).

const STOPS = treadBandRamp.length;

// Where band `ordinal` of `bandCount` sits along the ramp: between stop
// `lower` and stop `upper`, `weight` of the way to `upper` (U56).
export function bandBlend(
  ordinal: number,
  bandCount: number,
): { lower: number; upper: number; weight: number } {
  const place = ((ordinal - 1) * (STOPS - 1)) / Math.max(bandCount - 1, 1);
  const floor = Math.min(Math.max(Math.floor(place), 0), STOPS - 1);
  return { lower: floor + 1, upper: Math.min(floor + 2, STOPS), weight: place - floor };
}

// U46 for five bands or fewer; U56 above five, where each band blends the
// two stops either side of it so every configured band gets its own shade.
export function bandFill(ordinal: number, bandCount: number): string {
  if (bandCount <= STOPS) return `var(--band-${treadBandStep(ordinal, bandCount)})`;
  const { lower, upper, weight } = bandBlend(ordinal, bandCount);
  if (weight === 0 || lower === upper) return `var(--band-${lower})`;
  return `color-mix(in oklab, var(--band-${lower}) ${(100 * (1 - weight)).toFixed(1)}%, var(--band-${upper}))`;
}

// color-mix needs Safari 16.2 and the floor is 15.4. There, a blended fill
// is invalid at computed-value time and, fill being inherited, the bar takes
// its group's fill: this nearest stop (U56).
export function bandFallback(ordinal: number, bandCount: number): string {
  return `var(--band-${treadBandStep(ordinal, bandCount)})`;
}
