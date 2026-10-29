// The design system's single source of colour, type and size (TYRE-27,
// TYRE-445), consumed only through the CSS custom properties themeCss
// writes. Tread's values (ADR-0020): sunlight-first (NFR-USE-003), brand
// confined to chrome (U53).

import type { BrandTheme } from "./derive";

// The chart ramp's step count, --data-1 to --data-5. A tread band is a
// bucket, so its colour is ordinal and keyed by band ordinal, never by band
// name (U46). The tenant configures the band count (rule 5): up to five
// bands get a distinct step; above five, BandChart blends between
// neighbouring steps (web/src/ui/bandFill.ts, U56).
export const DATA_STEPS = 5;

// Returns the 1-based ramp step (1 to 5), not a hex: colour reaches a
// component only through the --data-N custom properties themeCss writes,
// never a literal (TYRE-238 review).
export function treadBandStep(ordinal: number, bandCount: number): number {
  const last = DATA_STEPS - 1;
  const index = Math.round(((ordinal - 1) * last) / Math.max(bandCount - 1, 1));
  return Math.min(Math.max(index, 0), last) + 1;
}

// The one width below which a page changes form: a table stacks into cards
// and the band chart turns into rows (TYRE-238). @media cannot read a custom
// property, so a CSS rule writes 640px and cites this constant.
export const breakpoint = { phone: 640 } as const;

export function applyCssVars(el: HTMLElement, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) {
    el.style.setProperty(name, value);
  }
}

export type ThemeName = "light" | "dark";

// The platform's own brand, used until a tenant configures one; the API
// serves the same default (TYRE-26).
export const PLATFORM_BRAND = "#14586e";

// Tread's colours, Daylight then Night shift (ADR-0020). U53: interactive
// is fixed and never a tenant's, so a red brand cannot read as a link or an
// alarm. The brand slot holds PLATFORM_BRAND's derivation (derive.ts);
// ThemeProvider overwrites it on the root with the tenant's.
const colour = {
  canvas: ["#eceeec", "#0c0e10"],
  surface: ["#ffffff", "#171a1d"],
  "surface-muted": ["#f4f5f4", "#1e2226"],
  "surface-inverse": ["#111417", "#f2f4f5"],
  ink: ["#111417", "#f2f4f5"],
  "ink-secondary": ["#3d444b", "#c4cacf"],
  "ink-muted": ["#5c646c", "#99a1a8"],
  "on-inverse": ["#ffffff", "#111417"],
  line: ["#dadedb", "#2b3035"],
  "line-strong": ["#7f878e", "#737b83"],
  // IR-UI-005 (U158): a driver's links clear 7:1 on every capture ground
  // (captureContrast.test.ts); the hover stays a step darker in Daylight.
  interactive: ["#084c93", "#8abfff"],
  "interactive-hover": ["#063a70", "#9cc8ff"],
  "interactive-soft": ["#e4eefa", "#15304f"],
  "on-interactive": ["#ffffff", "#08182c"],
  brand: [PLATFORM_BRAND, PLATFORM_BRAND],
  "brand-hover": ["#145064", "#145064"],
  "brand-pressed": ["#13495b", "#13495b"],
  "on-brand": ["#ffffff", "#ffffff"],
  ok: ["#d3eedc", "#173a27"],
  "on-ok": ["#0b4a2a", "#9fe6bb"],
  "ok-text": ["#16653c", "#7fd6a3"],
  warn: ["#f2ab00", "#f0b429"],
  "on-warn": ["#1d1400", "#1d1400"],
  "warn-text": ["#8a5300", "#ffc95c"],
  critical: ["#c4271b", "#ff6f61"],
  "on-critical": ["#ffffff", "#1f0604"],
  // IR-UI-005 (U157): off the artifact's values, in their hue, so capture's
  // text clears 7:1 and its unmeasured mark 4.5:1 on every capture ground
  // (captureContrast.test.ts).
  "critical-text": ["#941e16", "#ffa39a"],
  "critical-soft": ["#fbe5e2", "#3a1513"],
  "warn-soft": ["#fdf0d2", "#3a2c0c"],
  "info-soft": ["#e6ecf2", "#1c2834"],
  // IR-UI-005 (U157), as critical-text above.
  unmeasured: ["#64696f", "#91979d"],
  scrim: ["rgba(17, 20, 23, 0.45)", "rgba(0, 0, 0, 0.6)"],
  viewer: ["#0c0e10", "#0c0e10"],
  "on-viewer": ["#ffffff", "#ffffff"],
  // U46: off the artifact's value, in its hue, so the light end clears 2:1.
  "data-1": ["#9abbd3", "#314e64"],
  // U56: Daylight's step 2 is off the artifact's value, in its hue, so it
  // reads apart from step 1 (tokens.test.ts holds each step 1.2 apart).
  "data-2": ["#78a5c4", "#3b6481"],
  "data-3": ["#5d90b3", "#5a8db1"],
  "data-4": ["#356f96", "#85b3d4"],
  "data-5": ["#1b4c6d", "#bcd9ee"],
} as const satisfies Record<string, readonly [string, string]>;

