// A stylesheet's rules read from its source, for the tests that hold a
// property across every sheet. jsdom applies no stylesheet, so they read
// the text.

export interface CssRule {
  selectors: string[];
  body: string;
}

export interface CssDeclaration {
  property: string;
  value: string;
}

// A selector list splits on top-level commas only: `:not(a, b)` is one.
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim().replace(/\s+/g, " ")).filter((s) => s !== "");
}

// Every block is its own rule, so a rule inside @media or @supports, or
// nested in another rule, is read with the declarations it holds; a parent
// keeps only its own (TYRE-343).
export function cssRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  const open: { selector: string; body: string }[] = [];
  let buf = "";
  for (const ch of text) {
    if (ch === "{") {
      const cut = buf.lastIndexOf(";") + 1;
      if (open.length > 0) open[open.length - 1].body += buf.slice(0, cut);
      open.push({ selector: buf.slice(cut), body: "" });
      buf = "";
    } else if (ch === "}") {
      const block = open.pop();
      if (block) out.push({ selectors: splitSelectors(block.selector), body: block.body + buf });
      buf = "";
    } else {
      buf += ch;
    }
  }
  return out;
}

export function declarations(body: string): CssDeclaration[] {
  return [...body.matchAll(/([-\w]+)\s*:\s*([^;]*)/g)].map((m) => ({
    property: m[1],
    value: m[2].trim(),
  }));
}
