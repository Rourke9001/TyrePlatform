import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ReturnToStockButton } from "./ReturnToStockButton";
import type { Tyre } from "../../api/tyres";
import { requestedUrl, respond, sentBody, testQueryClient } from "../../test/fixtures";

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
    ...overrides,
  };
}

function renderButton(t: Tyre = tyre({ id: "t1" }), onSuccess?: () => void) {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <ReturnToStockButton tyre={t} tenantKey="tenant-a" onSuccess={onSuccess} />
    </QueryClientProvider>,
  );
}

describe("returning a tyre to stock", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The decoder refuses no body at all (an empty stream), so the button must
  // send a JSON body of {} rather than nothing. The confirmation itself is a
  // TyreList-level concern now (fix round 1 ruling — see TyreList.test.tsx);
  // this only proves the button calls back rather than swallowing the write.
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