export type ColorToken = keyof typeof colour;

function themeOf(index: 0 | 1): Record<ColorToken, string> {
  const out = {} as Record<ColorToken, string>;
  for (const name of Object.keys(colour) as ColorToken[]) out[name] = colour[name][index];
  return out;
}

export const themes: Record<ThemeName, Record<ColorToken, string>> = {
  light: themeOf(0),
  dark: themeOf(1),
};

// ThemeProvider sets these four on the root from the tenant's colour; every
// other token comes from the stylesheet themeCss writes (U53).
export const BRAND_SLOT: readonly ColorToken[] = [
  "brand",
  "brand-hover",
  "brand-pressed",
  "on-brand",
];

// Ink at low alpha, so a tenant's brand never tints a shadow.
export const shadow: Record<ThemeName, { raised: string; overlay: string; sheet: string }> = {
  light: {
    raised: "0 1px 2px rgba(17, 20, 23, 0.08), 0 0 0 1px rgba(17, 20, 23, 0.04)",
    overlay: "0 12px 32px rgba(17, 20, 23, 0.18)",
    sheet: "0 -8px 24px rgba(17, 20, 23, 0.14)",
  },
  dark: {
    raised: "0 1px 2px rgba(0, 0, 0, 0.5)",
    overlay: "0 12px 32px rgba(0, 0, 0, 0.6)",
    sheet: "0 -8px 24px rgba(0, 0, 0, 0.6)",
  },
};

// NFR-USE-004: 44px floors every control, 56px is every driver-route
// control for gloves, 64px the keypad.
export const tread = {
  space: {
    1: "4px",
    2: "8px",
    3: "12px",
    4: "16px",
    5: "20px",
    6: "24px",
    8: "32px",
    12: "48px",
  },
  radius: { sm: "4px", md: "8px", lg: "12px", xl: "20px", pill: "999px" },
  size: {
    "target-min": "44px",
    "target-glove": "56px",
    "target-key": "64px",
    appbar: "56px",
    sidebar: "248px",
    measure: "68ch",
  },
} as const;

export const treadFont = {
  sans: `"Atkinson Hyperlegible Next", "Segoe UI", system-ui, sans-serif`,
  mono: `"Atkinson Hyperlegible Mono", "Cascadia Mono", Consolas, monospace`,
} as const;

export type TypeStyle =
  | "hero"
  | "display"
  | "title-1"
  | "title-2"
  | "title-3"
  | "eyebrow"
  | "body-lg"
  | "body"
  | "body-strong"
  | "small"
  | "caption"
  | "readout"
  | "reading"
  | "data"
  | "code";

interface TypeSpec {
  size: string;
  line: string;
  weight: number;
  tracking?: string;
  family: keyof typeof treadFont;
}

