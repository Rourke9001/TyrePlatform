import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { UnitDetail } from "./UnitDetail";
import { ActorContext } from "../../auth/actorContext";
import {
  fitmentRow,
  me,
  openFitment,
  requestedUrl,
  respond,
  testQueryClient,
  unit,
  unitPosition,
} from "../../test/fixtures";

const UNIT = unit({
  id: "u9",
  fleetNumber: "HORSE-1",
  positions: [
    unitPosition({ id: "p1", code: "POS1" }),
    unitPosition({
      id: "p2",
      code: "POS2",
      side: "RIGHT",
      fitment: openFitment({ displayCode: "TY100" }),
    }),
  ],
});

function stubFetch() {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    if (url === "/api/vehicles/u9") return Promise.resolve(respond(200, UNIT));
    if (url === "/api/vehicles/u9/fitments")
      return Promise.resolve(respond(200, [fitmentRow({ fitmentId: "f1", displayCode: "TY100" })]));
    if (url.startsWith("/api/tyres")) return Promise.resolve(respond(200, { tyres: [] }));
    if (url.startsWith("/api/depots")) return Promise.resolve(respond(200, []));
    throw new Error(`unstubbed ${url}`);
  });
}

function renderScreen(capabilities: string[] = ["ViewFleet", "ManageAssets"]) {
  return render(
    <ActorContext.Provider value={{ actor: me({ capabilities }), settled: true }}>
      <QueryClientProvider client={testQueryClient()}>
        <UnitDetail unitId="u9" />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

describe("the unit screen", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the unit and draws its plan", async () => {
    renderScreen();
    expect(await screen.findByRole("heading", { name: "HORSE-1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Position POS2: TY100" })).toBeTruthy();
  });

  it("opens the picked position's panel", async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Position POS2: TY100" }));

    expect(await screen.findByRole("combobox", { name: "Reason" })).toBeTruthy();
  });

  // ViewFleet is the read (D7). Every write on this screen is ManageAssets',
  // and a reader is shown the unit rather than a row of controls that would
  // refuse them.
  it("shows a reader the plan and the history and none of the writes", async () => {
    renderScreen(["ViewFleet"]);
    await screen.findByRole("heading", { name: "HORSE-1" });

    expect(screen.getByRole("button", { name: "Position POS1: empty" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rotate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set status" })).toBeNull();
  });

  it("gives a controller the rotate, edit and status forms", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: "HORSE-1" });

    expect(screen.getByRole("button", { name: "Rotate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set status" })).toBeTruthy();
  });

  it("says the unit did not load rather than rendering an empty screen", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(500, {}));
    renderScreen();
    expect((await screen.findByRole("alert")).textContent).toContain("Unit didn't load");
  });
});
