// Derives a full brand theme from the one colour a tenant picks (TYRE-27).
// The tenant controls hue; the system owns legibility: on-primary text and,
// where needed, the primary's own tone are computed so WCAG 2.1 AA contrast
// (NFR-USE-007) holds for any input a non-technical admin can enter.

import { palette } from "./tokens";

export interface BrandTheme {
  primary: string;
  primaryHover: string;
  primaryPressed: string;
  onPrimary: string;
}

// Text on brand uses the same white as the app's lightest neutral, so the
// only colours in play remain the tokens' own.
const WHITE = palette.surface;
const AA_NORMAL_TEXT = 4.5;

type Rgb = [number, number, number];

function parseHex(input: string): Rgb | null {
  const m = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i.exec(input.trim());
  if (!m) return null;
  const hex = m[1] ? [...m[1]].map((c) => c + c).join("") : m[2];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: Rgb): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// WCAG 2.1 relative luminance of sRGB.
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(parseHex(a) ?? [0, 0, 0]);
  const lb = luminance(parseHex(b) ?? [0, 0, 0]);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

const INK: Rgb = parseHex(palette.ink) as Rgb;
const WHITE_RGB: Rgb = parseHex(WHITE) as Rgb;

export function deriveBrandTheme(primaryInput: string): BrandTheme {
  let rgb = parseHex(primaryInput) ?? (parseHex(palette.brand) as Rgb);

  // A mid-tone primary clears at best ~4.15:1 against BOTH white and ink, so
  // picking a text colour is not enough: nudge the tone (hue untouched) away
  // from whichever text colour reads better until AA holds.
  for (let i = 0; i < 20; i++) {
    const cWhite = contrastRatio(toHex(rgb), WHITE);
    const cInk = contrastRatio(toHex(rgb), palette.ink);
    if (Math.max(cWhite, cInk) >= AA_NORMAL_TEXT) break;
    rgb = mix(rgb, cWhite >= cInk ? [0, 0, 0] : WHITE_RGB, 0.08);
  }

  const primary = toHex(rgb);
  const onPrimary =
    contrastRatio(primary, WHITE) >= contrastRatio(primary, palette.ink)
      ? WHITE
      : palette.ink;

  // Hover/pressed step toward ink; a near-black primary has no darker to go,
  // so its states step toward white instead — the shift stays visible.
  const towardsLight = luminance(rgb) < 0.03;
  const target = towardsLight ? WHITE_RGB : INK;
  const [hoverT, pressedT] = towardsLight ? [0.14, 0.26] : [0.12, 0.22];

  return {
    primary,
    primaryHover: toHex(mix(rgb, target, hoverT)),
    primaryPressed: toHex(mix(rgb, target, pressedT)),
    onPrimary,
  };
}
