import { useEffect, useEffectEvent, type RefObject } from "react";

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
// held it when the trap opened (WCAG 2.4.3). The panel takes focus itself,
// so it needs tabIndex={-1}. Safari does not focus a button on click, so a
// caller that knows its opener passes it as returnTo.
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape: () => void,
  returnTo?: RefObject<HTMLElement | null>,
): void {
  const escape = useEffectEvent(onEscape);
  useEffect(() => {
    const root = ref.current;
    if (!active || root === null) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const back = returnTo?.current ?? focused;
    open.push(root);
    root.focus();
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
      const at =
        document.activeElement instanceof HTMLElement ? stops.indexOf(document.activeElement) : -1;
      // From the panel itself (at -1), Tab goes to the first stop and
      // Shift+Tab to the last.
      const back = at <= 0 ? stops.length - 1 : at - 1;
      stops[event.shiftKey ? back : (at + 1) % stops.length].focus();
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
  }, [active, ref, returnTo]);
}
