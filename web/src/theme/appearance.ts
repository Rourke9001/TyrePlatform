import { useSyncExternalStore } from "react";

import type { ThemeName } from "./tokens";

// Follow phone, Daylight or Night shift, per device. No settings screen
// before TYRE-449; the DevBar carries a dev-only switch.
export type Appearance = "system" | "light" | "dark";

export const APPEARANCE_KEY = "tyre.appearance";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function isAppearance(value: string | null): value is Appearance {
  return value === "system" || value === "light" || value === "dark";
}

// null only when the store throws (a private window, blocked site data):
// the caller then shows Daylight, the theme that renders before any read.
export function readAppearance(storage?: Storage): Appearance | null {
  try {
    const value = (storage ?? window.localStorage).getItem(APPEARANCE_KEY);
    return isAppearance(value) ? value : "system";
  } catch {
    return null;
  }
}

export function writeAppearance(appearance: Appearance, storage?: Storage): void {
  try {
    (storage ?? window.localStorage).setItem(APPEARANCE_KEY, appearance);
  } catch {
    // An unwritable store costs only the next load its choice; this
    // session already shows it.
  }
}

export function resolveTheme(appearance: Appearance | null, prefersDark: boolean): ThemeName {
  if (appearance === "system") return prefersDark ? "dark" : "light";
  return appearance ?? "light";
}

export function applyTheme(root: HTMLElement, theme: ThemeName): void {
  root.setAttribute("data-theme", theme);
}

// One preference per page. undefined until first read, so a hook that
// renders before startAppearance still shows the stored choice.
let current: Appearance | null | undefined;
let page: Window | null = null;
const listeners = new Set<() => void>();

function preference(): Appearance | null {
  if (current === undefined) current = readAppearance();
  return current;
}

function applyCurrent(): void {
  const win = page ?? window;
  const prefersDark = win.matchMedia(DARK_QUERY).matches;
  applyTheme(win.document.documentElement, resolveTheme(preference(), prefersDark));
}

function storageOf(win: Window): Storage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

// Reads the preference, applies it before the first render, and follows
// the OS live while it is "system". The boot path calls it, never an
// inline script, which the CSP refuses (ADR-0019).
export function startAppearance(win: Window = window): () => void {
  const storage = storageOf(win);
  current = storage ? readAppearance(storage) : null;
  page = win;
  const query = win.matchMedia(DARK_QUERY);
  const onChange = () => {
    applyCurrent();
  };
  applyCurrent();
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
    if (page === win) page = null;
  };
}

function setAppearance(appearance: Appearance): void {
  current = appearance;
  writeAppearance(appearance, storageOf(page ?? window) ?? undefined);
  applyCurrent();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A throwing store reads as Daylight, which is what the page shows.
function snapshot(): Appearance {
  return preference() ?? "light";
}

export function useAppearance(): [Appearance, (appearance: Appearance) => void] {
  return [useSyncExternalStore(subscribe, snapshot), setAppearance];
}
