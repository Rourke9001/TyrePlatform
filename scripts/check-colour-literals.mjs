#!/usr/bin/env node
// TYRE-445, TYRE-27: a colour reaches a component only through the custom
// properties themeCss writes from web/src/theme/tokens.ts. This refuses a
// hex, rgb() or hsl() literal anywhere else in web/src.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g;
const ENTITY = /&#x?[0-9a-fA-F]+;/g;
const SCANNED = /\.(ts|tsx|css)$/;

// tokens.ts is the one home; fonts.css holds only the @font-face block.
// Tests pin literal values on purpose.
function exempt(rel) {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return (
    rel === "theme/tokens.ts" ||
    rel === "theme/fonts.css" ||
    rel.startsWith("test/") ||
    base.includes(".test.")
  );
}

// Comments are blanked, strings kept: a literal in a string is the case
// that matters. A string is tracked so a glob such as "./*.gallery.tsx"
// cannot open a comment that hides the code after it.
function code(text, css) {
  const out = [...text];
  let quote = null;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote || (c === "\n" && quote !== "`")) quote = null;
    } else if (c === '"' || c === "'" || (c === "`" && !css)) {
      quote = c;
    } else if (c === "/" && out[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? out.length : end + 2;
      for (; i < stop; i++) if (out[i] !== "\n") out[i] = " ";
      i--;
    } else if (!css && c === "/" && out[i + 1] === "/") {
      for (; i < out.length && out[i] !== "\n"; i++) out[i] = " ";
    }
  }
  return out.join("").replace(ENTITY, (m) => " ".repeat(m.length));
}

function scanFile(rel, text) {
  const found = [];
  code(text, rel.endsWith(".css"))
    .split("\n")
    .forEach((line, i) => {
      for (const m of line.matchAll(LITERAL))
        found.push(`${rel}:${i + 1}: ${m[0]}`);
    });
  return found;
}

function scanTree(src) {
  const found = [];
  let files = 0;
  for (const entry of readdirSync(src, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile() || !SCANNED.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const rel = relative(src, file).split("\\").join("/");
    if (exempt(rel)) continue;
    files += 1;
    found.push(...scanFile(rel, readFileSync(file, "utf8")));
  }
  return { files, found };
}

// A gate that finds nothing has to be shown able to find something (TYRE-49).
if (process.argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "colour-literals-"));
  const plant = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  try {
    plant("ui/clean.tsx", "export const a = 1;\n");
    plant(
      "ui/quiet.css",
      "/* #123456 and rgb( in a comment */\n.a { color: var(--ink); }\n",
    );
    plant(
      "ui/Quiet.tsx",
      [
        "// #abcdef in a line comment, hsl( too",
        "/* rgba( in a block */",
        'const ellipsis = "&#8230;";',
      ].join("\n"),
    );
    plant("theme/tokens.ts", 'export const ink = "#111417";\n');
    plant("theme/fonts.css", '@font-face { src: url("./a.woff2"); }\n');
    plant("ui/Box.test.tsx", 'const c = "#ffffff";\n');
    plant("test/fixtures.ts", 'const c = "rgb(0, 0, 0)";\n');
    if (scanTree(dir).found.length !== 0) {
      throw new Error(
        `a clean or exempt file was flagged: ${scanTree(dir).found.join("; ")}`,
      );
    }
    plant("ui/planted.css", ".a {\n  color: #123456;\n}\n");
    plant(
      "ui/Planted.tsx",
      [
        'const glob = "./*.gallery.tsx";',
        'const a = { color: "rgba(0, 0, 0, 0.5)" };',
        "const b = `hsl(${1}, 50%, 50%)`;",
        "// */",
      ].join("\n"),
    );
    const want = [
      "ui/planted.css:2: #123456",
      "ui/Planted.tsx:2: rgba(",
      "ui/Planted.tsx:3: hsl(",
    ];
    const got = scanTree(dir).found.sort();
    if (JSON.stringify(got) !== JSON.stringify(want.sort())) {
      throw new Error(
        `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
    }
  } catch (err) {
    console.error(`colour gate self-test: ${err.message}`);
    process.exit(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    "colour gate self-test: planted literals fire, comments, entities and exempt files stay quiet",
  );
  process.exit(0);
}

const { files, found } = scanTree(resolve(root, "web/src"));
if (found.length > 0) {
  for (const f of found) console.error(`web/src/${f}`);
  console.error(
    `${found.length} colour literal(s) outside web/src/theme/tokens.ts. Read the token's custom property instead (web/CLAUDE.md, TYRE-27).`,
  );
  process.exit(1);
}
console.log(`colour gate: ${files} files, no colour literal outside tokens.ts`);
