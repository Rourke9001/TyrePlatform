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
// tenant configures the band count (rule 5), treadBandStep spreads them.
export const treadBandRamp = ["#8fbccb", "#5fa0b6", "#3a819a", "#1f6a83", "#0f4457"] as const;

export function treadBandStep(ordinal: number, bandCount: number): string {
  const last = treadBandRamp.length - 1;
  const index = Math.round(((ordinal - 1) * last) / Math.max(bandCount - 1, 1));
  return treadBandRamp[Math.min(Math.max(index, 0), last)];
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
// and tiles sit higher, at 56 to 64px, for gloves.
export const target = { min: "2.75rem" } as const;

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
