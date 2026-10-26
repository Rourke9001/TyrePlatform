import { themeCss } from "./tokens";

const STYLE_ID = "tread-tokens";

// A style element, not an inline script: the CSP allows inline styles and
// refuses inline scripts (ADR-0019). main.tsx runs this before boot(), so
// ConfigFailure renders on the tokens too.
export function installThemeStyle(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = themeCss();
  doc.head.append(style);
}
