import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ALWAYS_SPEAKABLE } from "./refusal";

const HERE: string = path.dirname(fileURLToPath(import.meta.url));

// The registry's TypeScript-side half (TYRE-153, ADR-0012): every code a
// screen can render verbatim must be a key in the one file the Go and
// database sides check against too (api/internal/httpapi/refusal_codes.json,
// TYRE-212). Read across the tier boundary by plain file path, not by
// import, so no build step and no tsconfig change couples the two trees.
const REGISTRY_PATH: string = path.join(
  HERE,
  "..",
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

// speakable: [ "a", "b" ] across one or more lines, capturing the bracketed
// list. Source files declare theirs as a literal array of string constants
// (no interpolation, no spread), so this pattern reads every one without
// needing a TypeScript parser.
const SPEAKABLE_ARRAY = /speakable:\s*\[([^\]]*)\]/g;
const QUOTED_STRING = /"([^"]*)"/g;

function isScreenFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".tsx");
}

// Test fixtures speak a deliberately fake code (useFormMutation.test.tsx's
// TY999) to exercise the fallback path; a *.test.* file is not a screen, so
// it is excluded here exactly as it is from the sweep evidence this test
// closes out (TYRE-153).
function isTestFile(name: string): boolean {
  return name.includes(".test.");
}

function collectScreenFiles(dir: string): string[] {
  let files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full: string = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(collectScreenFiles(full));
    } else if (isScreenFile(entry.name) && !isTestFile(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

// Every code a screen's own `speakable` array names, across the whole web
// app. web/src/api/refusal.ts holds ALWAYS_SPEAKABLE centrally; the
// per-screen arrays do not, by design (RefusalWording's own comment), so this
// is the one place that reads all of them.
function speakableCodesInSource(): Set<string> {
  const codes = new Set<string>(ALWAYS_SPEAKABLE);
  const srcDir: string = path.join(HERE, "..");
  for (const file of collectScreenFiles(srcDir)) {
    const text: string = readFileSync(file, "utf-8");
    for (const arrayMatch of text.matchAll(SPEAKABLE_ARRAY)) {
      for (const stringMatch of arrayMatch[1].matchAll(QUOTED_STRING)) {
        codes.add(stringMatch[1]);
      }
    }
  }
  return codes;
}

describe("the refusal-code registry names every code a screen speaks", () => {
  it("covers ALWAYS_SPEAKABLE and every screen's own speakable array", () => {
    const registry = loadRegistry();
    const spoken = speakableCodesInSource();
    expect(spoken.size).toBeGreaterThan(ALWAYS_SPEAKABLE.length);
    for (const code of spoken) {
      expect(
        registry,
        `refusal_codes.json does not name ${code}, which a screen treats as speakable`,
      ).toHaveProperty(code);
    }
  });
});
