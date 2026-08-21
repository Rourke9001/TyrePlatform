// The design system's single source of colour and type (TYRE-27). Components
// consume these only through the CSS custom properties below — a hex or font
// literal anywhere else in web/src is a bug.
//
// "Yard signage" direction: sunlight-first light UI (NFR-USE-003), highway
// signage type, the tenant's brand confined to chrome.

import type { BrandTheme } from "./derive";

export const palette = {
  ink: "#16191d",
  inkMuted: "#5a6169",
  surface: "#ffffff",
  surfaceSunken: "#eff1f0",
  line: "#d8dcda",
  // "Convoy" petrol blue — the platform's own brand, used until a tenant
  // configures one (same default the API serves, TYRE-26).
  brand: "#14586e",
} as const;

// Tread band status colours are FIXED and keyed to band NAMES — tenant
// branding themes the chrome, never the safety language. The mm thresholds
// that put a reading in a band are tenant configuration (rule 5) and never
// appear in this codebase. Colour is never the only encoding (NFR-USE-009):
// components pair these with a label or shape.
export const statusColor = {
  roadworthy: "#2e7d46",
  caution: "#e89b0c",
  "below-removal": "#c0361c",
  unmeasured: "#8a9096",
} as const;

export type TreadBandName = keyof typeof statusColor;

// Self-hosted stacks; fonts.ts imports them and holds the rule-7 rationale.
export const font = {
  display: `"Archivo", "Arial Black", "Arial", sans-serif`,
  ui: `"Barlow", "Segoe UI", "Helvetica Neue", sans-serif`,
  condensed: `"Barlow Condensed", "Arial Narrow", sans-serif`,
  mono: `"IBM Plex Mono", "Consolas", "Menlo", monospace`,
} as const;

export const typeScale = {
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
} as const;

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
    "--tracking-eyebrow": typeScale.eyebrowTracking,
    "--radius-control": radius.control,
    "--radius-card": radius.card,
  };
}

export function applyCssVars(el: HTMLElement, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) {
    el.style.setProperty(name, value);
  }
}
