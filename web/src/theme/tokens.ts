// The design system's single source of colour and type (TYRE-27), consumed
// only through the CSS custom properties below. "Yard signage" direction:
// sunlight-first (NFR-USE-003), brand confined to chrome.

import type { BrandTheme } from "./derive";

export const palette = {
  ink: "#16191d",
  inkMuted: "#5a6169",
  surface: "#ffffff",
  surfaceSunken: "#eff1f0",
  line: "#d8dcda",
  // "Convoy" petrol blue: the platform's own brand, used until a tenant
  // configures one (same default the API serves, TYRE-26).
  brand: "#14586e",
  // U53: links, quiet buttons and every focus ring use this fixed platform
  // colour, never the tenant's, so a red brand's link cannot read as
  // CRITICAL and a light brand cannot fall under 4.5:1 as text.
  interactive: "#14586e",
} as const;

// The capture app's per-reading status scale, keyed by state name and
// never themed by tenant branding; the mm thresholds that assign a state
// are tenant configuration (rule 5) and never appear here. Colour is never
// the only encoding (NFR-USE-009). The dashboard's tread bands use
// treadBandRamp below, keyed by ordinal, not this scale.
export const statusColor = {
  roadworthy: "#2e7d46",
  caution: "#e89b0c",
  "below-removal": "#c0361c",
  unmeasured: "#8a9096",
} as const;

export type TreadBandName = keyof typeof statusColor;

// The dashboard's severity scale (FR-EXC-006's vocabulary: INFO, WARNING,
// CRITICAL) reuses the two status steps the capture app already means by
// "caution" and "below removal", so one colour says one thing across both
// surfaces. A badge never uses these as text: caution clears 2.3:1 on
// white, so the badge tints its background and writes in ink, with a glyph
// and a label (NFR-USE-009).
export const severityColor = {
  INFO: "#3a6f8f",
  WARNING: statusColor.caution,
  CRITICAL: statusColor["below-removal"],
} as const;

export type Severity = keyof typeof severityColor;

// Provenance is certainty, so it is an ordinal ramp of the chart hue:
// actual darkest, audit and estimated lighter, unvalued the unmeasured
// grey with a hatch (ADR-0010, spec U27). The four keys are the two
// disjoint casing partitions' names; a split never receives a computed
// fifth.
export const provenanceColor = {
  actual: "#1f6a83",
  audit: "#3a819a",
  estimated: "#8fbccb",
  unvalued: statusColor.unmeasured,
} as const;

export type ProvenanceKey = keyof typeof provenanceColor;

// A tread band is a bucket, so its colour is ordinal: one hue, lightness
// falling with depth, keyed by band ordinal and never by band name (U46).
// The light end clears 2:1 on the surface and each step is darker than the
// last; tokens.test.ts pins both. Five steps, not "one per band": the
// tenant configures the band count (rule 5), and up to five bands get a
// distinct step; above five, BandChart blends between neighbouring steps
// (web/src/ui/bandFill.ts, U56).
export const treadBandRamp = ["#8fbccb", "#5fa0b6", "#3a819a", "#1f6a83", "#0f4457"] as const;

// Returns the 1-based ramp step (1 to 5), not a hex: colour reaches a
// component only through the `--band-N` custom properties cssVars emits
// below, never a literal (TYRE-238 review).
export function treadBandStep(ordinal: number, bandCount: number): number {
  const last = treadBandRamp.length - 1;
  const index = Math.round(((ordinal - 1) * last) / Math.max(bandCount - 1, 1));
  return Math.min(Math.max(index, 0), last) + 1;
}

// Self-hosted stacks; fonts.ts imports them and holds the rule-7 rationale.
export const font = {
  display: `"Archivo", "Arial Black", "Arial", sans-serif`,
  ui: `"Barlow", "Segoe UI", "Helvetica Neue", sans-serif`,
  condensed: `"Barlow Condensed", "Arial Narrow", sans-serif`,
  mono: `"IBM Plex Mono", "Consolas", "Menlo", monospace`,
} as const;

export const typeScale = {
  // The one figure a dashboard leads with: at least 48px, in the body sans
  // and not the display face (dataviz, hero figure). 3rem at a 16px root.
  hero: "3rem",
  display: "1.75rem",
  title: "1.1875rem",
  body: "0.9375rem",
  small: "0.8125rem",
  // Caps eyebrows are set small in Archivo with wide tracking; the tracking
  // lives with the size because one is illegible without the other.
  eyebrow: "0.6875rem",
  eyebrowTracking: "0.08em",
} as const;

export const radius = {
  control: "6px",
  card: "10px",
  pill: "999px",
} as const;

// A gloved thumb and a stacked-on-mobile header (NFR-USE-003/004) both need
// consistent gaps, not ad hoc rem values re-chosen at every call site.
export const space = {
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "24px",
  6: "32px",
  7: "48px",
} as const;

