import { describe, expect, it } from "vitest";

import { cssRules } from "../test/cssRules";

// A lazy route's sheet stays loaded once its route has been visited, so two
// feature sheets that style one class name restyle each other's screens.
// Tread's own sheets in src/ui/ are shared on purpose and stay out.
const sheets = import.meta.glob<string>(["/src/**/*.css", "!/src/ui/**", "!/src/theme/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

function sharedClasses(): string[] {
  const owners = new Map<string, Set<string>>();
  for (const [file, css] of Object.entries(sheets)) {
    for (const rule of cssRules(css)) {
      for (const selector of rule.selectors) {
        const lead = /^\.([a-zA-Z][\w-]*)/.exec(selector.trim())?.[1];
        if (lead === undefined) continue;
        owners.set(lead, (owners.get(lead) ?? new Set()).add(file));
      }
    }
  }
  return [...owners]
    .filter(([, files]) => files.size > 1)
    .map(([name, files]) => `.${name}: ${[...files].sort().join(", ")}`);
}

describe("feature stylesheets", () => {
  // Without this, a glob that found nothing would pass.
  it("sees the feature sheets", () => {
    expect(Object.keys(sheets)).toEqual(
      expect.arrayContaining(["/src/dashboard/dashboard.css", "/src/fleet/unit/unit.css"]),
    );
  });

  it("never lead with a class another feature sheet styles", () => {
    expect(sharedClasses()).toEqual([]);
  });
});
