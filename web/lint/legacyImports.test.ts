// @vitest-environment node
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// TYRE-443: of the old kit only the Radix Select and its sheet are left,
// and nothing outside the DEV-only gallery imports anything else from
// src/ui/legacy/ (web/CLAUDE.md). Each probe stands in for an existing
// file's text, since the type-aware parser needs a file it can find.
const eslint = new ESLint({ cwd: fileURLToPath(new URL("..", import.meta.url)) });

async function restricted(filePath: string, code: string): Promise<number> {
  const results = await eslint.lintText(code, { filePath });
  return results
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId === "@typescript-eslint/no-restricted-imports").length;
}

const probe = (from: string) =>
  [
    `import { Panel } from "${from}/Panel";`,
    `import { Select } from "${from}/Select";`,
    `import "${from}/ui.css";`,
    "export const all = [Panel, Select];",
    "",
  ].join("\n");

describe("an import from the old kit", { timeout: 60_000 }, () => {
  it("is refused in src/ui/, but the Select and its sheet", async () => {
    expect(await restricted("src/ui/TyreTile.tsx", probe("./legacy"))).toBe(1);
    expect(await restricted("src/ui/icons/Check.tsx", probe("../legacy"))).toBe(1);
  });

  it("is refused in a manager folder, but the Select and its sheet", async () => {
    expect(await restricted("src/fleet/RetreadQueue.tsx", probe("../ui/legacy"))).toBe(1);
  });
});