// The 44px floor for a manager's controls (NFR-USE-004); the capture keypad
// and tiles sit higher, at 56 to 64px, for gloves. `glove` is that 56px, for
// sign-in (NFR-USE-004).
export const target = { min: "2.75rem", glove: "3.5rem" } as const;

// Two shadows only: a card's lift off the sunken surface and an overlay's
// (dialog, popover) lift off everything. Ink at low alpha so a tenant's
// brand never tints a shadow.
export const elevation = {
  raised: "0 1px 2px rgba(22, 25, 29, 0.08)",
  overlay: "0 8px 24px rgba(22, 25, 29, 0.18)",
} as const;

// The one width below which a page changes form: a table stacks into cards
// and the band chart turns into rows (TYRE-238). @media cannot read a custom
// property, so a CSS rule writes 640px and cites this constant.
export const breakpoint = { phone: 640 } as const;

// Everything the runtime themes is written to the document root as custom
// properties; static CSS reads the same names. One surface, no divergence.
export function cssVars(brand: BrandTheme): Record<string, string> {
  return {
    "--ink": palette.ink,
    "--ink-muted": palette.inkMuted,
    "--surface": palette.surface,
    "--surface-sunken": palette.surfaceSunken,
    "--line": palette.line,
    "--interactive": palette.interactive,
    "--primary": brand.primary,
    "--primary-hover": brand.primaryHover,
    "--primary-pressed": brand.primaryPressed,
    "--on-primary": brand.onPrimary,
    "--status-roadworthy": statusColor.roadworthy,
    "--status-caution": statusColor.caution,
    "--status-below-removal": statusColor["below-removal"],
    "--status-unmeasured": statusColor.unmeasured,
    "--font-display": font.display,
    "--font-ui": font.ui,
    "--font-condensed": font.condensed,
    "--font-mono": font.mono,
    "--text-display": typeScale.display,
    "--text-title": typeScale.title,
    "--text-body": typeScale.body,
    "--text-small": typeScale.small,
    "--text-eyebrow": typeScale.eyebrow,
    "--text-hero": typeScale.hero,
    "--tracking-eyebrow": typeScale.eyebrowTracking,
    "--radius-control": radius.control,
    "--radius-card": radius.card,
    "--radius-pill": radius.pill,
    "--space-1": space[1],
    "--space-2": space[2],
    "--space-3": space[3],
    "--space-4": space[4],
    "--space-5": space[5],
    "--space-6": space[6],
    "--space-7": space[7],
    "--target-min": target.min,
    "--target-glove": target.glove,
    "--elevation-raised": elevation.raised,
    "--elevation-overlay": elevation.overlay,
    "--severity-info": severityColor.INFO,
    "--severity-warning": severityColor.WARNING,
    "--severity-critical": severityColor.CRITICAL,
    "--provenance-actual": provenanceColor.actual,
    "--provenance-audit": provenanceColor.audit,
    "--provenance-estimated": provenanceColor.estimated,
    "--provenance-unvalued": provenanceColor.unvalued,
    "--band-1": treadBandRamp[0],
    "--band-2": treadBandRamp[1],
    "--band-3": treadBandRamp[2],
    "--band-4": treadBandRamp[3],
    "--band-5": treadBandRamp[4],
  };
}

export function applyCssVars(el: HTMLElement, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) {
    el.style.setProperty(name, value);
  }
}

// ---------------------------------------------------------------- Tread

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
  interactive: ["#0a5bb0", "#73b2ff"],
  "interactive-hover": ["#084a8f", "#9cc8ff"],
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
  "critical-text": ["#b0231a", "#ff8a7e"],
  "critical-soft": ["#fbe5e2", "#3a1513"],
  "warn-soft": ["#fdf0d2", "#3a2c0c"],
  "info-soft": ["#e6ecf2", "#1c2834"],
  unmeasured: ["#8a9199", "#6d757d"],
  scrim: ["rgba(17, 20, 23, 0.45)", "rgba(0, 0, 0, 0.6)"],
  viewer: ["#0c0e10", "#0c0e10"],
  "on-viewer": ["#ffffff", "#ffffff"],
  "data-1": ["#c6d9e6", "#294254"],
  "data-2": ["#91b6cf", "#3b6481"],
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
const BRAND_SLOT: readonly ColorToken[] = ["brand", "brand-hover", "brand-pressed", "on-brand"];

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
// takes its own theme. The dark block sets no brand token, so a dark
// subtree keeps the tenant brand ThemeProvider writes on the root.
export function themeCss(): string {
  const light = [...colourVars("light", []), ...shadowVars("light"), ...scaleVars()];
  const dark = [...colourVars("dark", BRAND_SLOT), ...shadowVars("dark")];
  return (
    `:root,[data-theme="light"]{${declarations(light)}}` +
    `:root[data-theme="dark"],[data-theme="dark"]{${declarations(dark)}}`
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
