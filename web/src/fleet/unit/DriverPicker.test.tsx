import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { DriverPicker } from "./DriverPicker";
import type { Driver } from "../../api/trips";
import { requestedUrl, respond, testQueryClient } from "../../test/fixtures";

function driver(overrides: Partial<Driver> & { userId: string }): Driver {
  return { displayName: "Sandbox Driver", staffNumber: null, onTrip: null, ...overrides };
}

function renderPicker(onChange = vi.fn()) {
  render(
    <QueryClientProvider client={testQueryClient()}>
      <DriverPicker
        id="pick"
        label="Driver"
        value=""
        onChange={onChange}
        placeholder="Nobody yet"
      />
    </QueryClientProvider>,
  );
  return onChange;
}

describe("the driver picker", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists each driver after the placeholder, naming the truck of one on a trip", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [
        driver({ userId: "d1", displayName: "Melusi" }),
        driver({
          userId: "d2",
          displayName: "Sipho",
          onTrip: { vehicleId: "h1", fleetNumber: "HORSE" },
        }),
      ]),
    );
    renderPicker();

    await screen.findByRole("option", { name: "Sipho, on the trip with HORSE" });
    expect(requestedUrl(vi.mocked(fetch).mock.calls[0][0])).toBe("/api/drivers");
    const options = within(screen.getByLabelText("Driver"))
      .getAllByRole("option")
      .map((o) => [o.getAttribute("value"), o.textContent]);
    expect(options).toEqual([
      ["", "Nobody yet"],
      ["d1", "Melusi"],
      ["d2", "Sipho, on the trip with HORSE"],
    ]);
  });

  it("calls onChange with the chosen driver's id", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [driver({ userId: "d1" })]));
    const onChange = renderPicker();
    await screen.findByRole("option", { name: "Sandbox Driver" });

    await userEvent.selectOptions(screen.getByLabelText("Driver"), "d1");
    expect(onChange).toHaveBeenCalledWith("d1");
  });

  it("speaks a load failure with a Retry that reads the list again", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(500, { code: "boom", message: "down" }));
    renderPicker();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The driver list could not be loaded.",
    );
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [driver({ userId: "d1" })]));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("option", { name: "Sandbox Driver" });
  });
});
