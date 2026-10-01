import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithActor } from "../test/fixtures";
import { CaptureFlow } from "./CaptureFlow";
import { clearDraft, db } from "./draft";

// credential() throws before any fetch without a stored session, so the
// bearer path is faked at the token store: the subject is the one thing each
// case varies.
const who = vi.hoisted(() => ({ subject: null as string | null }));
vi.mock("../api/token", async (original) => ({
  ...(await original<typeof import("../api/token")>()),
  bearerMode: () => true,
  stampSubject: () => who.subject,
  sender: () => Promise.resolve({ accessToken: "t", subject: who.subject }),
  refused: () => false,
}));

const unit = {
  vehicleId: "v1",
  fleetNumber: "BAC039SP",
  registration: "BAC039SP",
  unitKind: "HORSE",
  lastOdometerKm: null,
  lastOdometerAt: null,
  averageDailyKm: null,
  combination: null,
  positions: [],
  config: { treadGranularityMm: 1 },
};

beforeEach(async () => {
  await db.open();
  await clearDraft();
  who.subject = null;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearDraft();
});

describe("CaptureFlow in bearer mode", () => {
  it("offers a sign-in button when the vehicle load answers 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ code: "unauthorized", message: "x" }),
        }),
      ),
    );
    renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />);

    expect(await screen.findByText("Sign in to load this vehicle.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload vehicle" })).toHaveClass("cap-secondary");
  });

  it("offers a sign-in button beside the start refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(unit) })),
    );
    renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: /start inspection/i }));

    expect(await screen.findByText("Sign in before you start an inspection.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
