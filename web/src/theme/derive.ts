// Derives a full brand theme from the tenant's one colour (TYRE-27): the
// tenant controls hue, the system computes on-brand text and, where
// needed, tone so WCAG 2.1 AA (NFR-USE-007) holds for any input.

import { PLATFORM_BRAND, themes } from "./tokens";

export interface BrandTheme {
  brand: string;
  brandHover: string;
  brandPressed: string;
  onBrand: string;
}

// Text on brand is Daylight's ink or its white surface, so the only colours
// in play remain the tokens' own.
const INK_HEX = themes.light.ink;
const WHITE = themes.light.surface;
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
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// A theme token is ours, not a tenant's; an unparseable one fails at
// import rather than letting undefined reach a contrast calculation and
// derive a theme from NaN (TYRE-27, TYRE-49).
function requireHex(token: string): Rgb {
  const rgb = parseHex(token);
  if (!rgb) {
    throw new Error(`theme token is not a hex colour: ${token}`);
  }
  return rgb;
}

const INK: Rgb = requireHex(INK_HEX);
const WHITE_RGB: Rgb = requireHex(WHITE);

export function deriveBrandTheme(tenantColour: string): BrandTheme {
  let rgb = parseHex(tenantColour) ?? requireHex(PLATFORM_BRAND);

  // A mid-tone brand clears at best about 4.3:1 against BOTH white and
  // ink, so picking a text colour is not enough: nudge the tone (hue
  // untouched) away from whichever text colour reads better until AA holds.
  for (let i = 0; i < 20; i++) {
    const cWhite = contrastRatio(toHex(rgb), WHITE);
    const cInk = contrastRatio(toHex(rgb), INK_HEX);
    if (Math.max(cWhite, cInk) >= AA_NORMAL_TEXT) break;
    rgb = mix(rgb, cWhite >= cInk ? [0, 0, 0] : WHITE_RGB, 0.08);
  }

  const brand = toHex(rgb);
  const onBrand = contrastRatio(brand, WHITE) >= contrastRatio(brand, INK_HEX) ? WHITE : INK_HEX;

  // Hover/pressed step toward ink; a near-black brand has no darker to go,
  // so its states step toward white instead. The shift stays visible.
  const towardsLight = luminance(rgb) < 0.03;
  const target = towardsLight ? WHITE_RGB : INK;
  const [hoverT, pressedT] = towardsLight ? [0.14, 0.26] : [0.12, 0.22];

  return {
    brand,
    brandHover: toHex(mix(rgb, target, hoverT)),
    brandPressed: toHex(mix(rgb, target, pressedT)),
    onBrand,
  };
}
