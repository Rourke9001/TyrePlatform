import { useEffect, type RefObject } from "react";

// WCAG 2.4.11: a bar stuck to an edge of the page covers whatever scrolls
// under it, at whatever height its content wraps to, so the page's scroll
// padding on that edge follows the bar's measured height. A control focus
// scrolls into view then stops clear of it. base.css pads the top by the
// --appbar figure until the first measure.
export function useScrollPadding(
  ref: RefObject<HTMLElement | null>,
  edge: "top" | "bottom",
  active = true,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || el === null || typeof ResizeObserver === "undefined") return;
    const html = document.documentElement;
    const property = `scroll-padding-${edge}`;
    const observer = new ResizeObserver(() => {
      const height = el.getBoundingClientRect().height;
      html.style.setProperty(property, `calc(${height}px + var(--space-2))`);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      html.style.removeProperty(property);
    };
  }, [ref, edge, active]);
}
