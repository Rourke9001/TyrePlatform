import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Panel } from "./Panel";

describe("Panel", () => {
  it("is a region named by its heading, with the clock beside it", () => {
    render(
      <Panel id="spares" title="Spares" judged="on the tenant's calendar day">
        <p>body</p>
      </Panel>,
    );
    const region = screen.getByRole("region", { name: "Spares" });
    expect(region).toContainElement(screen.getByText("body"));
    expect(screen.getByText("on the tenant's calendar day")).toBeInTheDocument();
  });
});
