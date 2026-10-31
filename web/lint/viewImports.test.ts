// @vitest-environment node
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// ADR-0022: a screen's *.view.ts is a transform, so it imports domain/ and
// format/ only. The type-aware parser needs a file it can find, so each
// probe's text stands in for an existing view model's.
const eslint = new ESLint({ cwd: fileURLToPath(new URL("..", import.meta.url)) });
const VIEW = "src/dashboard/atRisk.view.ts";

async function restricted(code: string): Promise<number> {
  const results = await eslint.lintText(code, { filePath: VIEW });
  return results
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId === "@typescript-eslint/no-restricted-imports").length;
}

describe("a view model's import bans", { timeout: 60_000 }, () => {
  it("refuse React, a component, the theme, a fetcher, a query hook and Dexie", async () => {
    const probe = [
      'import { useState } from "react";',
      'import { Button } from "../ui/Button";',
      'import { themes } from "../theme/tokens";',
      'import { fetchDepots } from "../api/units";',
      'import * as data from "./dashboard.data";',
      'import Dexie from "dexie";',
      "export const all = [useState, Button, themes, fetchDepots, data, Dexie];",
      "",
    ].join("\n");
    expect(await restricted(probe)).toBe(6);
  });

  // Without this, a config that refused every import would pass.
  it("let it import domain/, format/ and wire and component types", async () => {
    const probe = [
      'import type { TyreAtRisk } from "../api/dashboard";',
      'import type { Band } from "../ui/BandChart";',
      'import { basisLabel } from "../domain/vocabulary";',
      'import { formatMm } from "../format/numbers";',
      "export type Row = [TyreAtRisk, Band];",
      "export const all = [basisLabel, formatMm];",
      "",
    ].join("\n");
    expect(await restricted(probe)).toBe(0);
  });
});
