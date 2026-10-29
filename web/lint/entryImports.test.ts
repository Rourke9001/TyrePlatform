// @vitest-environment node
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// TYRE-443: capture imports src/format/ statically, so a formatter that
// reached for a manager-only module would carry it into the entry. The
// type-aware parser needs a file it can find, so each probe's text stands in
// for an existing file's.
const eslint = new ESLint({ cwd: fileURLToPath(new URL("..", import.meta.url)) });

async function rules(filePath: string, code: string): Promise<(string | null)[]> {
  const results = await eslint.lintText(code, { filePath });
  return results.flatMap((r) => r.messages).map((m) => m.ruleId);
}

describe("the capture entry's import bans", { timeout: 60_000 }, () => {
  it("refuse the manager's vocabulary in src/format/", async () => {
    const probe = 'import * as vocab from "../domain/vocabulary";\nexport const v = vocab;\n';
    expect(await rules("src/format/numbers.ts", probe)).toContain(
      "@typescript-eslint/no-restricted-imports",
    );
  });

  // Without this, a config that refused every import would pass.
  it("let src/format/ import itself", async () => {
    const probe =
      'import { groupThousands } from "./groupThousands";\nexport const g = groupThousands;\n';
    expect(await rules("src/format/numbers.ts", probe)).not.toContain(
      "@typescript-eslint/no-restricted-imports",
    );
  });
});
