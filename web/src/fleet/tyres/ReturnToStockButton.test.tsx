import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ReturnToStockButton } from "./ReturnToStockButton";
import type { Tyre } from "../../api/tyres";
import { renderWithActor, requestedUrl, respond, sentBody } from "../../test/fixtures";

function tyre(overrides: Partial<Tyre> & { id: string }): Tyre {
  return {
    displayCode: "POS1",
    state: "REMOVED",
    status: "OK",
    retreadCount: 0,
    sizeName: "295/80R22.5",
    brandName: "Bridgestone",
    patternName: "R150",
    receivedDate: "2026-01-05",
    awaitingCost: false,
    receiptId: null,
    codePending: false,
    ...overrides,
  };
}

function renderButton(t: Tyre = tyre({ id: "t1" }), onSuccess?: () => void) {
  return renderWithActor(
    <ReturnToStockButton tyre={t} tenantKey="tenant-a" onSuccess={onSuccess} />,
  );
}

describe("returning a tyre to stock", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The decoder refuses no body at all, so the button must send {} rather
  // than nothing. The confirmation itself is a TyreList-level concern.
  it("posts an empty body and calls onSuccess", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    renderButton(tyre({ id: "t1" }), onSuccess);

    await user.click(screen.getByRole("button", { name: /return to stock/i }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls).toHaveLength(1));
    expect(requestedUrl(vi.mocked(fetch).mock.calls[0][0])).toBe("/api/tyres/t1/return");
    expect(sentBody(0)).toStrictEqual({});
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("renders the server's own refusal for a return it will not allow", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(422, { code: "TY012", message: "this tyre cannot return to stock from here" }),
    );
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole("button", { name: /return to stock/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /this tyre cannot return to stock from here/i,
    );
  });

  it("falls back to a generic message for a refusal with an unrecognised code", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(500, { code: "boom", message: "unrecognised" }));
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole("button", { name: /return to stock/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/unrecognised/i);
    expect(alert).toHaveTextContent(/could not be returned to stock/i);
  });
});

// FR-FIT-016 as amended (U253): today stays one click; an earlier day says
// why.
describe("returning a tyre to stock for an earlier day", () => {
  const WHY = "Why it is recorded late";

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers({ now: new Date("2026-11-25T10:00:00Z"), toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks why for an earlier day and sends the day with the reason", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    renderButton();

    expect(screen.queryByRole("textbox", { name: WHY })).toBeNull();
    fireEvent.change(screen.getByLabelText("Occurred on"), { target: { value: "2026-11-20" } });
    const why = screen.getByRole("textbox", { name: WHY });
    await user.type(why, "  ");
    await user.click(screen.getByRole("button", { name: /return to stock/i }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Say why this movement is recorded for an earlier day.",
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    await user.clear(why);
    await user.type(why, "yard book");
    await user.click(screen.getByRole("button", { name: /return to stock/i }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls).toHaveLength(1));
    expect(sentBody(0)).toStrictEqual({ occurredOn: "2026-11-20", backdateReason: "yard book" });
  });

  it("speaks the database's TY014 rather than the general sentence", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(422, {
        code: "TY014",
        message: "a movement is recorded on or before today, never on a future date",
      }),
    );
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole("button", { name: /return to stock/i }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "a movement is recorded on or before today, never on a future date",
    );
  });
});
