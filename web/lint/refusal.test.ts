// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE: string = path.dirname(fileURLToPath(import.meta.url));

// The registry's TypeScript-side half (ADR-0012, TYRE-153): every code a
// screen can render verbatim must be a key in
// api/internal/httpapi/refusal_codes.json, the file the Go and database
// sides check too. The registry and the screens are read as text, never
// imported: this runs in tsconfig.e2e.json's node program, which does not
// carry the vite/client types src/ needs.
const REGISTRY_PATH: string = path.join(
  HERE,
  "..",
  "..",
  "api",
  "internal",
  "httpapi",
  "refusal_codes.json",
);

function loadRegistry(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  const registry = parsed as Record<string, unknown>;
  delete registry._comment;
  return registry;
}

// Three forms a screen speaks a code in, covered by three patterns:
//   ALWAYS_SPEAKABLE = [ "a", "b" ]       (web/src/api/refusal.ts's own array)
//   speakable: [ "a", "b" ]               (a screen's RefusalWording)
//   something.code === "a" / lastCode === "a"   (a direct comparison)
// CODE_COMPARISON requires the identifier to be exactly `code` (as a
// property, `error.code`) or exactly `lastCode`, and excludes a `typeof x
// === "string"` guard, which shares the `.code` shape but names a JS type,
// not a wire code. Values are then filtered to TY-shape or lowercase snake
// case, which drops `w.code === "FR-INS-036"` (a capture-warning code, a
// different vocabulary entirely) without needing to know the receiver's
// type. A form not on this list (e.g. destructuring `const { code } = err`
// before comparing it) is not covered; nothing here can prove a negative.
const ALWAYS_SPEAKABLE_ARRAY = /ALWAYS_SPEAKABLE\s*=\s*\[([^\]]*)\]/;
const SPEAKABLE_ARRAY = /speakable:\s*\[([^\]]*)\]/g;
const QUOTED_STRING = /"([^"]*)"/g;
const CODE_COMPARISON = /(?<!typeof \w+)(?:\.code|\blastCode)\s*===\s*"([^"]+)"/g;
const CODE_SHAPE = /^(TY[0-9]+|[a-z][a-z_]*)$/;

function isScreenFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".tsx");
}

// Test fixtures speak a deliberately fake code (useFormMutation.test.tsx's
// TY999) to exercise the fallback path; a *.test.* file is not a screen, so
// it is excluded here exactly as it is from the sweep evidence this test
// closes out (TYRE-153). src/test/fixtures.ts is shared test scaffolding,
// not a screen either, and is excluded by name for the same reason.
function isTestFile(name: string): boolean {
  return name.includes(".test.");
}

function isSharedFixture(fullPath: string): boolean {
  return fullPath.replace(/\\/g, "/").endsWith("/test/fixtures.ts");
}

function collectScreenFiles(dir: string): string[] {
  let files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full: string = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(collectScreenFiles(full));
    } else if (isScreenFile(entry.name) && !isTestFile(entry.name) && !isSharedFixture(full)) {
      files.push(full);
    }
  }
  return files;
}

// Every code spoken across the whole web app, split so the test can sanity
// check that scanning found more than just the baseline every screen
// inherits (`always`).
function speakableCodesInSource(): { always: Set<string>; all: Set<string> } {
  const always = new Set<string>();
  const all = new Set<string>();
  const srcDir: string = path.join(HERE, "..", "src");
  for (const file of collectScreenFiles(srcDir)) {
    const text: string = readFileSync(file, "utf-8");

    const alwaysMatch = text.match(ALWAYS_SPEAKABLE_ARRAY);
    if (alwaysMatch) {
      for (const m of alwaysMatch[1].matchAll(QUOTED_STRING)) {
        always.add(m[1]);
        all.add(m[1]);
      }
    }
    for (const arrayMatch of text.matchAll(SPEAKABLE_ARRAY)) {
      for (const stringMatch of arrayMatch[1].matchAll(QUOTED_STRING)) {
        all.add(stringMatch[1]);
      }
    }
    for (const comparisonMatch of text.matchAll(CODE_COMPARISON)) {
      const value = comparisonMatch[1];
      if (CODE_SHAPE.test(value)) all.add(value);
    }
  }
  return { always, all };
}

const TY_SHAPE = /^TY[0-9]+$/;

// undefined when the entry is missing or carries no httpStatus key at all.
function httpStatusOf(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || !("httpStatus" in entry)) {
    return undefined;
  }
  return entry.httpStatus;
}

describe("the refusal-code registry names every code a screen speaks", () => {
  it("covers ALWAYS_SPEAKABLE, every screen's speakable array and every direct code comparison", () => {
    const registry = loadRegistry();
    const { always, all } = speakableCodesInSource();
    expect(always.size).toBeGreaterThan(0);
    expect(all.size).toBeGreaterThan(always.size);
    for (const code of all) {
      expect(
        registry,
        `refusal_codes.json does not name ${code}, which a screen treats as speakable`,
      ).toHaveProperty(code);
    }
  });

  // A screen that speaks a TY code no route can answer is wording nobody
  // will read (ADR-0012's null httpStatus, TYRE-303).
  it("records every TY code a screen speaks as reachable over HTTP", () => {
    const registry = loadRegistry();
    const spokenTY = [...speakableCodesInSource().all].filter((code) => TY_SHAPE.test(code));
    expect(spokenTY.length).toBeGreaterThan(0);
    for (const code of spokenTY) {
      expect(
        httpStatusOf(registry[code]),
        `refusal_codes.json records ${code} as unreachable (null httpStatus), but a screen speaks it`,
      ).toEqual(expect.any(Number));
    }
  });
});
