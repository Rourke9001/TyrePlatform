import { useSyncExternalStore } from "react";

// TYRE-154, spec section 4 (U243): whether "My inspections" offers to put the
// app on the Home Screen. The decision is pure; the page's memory (Chrome's
// kept event, this page's dismissal) lives here so it outlives a remount.
export type InstallForm = "steps" | "button";

// "unknown" while the held read is out; a failed read counts as "some", so a
// dead store never shows the hint over work it could not see.
export type HeldState = "unknown" | "none" | "some";

export interface InstallDevice {
  standalone: boolean | undefined;
  maxTouchPoints: number;
  displayStandalone: boolean;
}

export interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
}

export interface OfferState {
  readonly prompt: InstallPromptEvent | null;
  readonly dismissedHere: boolean;
}

export const INSTALL_HINT_KEY = "tyre.install-hint";

// lib.dom's Navigator has no `standalone`, so the input is this narrow shape.
export interface DeviceSource {
  readonly navigator: { readonly maxTouchPoints: number; readonly standalone?: boolean };
  matchMedia(query: string): { readonly matches: boolean };
}

export function deviceOf(win: DeviceSource): InstallDevice {
  return {
    standalone: win.navigator.standalone,
    maxTouchPoints: win.navigator.maxTouchPoints,
    displayStandalone: win.matchMedia("(display-mode: standalone)").matches,
  };
}

// No user-agent parsing: iOS Safari is the browser that has `standalone` and
// touch points, which a Mac's Safari lacks (spec section 4).
export function installForm(
  device: InstallDevice,
  state: { prompt: boolean; dismissed: boolean; held: HeldState },
): InstallForm | null {
  if (device.standalone === true || device.displayStandalone) return null;
  if (state.dismissed || state.held !== "none") return null;
  // The event is the browser saying it can install now, so it wins.
  if (state.prompt) return "button";
  if (device.standalone !== undefined && device.maxTouchPoints > 1) return "steps";
  return null;
}

// A store that throws (a private window, blocked site data) reads as not
// dismissed, so the hint shows rather than hiding on a guess.
export function readHintDismissed(storage?: Storage): boolean {
  try {
    return (storage ?? window.localStorage).getItem(INSTALL_HINT_KEY) === "dismissed";
  } catch {
    return false;
  }
}

const CLEARED: OfferState = { prompt: null, dismissedHere: false };

// Replaced only on a change: useSyncExternalStore re-renders forever on a
// fresh object per read (storageFaults.ts).
let snapshot: OfferState = CLEARED;
let kept: InstallPromptEvent | null = null;
let prompted = false;
let dismissedHere = false;
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = { prompt: kept, dismissedHere };
  listeners.forEach((listen) => {
    listen();
  });
}

// Main starts this before the first render: Chrome can hand over its install
// prompt as soon as the page loads, on any route, and an uncancelled one
// raises its own banner (TYRE-154, U243).
export function startInstallOffer(win: Window = window): () => void {
  const onPrompt = (event: Event) => {
    event.preventDefault();
    if (prompted) return;
    kept = event as InstallPromptEvent;
    publish();
  };
  const onInstalled = () => {
    if (kept === null) return;
    kept = null;
    publish();
  };
  win.addEventListener("beforeinstallprompt", onPrompt);
  win.addEventListener("appinstalled", onInstalled);
  return () => {
    win.removeEventListener("beforeinstallprompt", onPrompt);
    win.removeEventListener("appinstalled", onInstalled);
    // No notify: a component still mounted at a test's teardown must not
    // re-render outside act().
    kept = null;
    prompted = false;
    dismissedHere = false;
    snapshot = { prompt: null, dismissedHere: false };
  };
}

export function readInstallOffer(): OfferState {
  return snapshot;
}

export function useInstallOffer(): OfferState {
  return useSyncExternalStore(
    (listen) => {
      listeners.add(listen);
      return () => listeners.delete(listen);
    },
    readInstallOffer,
    () => CLEARED,
  );
}

export function dismissInstallHint(storage?: Storage): void {
  dismissedHere = true;
  publish();
  try {
    (storage ?? window.localStorage).setItem(INSTALL_HINT_KEY, "dismissed");
  } catch {
    // An unwritable store costs only the next load its dismissal; this page
    // keeps it in memory.
  }
}

// prompt() runs inside the tap's user activation, and Chrome allows it once
// per event, so the event is spent whatever the driver chooses.
export function promptInstall(): void {
  const event = kept;
  if (event === null) return;
  try {
    event.prompt().catch(() => undefined);
  } catch {
    // A refused prompt is the browser's answer; the hint goes either way.
  }
  kept = null;
  prompted = true;
  publish();
}
