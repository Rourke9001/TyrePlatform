// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE: string = path.dirname(fileURLToPath(import.meta.url));

// The registry's TypeScript-side half (TYRE-153, ADR-0012): every code a
// screen can render verbatim must be a key in the one file the Go and
// database sides check against too (api/internal/httpapi/refusal_codes.json,
// TYRE-212). Read across the tier boundary by plain file path, not by
// import, so no build step couples the two trees and no TypeScript program
// has to type-check the other tree's dependency graph. This file lives
// under lint/, not src/api/, because tsconfig.e2e.json already carries the
// node types node:fs/node:path/node:url need and eslint's config block for
// lint/**/*.{js,ts} already turns off type-aware linting there (both exist
// for moneyStaysString.test.ts); giving web/tsconfig.json the same node
// types would apply program-wide, where Vite polyfills neither `process`
// nor `Buffer` for browser code (TYRE-184 review). For the same reason,
// ALWAYS_SPEAKABLE below is read as text, not imported: an import of
// src/api/refusal.ts pulls its whole dependency graph (down to
// src/api/devTenant.ts's import.meta.env) into tsconfig.e2e.json's program,
// which does not carry the vite/client types that call needs.
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
});
