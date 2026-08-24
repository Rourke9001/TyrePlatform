import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ActorContext } from "./actorContext";
import { RequireCapability } from "./RequireCapability";
import type { Me } from "./me";

const actor = (capabilities: string[]): Me => ({
  userId: "00000000-0000-0000-0000-000000000001",
  displayName: "Test",
  role: "CONTROLLER",
  capabilities,
  depots: [],
});

describe("RequireCapability", () => {
  it("renders its children when the actor holds the capability", () => {
    render(
      <ActorContext value={{ actor: actor(["ManageAssets"]), settled: true }}>
        <RequireCapability capability="ManageAssets">
          <p>asset tools</p>
        </RequireCapability>
      </ActorContext>,
    );
    expect(screen.getByText("asset tools")).toBeDefined();
  });

  // The server refuses regardless (NFR-SEC-006); hiding is a courtesy, so it
  // must be silent rather than an error the user has to read.
  it("renders nothing when the actor does not", () => {
    render(
      <ActorContext value={{ actor: actor(["CaptureInspection"]), settled: true }}>
        <RequireCapability capability="ManageAssets">
          <p>asset tools</p>
        </RequireCapability>
      </ActorContext>,
    );
    expect(screen.queryByText("asset tools")).toBeNull();
  });

  it("renders nothing while the actor is still unknown", () => {
    render(
      <ActorContext value={{ actor: null, settled: false }}>
        <RequireCapability capability="ManageAssets">
          <p>asset tools</p>
        </RequireCapability>
      </ActorContext>,
    );
    expect(screen.queryByText("asset tools")).toBeNull();
  });
});