// Drivers read body-lg and managers body; nothing goes below caption.
// Readings, registrations and codes are mono (TYRE-446).
export const treadType: Record<TypeStyle, TypeSpec> = {
  hero: { size: "56px", line: "60px", weight: 800, tracking: "-0.02em", family: "sans" },
  display: { size: "36px", line: "40px", weight: 800, tracking: "-0.015em", family: "sans" },
  "title-1": { size: "28px", line: "34px", weight: 700, tracking: "-0.01em", family: "sans" },
  "title-2": { size: "22px", line: "28px", weight: 700, family: "sans" },
  "title-3": { size: "18px", line: "24px", weight: 700, family: "sans" },
  eyebrow: { size: "12px", line: "16px", weight: 700, tracking: "0.08em", family: "sans" },
  "body-lg": { size: "18px", line: "26px", weight: 400, family: "sans" },
  body: { size: "16px", line: "24px", weight: 400, family: "sans" },
  "body-strong": { size: "16px", line: "24px", weight: 700, family: "sans" },
  small: { size: "14px", line: "20px", weight: 400, family: "sans" },
  caption: { size: "13px", line: "18px", weight: 500, family: "sans" },
  readout: { size: "44px", line: "48px", weight: 700, family: "mono" },
  reading: { size: "22px", line: "26px", weight: 700, family: "mono" },
  data: { size: "15px", line: "22px", weight: 400, family: "mono" },
  code: { size: "13px", line: "18px", weight: 400, family: "mono" },
};

function declarations(vars: [string, string][]): string {
  return vars.map(([name, value]) => `--${name}:${value}`).join(";");
}

function colourVars(theme: ThemeName, skip: readonly ColorToken[]): [string, string][] {
  return (Object.keys(colour) as ColorToken[])
    .filter((name) => !skip.includes(name))
    .map((name) => [name, themes[theme][name]]);
}

function shadowVars(theme: ThemeName): [string, string][] {
  const s = shadow[theme];
  return [
    ["shadow-raised", s.raised],
    ["shadow-overlay", s.overlay],
    ["shadow-sheet", s.sheet],
  ];
}

function scaleVars(): [string, string][] {
  const out: [string, string][] = [];
  for (const [step, value] of Object.entries(tread.space)) out.push([`space-${step}`, value]);
  for (const [name, value] of Object.entries(tread.radius)) out.push([`radius-${name}`, value]);
  for (const [name, value] of Object.entries(tread.size)) out.push([name, value]);
  out.push(["font-sans", treadFont.sans], ["font-mono", treadFont.mono]);
  for (const [style, spec] of Object.entries(treadType)) {
    out.push(
      [`type-${style}-size`, spec.size],
      [`type-${style}-line`, spec.line],
      [`type-${style}-weight`, String(spec.weight)],
    );
    if (spec.tracking) out.push([`tracking-${style}`, spec.tracking]);
  }
  return out;
}

// The one stylesheet the theme lives in, installed before boot
// (themeStyle.ts). Daylight is the root's default; a [data-theme] subtree
// takes its own theme. The brand slot's platform default sits on :root
// alone, so a themed subtree inherits the tenant brand ThemeProvider
// writes on the root (U53). Each theme block names its color-scheme, so
// native controls and scrollbars draw in that theme.
export function themeCss(): string {
  const brand = BRAND_SLOT.map((name): [string, string] => [name, themes.light[name]]);
  const light = [...colourVars("light", BRAND_SLOT), ...shadowVars("light"), ...scaleVars()];
  const dark = [...colourVars("dark", BRAND_SLOT), ...shadowVars("dark")];
  return (
    `:root{${declarations(brand)}}` +
    `:root,[data-theme="light"]{color-scheme:light;${declarations(light)}}` +
    `:root[data-theme="dark"],[data-theme="dark"]{color-scheme:dark;${declarations(dark)}}`
  );
}

export function brandVars(theme: BrandTheme): Record<string, string> {
  return {
    "--brand": theme.brand,
    "--brand-hover": theme.brandHover,
    "--brand-pressed": theme.brandPressed,
    "--on-brand": theme.onBrand,
  };
}
