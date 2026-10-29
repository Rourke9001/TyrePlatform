import { useEffect, useEffectEvent, useInsertionEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]",
  "[contenteditable='true']",
].join(",");

function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getAttribute("tabindex") !== "-1" && el.closest("[hidden], [inert]") === null,
  );
}

// Every trap open now, innermost last. Only the innermost acts on a key or
// a stray focus, so a dialog opened over a sheet does not fight it for focus.
const open: HTMLElement[] = [];

// The Tread do-not-port row for Sheet and Dialog (docs/superpowers/specs/
// 2026-10-26-tread-frontend-design.md): while active, Tab cycles inside
// `ref`, Escape calls onEscape, and on release focus goes back to whatever
// held it when the trap opened (WCAG 2.4.3). The panel takes focus itself
// unless something inside took it first, so it needs tabIndex={-1}. Safari
// does not focus a button on click, so a caller that knows its opener passes
// it as returnTo.
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape: () => void,
  returnTo?: RefObject<HTMLElement | null>,
): void {
  const escape = useEffectEvent(onEscape);
  // Read through an effect event, so a returnTo built in render does not
  // reopen the trap on every render.
  const returnTarget = useEffectEvent(() => returnTo?.current ?? null);
  const opener = useRef<HTMLElement | null>(null);
  // Insertion effects run before React applies a child's autoFocus or any
  // child's mount effect, so the opener still holds focus here (TYRE-275
  // item 1). The passive effect below runs too late to see it.
  useInsertionEffect(() => {
    if (!active) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [active]);
  useEffect(() => {
    const root = ref.current;
    if (!active || root === null) return;
    let back = returnTarget() ?? opener.current;
    // One update can close a trap and open this one, taking the control
    // that held focus with it. The closing trap has put focus back on its
    // own opener by now, so that is where this one returns it too.
    if (back === null || back === document.body || !back.isConnected) {
      const now = document.activeElement;
      if (now instanceof HTMLElement && now !== document.body && !root.contains(now)) back = now;
    }
    open.push(root);
    if (!root.contains(document.activeElement)) root.focus();
    const innermost = () => open[open.length - 1] === root;

    // Every Tab is placed by hand, wrapping at both ends, so focus never
    // reaches the page behind the scrim.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!innermost()) return;
      if (event.key === "Escape") {
        // A control inside that used Escape itself, such as an open picker,
        // has already answered it.
        if (event.defaultPrevented) return;
        event.preventDefault();
        escape();
        return;
      }
      if (event.key !== "Tab") return;
      event.preventDefault();
      const stops = tabbable(root);
      if (stops.length === 0) {
        root.focus();
        return;
      }
      const n = stops.length;
      const at =
        document.activeElement instanceof HTMLElement ? stops.indexOf(document.activeElement) : -1;
      const step = event.shiftKey ? -1 : 1;
      // From the panel itself (at -1), Tab goes to the first stop and
      // Shift+Tab to the last. A stop in a disabled fieldset, a closed
      // details or a hidden box refuses focus, so the next one is tried.
      let next = at === -1 ? (event.shiftKey ? n - 1 : 0) : (at + step + n) % n;
      for (let tried = 0; tried < n; tried++) {
        stops[next].focus();
        if (document.activeElement === stops[next]) return;
        next = (next + step + n) % n;
      }
      root.focus();
    };
    // A screen reader's cursor or a script can still move focus out.
    const onFocusIn = (event: FocusEvent) => {
      if (innermost() && event.target instanceof Node && !root.contains(event.target)) {
        root.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      open.splice(open.indexOf(root), 1);
      if (back?.isConnected) back.focus();
    };
  }, [active, ref]);
}
