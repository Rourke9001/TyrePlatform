import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { TreadGlyph } from "../capture/TreadGlyph";
import { TreadReadings } from "../ui/TreadReadings";
import { expectNothingForbiddenSpoken } from "./spoken";

// The guard's two scopes (U147, TYRE-207 B10), swept over the real tread
// components, so the position check cannot lose its target unnoticed.
function sheet(header: string, naming: "numbered" | "named" = "numbered") {
  return render(
    <section>
      <p>{header}</p>
      <TreadGlyph side="RIGHT" count={3} />
      <TreadReadings
        readings={["9", "9", "9"]}
        governingIndex={null}
        onSelect={vi.fn()}
        naming={naming}
        side="right"
      />
    </section>,
  );
}

describe("expectNothingForbiddenSpoken", () => {
  it("lets the sheet header name a dual position", () => {
    const { container } = sheet("Position 3 · axle 1, right inner");
    expectNothingForbiddenSpoken(container, /tread reading 1 of 3/);
  });

  it("refuses a position word in a tread field label", () => {
    const { container } = sheet("Position 3 · axle 1, right", "named");
    expect(() => expectNothingForbiddenSpoken(container, /tread reading 1 of 3/)).toThrow(
      /not to contain '(inner|outer|centre)'/,
    );
  });

  it("refuses a compliance word anywhere on a driver screen", () => {
    const { container } = sheet("Position 3 · below the legal limit");
    expect(() => expectNothingForbiddenSpoken(container, /tread reading 1 of 3/)).toThrow(
      /not to contain 'legal'/,
    );
  });
});
